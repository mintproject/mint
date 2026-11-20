"""What a gather task may fetch, and how it fetches it.

The gather task (``gather_piece.py``) copies the files bound to a flow input that
takes a collection into one folder in the runner's storage. This module holds the
decisions it makes, so they can be tested without a network.

Standard library only, and no import from the rest of the app: the source of this
file is embedded, as it is, in the code of the task. It is also used when a flow
is planned, to refuse a link early. Do not put ``from __future__`` here.

The rules, in one place:

* A link is ``https://host/...`` (port 443 only) or ``tapis://system/path``. No
  user name or password, no fragment, no control characters.
* An ``https`` host is resolved here and refused unless every address it resolves
  to is a public unicast address. The connection is then made to an address that
  was checked, with the name kept for the certificate check and the Host header,
  so a second DNS answer cannot lead somewhere else.
* Redirects are followed by hand, at most five, ``https`` only, each target
  checked again. No credential is ever sent to an ``https`` resource: nothing in
  this module takes one.
"""
import http.client
import ipaddress
import re
import socket
import ssl
import time
import urllib.parse

HTTPS_PORT = 443
MAX_NAME = 200
MAX_REDIRECTS = 5
FETCH_TRIES = 3
CHUNK = 65536
USER_AGENT = "dynamo-gather/1"

_BAD_CHARS = re.compile(r"[\x00-\x20\x7f-\x9f\\]")
_SYSTEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_REDIRECTS = (301, 302, 303, 307, 308)


