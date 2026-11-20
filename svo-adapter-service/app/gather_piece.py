"""The code of the task that gathers a collection input.

A flow input can take a collection: several files bound to one input. The flow's
pieces read one folder in Tapis storage, so before the steps that read such an
input the pipeline gets a task of its own. It copies every file into one new
folder in the runner's storage, ``<staging folder>/inputs/<gather id>/``, and
hands that folder on as the step's input.

The task is a hosted function, written by the adapter and not by a piece's author.
Its code is ``gather_fetch.py`` (embedded as it is, so what is tested is what runs)
followed by the script below. The plan reaches it as one JSON string, never as
interpolated source. Nothing is pip-installed.

Credentials: the Tapis token goes only to the Tapis address, to read a ``tapis://``
resource and to write the staged files. It is never part of a request for an
``https`` resource, on any host or any redirect.
"""
from __future__ import annotations

import inspect
import json
from typing import Any

from . import gather_fetch

# One gathering may take long: a thousand files, five gigabytes. The task's own
# limit, not the adapter's, ends a stuck one.
GATHER_MAX_EXEC_SECONDS = 6 * 3600

_SCRIPT = r'''
import hashlib, json, os, tempfile, time
from owe_python_sdk.runtime import execution_context as _ctx

_SPEC = json.loads(__SPEC__)
_READ_TIMEOUT = 120


def _in(name):
    value = _ctx.get_input(name)
    return "" if value is None else str(value)


def _die(code, message, **details):
    print(json.dumps({"status": "error", "code": code, "message": message, **details}))
    raise SystemExit(1)


def _gather():
    base = urllib.parse.urlsplit(_in("TAPIS_BASE_URL").rstrip("/"))
    token = _in("TAPIS_TOKEN")
    if base.scheme != "https" or not base.hostname or base.username or base.password or not token:
        _die("GATHER_STAGING_FAILED", "the step was given no https Tapis address or no token")
    if base.hostname.lower() != _SPEC["tapis_host"] or base.port not in (None, HTTPS_PORT):
        # The token goes to the address the adapter is set up with and no other.
        _die("GATHER_STAGING_FAILED", "the step was given a Tapis address that is not this service's")
    try:
        staging = check_url(_in("STAGING_URI"))
    except ValueError:
        staging = {}
    if staging.get("scheme") != "tapis":
        _die("GATHER_STAGING_FAILED", "the run's staging folder was not given as tapis://system/path")
    system = staging["system"]
    folder = staging["path"].rstrip("/") + "/inputs/" + _SPEC["gather_id"]
    # An edited file's address comes in as a task input, not in the plan.
    resources = [{"name": "", "url": _in("EDIT_URL")}] if _SPEC.get("url_input") else _SPEC["resources"]

    def tapis(method, path, body=None, headers=None, timeout=_READ_TIMEOUT):
        # The only requests the token is sent with, and only to the Tapis host.
        connection = http.client.HTTPSConnection(
            base.hostname, base.port or HTTPS_PORT, timeout=timeout, context=ssl.create_default_context())
        sent = {"X-Tapis-Token": token, "Accept": "application/json", **(headers or {})}
        connection.request(method, base.path.rstrip("/") + path, body=body, headers=sent)
        return connection, connection.getresponse()

    def quoted(text, safe="/"):
        return urllib.parse.quote(text, safe=safe)

    def staging_failed(message, **details):
        _die("GATHER_STAGING_FAILED", message, **details)

    # The folder first. The upload also creates missing parents, so a refusal here
    # that is not about the token is not fatal; the upload decides.
    try:
        connection, response = tapis(
            "POST", "/v3/files/ops/" + quoted(system, ""), json.dumps({"path": "/" + folder}).encode(),
            {"Content-Type": "application/json"})
        status = response.status
        response.read()
        connection.close()
    except (OSError, http.client.HTTPException):
        status = None
    if status in (401, 403):
        staging_failed("Tapis refused to make the staging folder", http_status=status)

    def download(index, resource, out, budget):
        try:
            place = check_url(resource["url"])
        except ValueError as error:
            raise GatherError("GATHER_RESOURCE_FAILED", "the link is not allowed: %s" % error)
        if place["scheme"] == "https":
            connection, response = open_https(
                resource["url"], _READ_TIMEOUT, token, _SPEC.get("catalog_host") or None)
        elif place["system"] not in _SPEC["tapis_systems"]:
            raise GatherError("GATHER_RESOURCE_FAILED", "a collection may not read from this Tapis system")
        else:
            try:
                connection, response = tapis(
                    "GET", "/v3/files/content/%s/%s" % (quoted(place["system"], ""), quoted(place["path"])),
                    headers={"Accept": "*/*"})
            except (OSError, http.client.HTTPException) as error:
                raise Transient("Tapis could not be reached (%s)" % type(error).__name__)
        try:
            check_status(response.status)
            return copy_stream(response, out, budget, time.monotonic() + _SPEC["resource_seconds"])
        except (OSError, http.client.HTTPException) as error:
            raise Transient("the transfer broke off (%s)" % type(error).__name__)
        finally:
            response.close()
            connection.close()

    def upload(name, spill, size):
        boundary = "gather" + os.urandom(12).hex()
        head = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n" % (boundary, name)).encode()
        tail = ("\r\n--%s--\r\n" % boundary).encode()

        class Body:
            """The multipart body, read in chunks: head, the file, tail."""

            def __init__(self):
                spill.seek(0)
                self.stage = 0

            def read(self, count=CHUNK):
                if self.stage == 0:
                    self.stage = 1
                    return head
                if self.stage == 1:
                    data = spill.read(count)
                    if data:
                        return data
                    self.stage = 2
                if self.stage == 2:
                    self.stage = 3
                    return tail
                return b""

        path = "/v3/files/ops/%s/%s" % (quoted(system, ""), quoted(folder + "/" + name))
        headers = {"Content-Type": "multipart/form-data; boundary=" + boundary,
                   "Content-Length": str(len(head) + size + len(tail))}
        for attempt in range(2):
            try:
                connection, response = tapis("POST", path, Body(), headers)
            except (OSError, http.client.HTTPException):
                # No answer came back: the file may or may not have arrived. Writing
                # it again replaces it, so one more try is safe, and only one.
                if attempt == 0:
                    continue
                staging_failed("could not reach Tapis to store a file")
            status = response.status
            response.read()
            connection.close()
            if status >= 400:
                staging_failed("Tapis refused to store a file", http_status=status)
            return

    names, taken = [], set()
    for index, resource in enumerate(resources):
        names.append(unique_name(choose_name(resource.get("name"), resource.get("url"), index), taken))

    budget = Budget(int(_SPEC["max_bytes"]))
    for index, resource in enumerate(resources):
        try:
            place = check_url(resource["url"])
            host = place.get("host") or "tapis://" + place["system"]
        except ValueError:
            host = "an address that is not allowed"
        before = budget.used
        spill = None
        for attempt in range(FETCH_TRIES):
            spill = tempfile.TemporaryFile()
            budget.used = before
            try:
                size = download(index, resource, spill, budget)
                break
            except Transient as error:
                spill.close()
                spill = None
                last = error
                if attempt + 1 < FETCH_TRIES:
                    time.sleep(2 ** attempt)
            except GatherError as error:
                spill.close()
                _die(error.code, "resource %d at %s: %s" % (index, host, error.message),
                     index=index, host=host, **error.details)
        if spill is None:
            _die("GATHER_RESOURCE_FAILED", "resource %d at %s: %s" % (index, host, last.message),
                 index=index, host=host, http_status=last.status)
        if _SPEC.get("check"):
            # An edited file is read once more here, before it is stored, so that a
            # file the pieces would refuse stops the run at its first step.
            spill.seek(0)
            try:
                check_edit(_SPEC["check"], spill.read(), names[index])
            except ValueError as error:
                spill.close()
                _die("GATHER_FILE_INVALID", "%s cannot be used: %s" % (names[index], error), index=index)
        digest = hashlib.sha256()
        spill.seek(0)
        for block in iter(lambda: spill.read(CHUNK), b""):
            digest.update(block)
        sha256 = digest.hexdigest()
        try:
            upload(names[index], spill, size)
        finally:
            spill.close()
        print(json.dumps({"status": "gathered", "index": index, "name": names[index], "bytes": size}))

    # A collection's result is its folder; one file given to an ordinary input is the file.
    result = "tapis://%s/%s" % (system, folder + ("/" + names[0] if _SPEC.get("single") else ""))
    _ctx.set_output("result", result)
    reported = {"result": result}
    if _SPEC.get("merge_key"):
        # A step that was handed a summary of what earlier steps wrote gets it back
        # with the edited file's place put where the original file's was.
        try:
            carried = json.loads(_in("CARRIED"))
        except ValueError:
            carried = None
        if not isinstance(carried, dict):
            _die("GATHER_RESOURCE_FAILED", "the value to carry on was not a JSON object")
        carried[_SPEC["merge_key"]] = result
        reported["carried"] = json.dumps(carried, sort_keys=True)
        _ctx.set_output("carried", reported["carried"])
    if _SPEC.get("single"):
        # What was fetched, for the run's record of an edit.
        reported["sha256"] = sha256
        reported["bytes"] = size
    # Tapis Workflows does not report a task's named outputs: print them, last, for
    # the adapter to read back from the task's stdout.
    print(json.dumps({"status": "ok", "svo_flow_outputs": reported}))


try:
    _gather()
except SystemExit:
    raise
except BaseException as _error:
    # Only the kind of error: what Python says about one can hold a link.
    _die("GATHER_RESOURCE_FAILED", "the task stopped unexpectedly (%s)" % type(_error).__name__)
'''


def gather_code(spec: dict[str, Any]) -> str:
    """The function task's code for one collection. ``spec`` is plain data
    (``gather_id``, ``label``, ``resources``, ``max_bytes``); it reaches the code
    as one JSON string."""
    return inspect.getsource(gather_fetch) + _SCRIPT.replace("__SPEC__", repr(json.dumps(spec, sort_keys=True)))