class GatherError(Exception):
    """A failure that ends the task, with the code the adapter reports."""

    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class Transient(Exception):
    """A failure worth trying again: a 5xx, 408 or 429, or a network error."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.message = message
        self.status = status


# --- links --------------------------------------------------------------------

def check_url(url):
    """Where a link points, or ValueError naming what is wrong with it.

    Returns ``{"scheme": "https", "host", "target"}`` (``target`` is the path and
    query to request) or ``{"scheme": "tapis", "system", "path"}``. The reasons
    never repeat the link, so a signed link's query cannot reach a log.
    """
    if not isinstance(url, str) or not url:
        raise ValueError("the link is empty")
    if len(url) > 2000:
        raise ValueError("the link is longer than 2000 characters")
    if _BAD_CHARS.search(url):
        raise ValueError("the link has a space, backslash or control character")
    if "#" in url:
        raise ValueError("the link has a fragment (#)")
    start = url[:8].lower()
    if start == "https://":
        return _check_https(url)
    if start == "tapis://":
        return _check_tapis(url[8:])
    if url[:7].lower() == "http://":
        raise ValueError("http links are refused; use https")
    raise ValueError("a link is https://... or tapis://system/path")


def _check_https(url):
    parts = urllib.parse.urlsplit(url)
    if not parts.netloc:
        raise ValueError("the link has no host")
    if "@" in parts.netloc:
        raise ValueError("a link may not carry a user name or password")
    try:
        port = parts.port
    except ValueError:
        raise ValueError("the link's port is not a number")
    if port not in (None, HTTPS_PORT):
        raise ValueError("only port 443 is allowed")
    host = parts.hostname
    if not host:
        raise ValueError("the link has no host")
    if ":" in host:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            raise ValueError("the link's host is not a valid address")
    elif not _HOST.match(host):
        raise ValueError("the link's host is not a plain ASCII host name")
    target = (parts.path or "/") + ("?" + parts.query if parts.query else "")
    return {"scheme": "https", "host": host, "target": target}


def _check_tapis(rest):
    system, _, path = rest.partition("/")
    if not _SYSTEM.match(system):
        raise ValueError("the Tapis system name is not valid")
    if not path:
        raise ValueError("the Tapis location has no path")
    if "?" in path:
        raise ValueError("a Tapis location has no query")
    for segment in path.split("/"):
        decoded = urllib.parse.unquote(segment)
        if segment == "" or decoded in (".", "..") or "/" in decoded or "\x00" in decoded:
            raise ValueError("a Tapis path names a file, with no empty, '.' or '..' segment")
    return {"scheme": "tapis", "system": system, "path": path}


# --- addresses ----------------------------------------------------------------

_NEVER = tuple(ipaddress.ip_network(n) for n in (
    "::/96", "64:ff9b:1::/48", "100::/64", "fec0::/10", "2001:db8::/32"))


def is_public_address(text):
    """True only for a public unicast address.

    An IPv4 address carried inside an IPv6 one (mapped, 6to4, Teredo, NAT64) is
    judged as the IPv4 address it carries.
    """
    try:
        ip = ipaddress.ip_address(str(text).split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6:
        carried = []
        if ip.ipv4_mapped is not None:
            carried.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            carried.append(ip.sixtofour)
        if ip.teredo is not None:
            carried.extend(ip.teredo)
        if ip in ipaddress.ip_network("64:ff9b::/96"):
            carried.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if any(not is_public_address(str(v4)) for v4 in carried):
            return False
        if any(ip in net for net in _NEVER):
            return False
    return bool(ip.is_global) and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified)


def resolve_public(host):
    """The addresses of ``host``, every one of them public, in the order given.

    Raises GatherError (GATHER_ADDRESS_REFUSED) when any address is not public:
    a name that answers with one private address among public ones is refused,
    not filtered.
    """
    try:
        infos = socket.getaddrinfo(host, HTTPS_PORT, type=socket.SOCK_STREAM)
    except OSError:
        raise Transient("the host name could not be resolved")
    addresses = []
    for info in infos:
        address = str(info[4][0]).split("%", 1)[0]
        if not is_public_address(address):
            raise GatherError("GATHER_ADDRESS_REFUSED", "the host resolves to an address that is not public")
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise Transient("the host name has no address")
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection that dials a given address, not the name.

    The name still decides the certificate that is accepted (verification stays
    on), the SNI sent, and the Host header.
    """

    def __init__(self, host, address, timeout=30):
        super().__init__(host, HTTPS_PORT, timeout=timeout, context=ssl.create_default_context())
        self._pinned_address = address

    def connect(self):
        sock = socket.create_connection((self._pinned_address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def check_status(status):
    """Nothing for a 200; otherwise the exception that says what to do about it."""
    if status == 200:
        return
    if status in (401, 403):
        raise GatherError("GATHER_RESOURCE_NEEDS_LOGIN", "the resource needs a login", http_status=status)
    if status in (408, 429) or status >= 500:
        raise Transient("the server answered HTTP %d" % status, status)
    raise GatherError("GATHER_RESOURCE_FAILED", "the server answered HTTP %d" % status, http_status=status)


def open_https(url, timeout):
    """GET an ``https`` link, following redirects by hand.

    Returns ``(connection, response)`` for a 200; the caller reads the body and
    closes both. Every hop is checked as a first link is, and resolved to public
    addresses only; the connection goes to one of those addresses.
    """
    for _ in range(MAX_REDIRECTS + 1):
        try:
            place = check_url(url)
        except ValueError as error:
            raise GatherError("GATHER_RESOURCE_FAILED", "a redirect was refused: %s" % error)
        if place["scheme"] != "https":
            raise GatherError("GATHER_RESOURCE_FAILED", "a redirect led away from https")
        failure = None
        for address in resolve_public(place["host"]):
            connection = PinnedHTTPSConnection(place["host"], address, timeout)
            try:
                connection.request("GET", place["target"], headers={
                    "User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "identity"})
                response = connection.getresponse()
                break
            except ssl.SSLCertVerificationError:
                connection.close()
                raise GatherError("GATHER_RESOURCE_FAILED", "the server's certificate was not accepted")
            except (OSError, http.client.HTTPException) as error:
                connection.close()
                failure = error
        else:
            raise Transient("could not connect (%s)" % type(failure).__name__)
        if response.status in _REDIRECTS:
            location = response.getheader("Location")
            response.close()
            connection.close()
            if not location:
                raise GatherError("GATHER_RESOURCE_FAILED", "the server redirected with no address")
            url = urllib.parse.urldefrag(urllib.parse.urljoin(url, location))[0]
            continue
        try:
            check_status(response.status)
        except BaseException:
            response.close()
            connection.close()
            raise
        return connection, response
    raise GatherError("GATHER_RESOURCE_FAILED", "too many redirects")


# --- size ---------------------------------------------------------------------

class Budget:
    """The bytes a collection may add up to."""

    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def take(self, count):
        self.used += count
        if self.used > self.limit:
            raise GatherError("GATHER_TOO_LARGE", "the collection is larger than %d bytes" % self.limit,
                              limit_bytes=self.limit)


def copy_stream(response, out, budget, deadline=None):
    """Write a body to ``out`` in chunks, counting what is actually received (never
    a declared length). Returns the bytes written.

    ``deadline`` is a ``time.monotonic()`` value: a server that keeps a transfer
    alive a byte at a time is given up on when it passes. A body shorter than the
    length the server declared is taken as broken off, to be tried again.
    """
    declared = response.getheader("Content-Length") if hasattr(response, "getheader") else None
    written = 0
    while True:
        if deadline is not None and time.monotonic() > deadline:
            raise GatherError("GATHER_RESOURCE_FAILED", "the file took too long to arrive")
        chunk = response.read(CHUNK)
        if not chunk:
            if declared is not None and declared.isdigit() and written < int(declared):
                raise Transient("the transfer ended before the whole file arrived")
            return written
        budget.take(len(chunk))
        out.write(chunk)
        written += len(chunk)


# --- file names ---------------------------------------------------------------

def _clean(text):
    cleaned = _UNSAFE_NAME.sub("_", text).lstrip(".")
    if len(cleaned) > MAX_NAME:
        stem, dot, extension = cleaned.rpartition(".")
        if dot and len(extension) <= 20 and stem:
            cleaned = stem[:MAX_NAME - len(extension) - 1] + "." + extension
        else:
            cleaned = cleaned[:MAX_NAME]
    return cleaned if cleaned.strip(".") else ""


def choose_name(declared, url, index):
    """The file name for a resource: its own name if that is a plain base name,
    else the last path segment of its link, else ``resource-<index>``."""
    if isinstance(declared, str) and declared and "/" not in declared and "\\" not in declared:
        name = _clean(declared.strip())
        if name:
            return name
    try:
        place = check_url(url)
    except ValueError:
        place = None
    if place:
        path = place["target"].split("?", 1)[0] if place["scheme"] == "https" else place["path"]
        name = _clean(urllib.parse.unquote(path.rstrip("/").rsplit("/", 1)[-1]))
        if name:
            return name
    return "resource-%d" % index


def unique_name(name, taken):
    """``name``, or ``name-2``, ``name-3`` ... before the extension, whichever is not
    in ``taken`` (compared without regard to case). The result is added to it."""
    candidate, number = name, 1
    while candidate.lower() in taken:
        number += 1
        stem, dot, extension = name.rpartition(".")
        suffix = "-%d" % number
        if dot and stem:
            candidate = stem[:MAX_NAME - len(suffix) - len(extension) - 1] + suffix + "." + extension
        else:
            candidate = name[:MAX_NAME - len(suffix)] + suffix
    taken.add(candidate.lower())
    return candidate
