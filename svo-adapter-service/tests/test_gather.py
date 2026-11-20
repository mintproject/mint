"""The task that gathers a flow input made of many files, and the rules it follows.

The task's real code is run here against a stand-in network: ``socket.getaddrinfo``
answers from a table, and ``http.client.HTTPSConnection`` is a recorder, so what the
task sends, to which address and with which headers, can be read back.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import types
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app import gather_fetch  # noqa: E402
from app.gather_piece import gather_code  # noqa: E402

TOKEN = "tok-SECRET-123"
TAPIS = "tapis.example"
STAGING = "tapis://ls6/scratch/u/dynamo-runs/run-1"
FOLDER = "scratch/u/dynamo-runs/run-1/inputs/gather-1"
PUBLIC = "93.184.216.34"
INPUTS = {"TAPIS_BASE_URL": "https://" + TAPIS, "TAPIS_TOKEN": TOKEN, "STAGING_URI": STAGING}


class Call:
    def __init__(self, kind, host, address, method, path, headers, body):
        self.kind, self.host, self.address = kind, host, address
        self.method, self.path, self.headers, self.body = method, path, headers, body


class Reply:
    def __init__(self, status=200, body=b"", headers=None, chunks=None):
        self.status = status
        self._chunks = list(chunks) if chunks is not None else ([body] if body else [])
        self._headers = headers or {}
        self.reads = 0

    def read(self, count=None):
        if count is None:  # read everything
            data, self._chunks = b"".join(self._chunks), []
            return data
        if not self._chunks:
            return b""
        self.reads += 1
        return self._chunks.pop(0)

    def getheader(self, name, default=None):
        return self._headers.get(name, default)

    def close(self):
        pass


class Network:
    """Records every request and answers from ``routes``: (host, path) -> Reply or a
    list of Replies (one per call)."""

    def __init__(self, routes=None, dns=None):
        self.calls: list[Call] = []
        self.routes = routes or {}
        self.dns = dns or {}
        self.resolved: list[str] = []

    def answer(self, call):
        if call.host == TAPIS:
            if call.method == "POST" and call.path == "/v3/files/ops/ls6":
                return Reply(200, b"{}")
            if call.method == "POST":
                return Reply(200, b"{}")
        key = (call.host, call.path)
        reply = self.routes.get(key)
        if isinstance(reply, list):
            reply = reply.pop(0) if len(reply) > 1 else reply[0]
        if reply is None:
            raise AssertionError("unexpected request %s %s" % key)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def getaddrinfo(self, host, port, type=0, **kwargs):
        self.resolved.append(host)
        return [(2, 1, 6, "", (address, port)) for address in self.dns.get(host, [PUBLIC])]


def install(monkeypatch, network: Network, inputs=INPUTS):
    import http.client

    class Fake:
        def __init__(self, host, port=None, timeout=None, context=None, **kwargs):
            self.host, self.port, self.timeout = host, port, timeout
            self.last = None

        def request(self, method, path, body=None, headers=None):
            if hasattr(body, "read"):
                data = b""
                while True:
                    piece = body.read(7)  # small reads: the body may not be sent in one piece
                    if not piece:
                        break
                    data += piece
            else:
                data = body
            self.last = Call(type(self).__name__, self.host, getattr(self, "_pinned_address", None),
                             method, path, dict(headers or {}), data)
            network.calls.append(self.last)

        def getresponse(self):
            return network.answer(self.last)

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Fake)
    monkeypatch.setattr("socket.getaddrinfo", network.getaddrinfo)
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    outputs: dict[str, str] = {}
    context = types.SimpleNamespace(get_input=lambda name: inputs.get(name),
                                    set_output=lambda name, value: outputs.__setitem__(name, value))
    runtime = types.ModuleType("owe_python_sdk.runtime")
    runtime.execution_context = context
    monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
    monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)
    return outputs


def spec(resources, **over):
    return {"gather_id": "gather-1", "label": "Documents", "resources": resources, "max_bytes": 10 ** 6,
            "tapis_host": TAPIS, "tapis_systems": ["corral", "sys"], "resource_seconds": 600, **over}


def run(monkeypatch, network, resources, inputs=INPUTS, **over):
    outputs = install(monkeypatch, network, inputs)
    exec(compile(gather_code(spec(resources, **over)), "<gather>", "exec"), {"__name__": "__gather__"})
    return outputs


def last_line(capsys):
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def https_calls(network):
    return [call for call in network.calls if call.host != TAPIS]


def uploads(network):
    """name -> file content, read out of each multipart upload."""
    found = {}
    for call in network.calls:
        if call.host == TAPIS and call.method == "POST" and call.path.count("/") > 4:
            head, _, rest = call.body.partition(b"\r\n\r\n")
            found[call.path.rsplit("/", 1)[-1]] = rest.rsplit(b"\r\n--", 1)[0]
            assert call.headers["Content-Length"] == str(len(call.body))
    return found


def uploaded_calls(network, name):
    return [c for c in network.calls if c.host == TAPIS and c.path.endswith("/" + name)]


def res(url, name=""):
    return {"name": name, "url": url}


# --- the happy path ---------------------------------------------------------------

def test_every_resource_is_copied_into_one_folder_and_the_folder_is_the_result(monkeypatch, capsys):
    network = Network({
        ("a.example", "/one.csv"): Reply(chunks=[b"1,2\n", b"3,4\n"]),
        ("b.example", "/get?id=7"): Reply(body=b"seven"),
        (TAPIS, "/v3/files/content/corral/data/three.txt"): Reply(body=b"three"),
    }, dns={"a.example": [PUBLIC], "b.example": ["8.8.8.8"]})
    outputs = run(monkeypatch, network, [
        res("https://a.example/one.csv", "one.csv"), res("https://b.example/get?id=7"),
        res("tapis://corral/data/three.txt", "three.txt")])
    result = "tapis://ls6/" + FOLDER
    assert outputs == {"result": result}
    # The report is the last line printed, and says where the folder is.
    assert last_line(capsys) == {"status": "ok", "svo_flow_outputs": {"result": result}}
    assert uploads(network) == {"one.csv": b"1,2\n3,4\n", "get": b"seven", "three.txt": b"three"}
    assert b'name="file"; filename="one.csv"' in uploaded_calls(network, "one.csv")[0].body
    folder_call = network.calls[0]
    assert (folder_call.method, folder_call.path) == ("POST", "/v3/files/ops/ls6")
    assert json.loads(folder_call.body) == {"path": "/" + FOLDER}
    # The upload goes under the gather folder.
    assert any(call.path == "/v3/files/ops/ls6/%s/one.csv" % FOLDER for call in network.calls)


def test_the_token_goes_only_to_tapis_and_never_to_an_https_resource(monkeypatch):
    network = Network({
        ("a.example", "/x"): Reply(302, headers={"Location": "https://b.example/y"}),
        ("b.example", "/y"): Reply(301, headers={"Location": "/z"}),
        ("b.example", "/z"): Reply(body=b"data"),
        (TAPIS, "/v3/files/content/corral/f"): Reply(body=b"f"),
    })
    run(monkeypatch, network, [res("https://a.example/x", "x"), res("tapis://corral/f", "f")])
    outside = https_calls(network)
    assert [c.path for c in outside] == ["/x", "/y", "/z"]  # the redirects were followed, by hand
    for call in outside:
        assert not any(name.lower() in ("x-tapis-token", "authorization", "cookie") for name in call.headers)
        assert TOKEN not in json.dumps(call.headers) and TOKEN not in call.path
    tapis_calls = [c for c in network.calls if c.host == TAPIS]
    assert tapis_calls and all(c.headers["X-Tapis-Token"] == TOKEN for c in tapis_calls)


def test_the_connection_goes_to_the_address_that_was_checked_with_the_name_kept(monkeypatch):
    network = Network({("a.example", "/x"): Reply(body=b"d")}, dns={"a.example": ["8.8.4.4", PUBLIC]})
    run(monkeypatch, network, [res("https://a.example/x", "x")])
    call = https_calls(network)[0]
    assert call.kind == "PinnedHTTPSConnection"
    assert call.address == "8.8.4.4" and call.host == "a.example"
    assert network.resolved == ["a.example"]  # looked up once; the connection does not look the name up again


def test_the_pinned_connection_dials_the_address_and_verifies_the_name(monkeypatch):
    dialled, wrapped = [], []

    class Socket:
        def close(self):
            pass

    class Context:
        def wrap_socket(self, sock, server_hostname=None):
            wrapped.append(server_hostname)
            return "tls"

    monkeypatch.setattr("socket.create_connection", lambda address, timeout=None: dialled.append(address) or Socket())
    connection = gather_fetch.PinnedHTTPSConnection("files.example", "93.184.216.34", timeout=9)
    # Certificate and host name verification stay on.
    assert connection._context.verify_mode == ssl.CERT_REQUIRED and connection._context.check_hostname is True
    connection._context = Context()
    connection.connect()
    assert dialled == [("93.184.216.34", 443)] and wrapped == ["files.example"]
    assert connection.sock == "tls" and connection.host == "files.example"


# --- refusing addresses -----------------------------------------------------------

@pytest.mark.parametrize("address", [
    "10.0.0.5", "172.16.3.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "224.0.0.1", "240.0.0.1", "::1", "::", "fe80::1", "fc00::1", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "2002:0a00:0001::1", "64:ff9b::a00:1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::10.0.0.1",
])
def test_an_address_that_is_not_public_is_refused(monkeypatch, capsys, address):
    network = Network({}, dns={"evil.example": [address]})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://evil.example/x", "x")])
    report = last_line(capsys)
    assert report["code"] == "GATHER_ADDRESS_REFUSED" and report["index"] == 0 and report["host"] == "evil.example"
    assert https_calls(network) == []  # nothing was sent anywhere


def test_a_name_with_one_private_answer_among_public_ones_is_refused(monkeypatch, capsys):
    network = Network({}, dns={"mixed.example": [PUBLIC, "10.1.2.3"]})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://mixed.example/x")])
    assert last_line(capsys)["code"] == "GATHER_ADDRESS_REFUSED" and https_calls(network) == []


def test_a_redirect_to_a_private_address_is_refused(monkeypatch, capsys):
    network = Network({("a.example", "/x"): Reply(302, headers={"Location": "https://inner.example/secret"})},
                      dns={"inner.example": ["169.254.169.254"]})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/x")])
    assert last_line(capsys)["code"] == "GATHER_ADDRESS_REFUSED"
    assert [c.host for c in https_calls(network)] == ["a.example"]


@pytest.mark.parametrize("location", ["http://a.example/x", "tapis://corral/f", "ftp://a.example/x",
                                      "https://a.example:8443/x", "https://u:p@a.example/x"])
def test_a_redirect_that_leaves_https_or_port_443_is_refused(monkeypatch, capsys, location):
    network = Network({("a.example", "/x"): Reply(302, headers={"Location": location})})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/x")])
    assert last_line(capsys)["code"] == "GATHER_RESOURCE_FAILED" and len(https_calls(network)) == 1


def test_at_most_five_redirects_are_followed(monkeypatch, capsys):
    routes = {("a.example", "/%d" % i): Reply(302, headers={"Location": "/%d" % (i + 1)}) for i in range(10)}
    routes[("a.example", "/x")] = Reply(302, headers={"Location": "/1"})
    network = Network(routes)
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/x")])
    assert last_line(capsys)["message"].endswith("too many redirects")
    assert len(https_calls(network)) == 6  # the first request and five redirects


def test_another_port_than_443_is_refused_before_anything_is_sent(monkeypatch, capsys):
    network = Network({})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example:8443/x")])
    assert last_line(capsys)["code"] == "GATHER_RESOURCE_FAILED" and network.calls[-1].host == TAPIS
    assert https_calls(network) == [] and network.resolved == []


# --- limits -----------------------------------------------------------------------

def test_the_size_limit_stops_a_download_as_soon_as_the_total_passes_it(monkeypatch, capsys):
    reply = Reply(chunks=[b"x" * 40] * 10, headers={"Content-Length": "5"})  # a header that lies
    network = Network({("a.example", "/big"): reply})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/big", "big")], max_bytes=100)
    report = last_line(capsys)
    assert report["code"] == "GATHER_TOO_LARGE" and report["limit_bytes"] == 100
    assert reply.reads == 3  # stopped on the third chunk, with seven unread
    assert uploads(network) == {}


def test_the_limit_is_for_the_whole_collection_not_one_file(monkeypatch, capsys):
    network = Network({("a.example", "/1"): Reply(body=b"x" * 60), ("a.example", "/2"): Reply(body=b"x" * 60)})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/1", "1"), res("https://a.example/2", "2")], max_bytes=100)
    assert last_line(capsys)["code"] == "GATHER_TOO_LARGE"
    assert list(uploads(network)) == ["1"]


# --- retries ----------------------------------------------------------------------

def test_a_transient_failure_on_a_download_is_tried_again(monkeypatch, capsys):
    network = Network({("a.example", "/x"): [Reply(503), Reply(429), Reply(body=b"ok")]})
    run(monkeypatch, network, [res("https://a.example/x", "x")])
    assert len(https_calls(network)) == 3 and last_line(capsys)["status"] == "ok"


def test_a_download_that_keeps_failing_gives_up_after_three_tries(monkeypatch, capsys):
    network = Network({("a.example", "/x?sig=abc123"): Reply(503)})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/x?sig=abc123")])
    report = last_line(capsys)
    assert (report["code"], report["http_status"], report["index"]) == ("GATHER_RESOURCE_FAILED", 503, 0)
    assert len(https_calls(network)) == 3


def test_a_network_error_is_tried_again_and_a_missing_file_is_not(monkeypatch, capsys):
    network = Network({("a.example", "/x"): [ConnectionResetError(), Reply(body=b"ok")],
                       ("a.example", "/gone"): Reply(404)})
    run(monkeypatch, network, [res("https://a.example/x", "x")])
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/gone")])
    report = last_line(capsys)
    assert (report["code"], report["http_status"]) == ("GATHER_RESOURCE_FAILED", 404)
    assert [c.path for c in https_calls(network)].count("/gone") == 1


@pytest.mark.parametrize("status", [401, 403])
def test_a_resource_that_needs_a_login_is_named_without_its_query(monkeypatch, capsys, status):
    network = Network({("data.example", "/f?X-Sig=SUPERSECRET"): Reply(status)})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://ok.example/never", "n"), res("https://data.example/f?X-Sig=SUPERSECRET")][::-1])
    output = capsys.readouterr().out
    report = json.loads(output.strip().splitlines()[-1])
    assert report["code"] == "GATHER_RESOURCE_NEEDS_LOGIN"
    assert (report["index"], report["host"], report["http_status"]) == (0, "data.example", status)
    assert "SUPERSECRET" not in output and TOKEN not in output


def test_an_upload_that_gets_no_answer_is_tried_once_more_and_a_refusal_is_not(monkeypatch, capsys):
    network = Network({("a.example", "/x"): Reply(body=b"d")})
    install(monkeypatch, network)
    original = network.answer
    state = {"posts": 0}

    def flaky(call):
        if call.host == TAPIS and call.path.endswith("/x"):
            state["posts"] += 1
            if state["posts"] == 1:
                raise ConnectionResetError()
        return original(call)
    network.answer = flaky
    exec(compile(gather_code(spec([res("https://a.example/x", "x")])), "<gather>", "exec"), {})
    assert state["posts"] == 2 and last_line(capsys)["status"] == "ok"

    state["posts"] = 0
    network.answer = lambda call: (_ for _ in ()).throw(ConnectionResetError()) if call.host == TAPIS and call.path.endswith("/x") else original(call)
    with pytest.raises(SystemExit):
        exec(compile(gather_code(spec([res("https://a.example/x", "x")])), "<gather>", "exec"), {})
    assert last_line(capsys)["code"] == "GATHER_STAGING_FAILED"

    network.answer = lambda call: Reply(403) if call.host == TAPIS and call.path.endswith("/x") else original(call)
    with pytest.raises(SystemExit):
        exec(compile(gather_code(spec([res("https://a.example/x", "x")])), "<gather>", "exec"), {})
    report = last_line(capsys)
    assert (report["code"], report["http_status"]) == ("GATHER_STAGING_FAILED", 403)


def test_a_bad_staging_folder_or_a_missing_token_fails_the_task(monkeypatch, capsys):
    for inputs in ({**INPUTS, "STAGING_URI": ""}, {**INPUTS, "STAGING_URI": "https://x.example/y"},
                   {**INPUTS, "TAPIS_TOKEN": ""}, {**INPUTS, "TAPIS_BASE_URL": "http://tapis.example"}):
        with pytest.raises(SystemExit):
            run(monkeypatch, Network({}), [res("https://a.example/x")], inputs=inputs)
        assert last_line(capsys)["code"] == "GATHER_STAGING_FAILED"


def test_nothing_printed_holds_the_token_a_query_or_a_body(monkeypatch, capsys):
    network = Network({("a.example", "/x?token=QUERYSECRET"): Reply(500, body=b"BODY-TEXT-SECRET"),
                       ("b.example", "/y?token=QUERYSECRET"): Reply(body=b"BODY-TEXT-SECRET")})
    for url in ("https://a.example/x?token=QUERYSECRET", "https://b.example/y?token=QUERYSECRET"):
        try:
            run(monkeypatch, network, [res(url, "")])
        except SystemExit:
            pass
    output = capsys.readouterr().out
    assert output and TOKEN not in output and "QUERYSECRET" not in output and "BODY-TEXT-SECRET" not in output


def test_a_surprise_error_prints_its_kind_not_its_text(monkeypatch, capsys):
    network = Network({("a.example", "/x"): ValueError("https://a.example/x?sig=LEAK")})
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("https://a.example/x")])
    output = capsys.readouterr().out
    assert "ValueError" in output and "LEAK" not in output


# --- the spec reaches the code as data ----------------------------------------------

def test_the_spec_is_data_in_the_code_not_source():
    hostile = spec([res("https://a.example/x", "x'); import os; os.system('id') #")], label='"""\n__import__("os")')
    code = gather_code(hostile)
    compile(code, "<gather>", "exec")
    # The hostile text appears only inside the one quoted JSON string.
    lines = [line for line in code.splitlines() if "os.system" in line]
    assert len(lines) == 1 and lines[0].startswith("_SPEC = json.loads(")


def test_the_embedded_rules_are_the_ones_that_are_tested():
    import inspect
    assert inspect.getsource(gather_fetch) in gather_code(spec([]))


# --- the rules on their own ---------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://example.org/a/b.csv", "https://Example.org/a?x=1&y=2", "https://example.org:443/a",
    "tapis://cloud.data/home/u/file.csv", "tapis://ls6/scratch/a-b/c_d.txt", "HTTPS://example.org/a",
])
def test_links_that_may_be_fetched(url):
    assert gather_fetch.check_url(url)["scheme"] in ("https", "tapis")


@pytest.mark.parametrize("url", [
    "", "http://example.org/a", "ftp://example.org/a", "file:///etc/passwd", "example.org/a",
    "https://", "https:///a", "https://u:p@example.org/a", "https://user@example.org/a",
    "https://example.org:8443/a", "https://example.org:abc/a", "https://example.org/a#frag",
    "https://exa mple.org/a", "https://example.org/a\nb", "https://example.org\\@evil.example/",
    "https://exämple.org/a", "https://example.org./a", "https://[not-an-address]/a",
    "tapis://", "tapis://sys", "tapis://sys/", "tapis://sys/a/../b", "tapis://sys/a/./b", "tapis://sys/%2e%2e/b",
    "tapis://sys/a//b", "tapis://sys/a/", "tapis://-bad/a", "tapis://sys name/a", "tapis://sys/a?x=1",
    "tapis://sys/a%2Fb/../c", "x" * 2001, 5, None,
])
def test_links_that_are_refused(url):
    with pytest.raises(ValueError):
        gather_fetch.check_url(url)


def test_a_refusal_never_repeats_the_link():
    for url in ("https://u:p@example.org/a?sig=QUERYSECRET", "http://example.org/a?sig=QUERYSECRET",
                "https://example.org:99/a?sig=QUERYSECRET"):
        with pytest.raises(ValueError) as error:
            gather_fetch.check_url(url)
        assert "QUERYSECRET" not in str(error.value) and "example.org" not in str(error.value)


@pytest.mark.parametrize("declared,url,expected", [
    ("report.csv", "https://h.example/x", "report.csv"),
    ("my report (1).csv", "https://h.example/x", "my_report_1_.csv"),
    ("", "https://h.example/files/data%20set.csv?sig=1", "data_set.csv"),
    ("a/b.csv", "https://h.example/files/real.csv", "real.csv"),      # not a base name: use the link
    ("..", "https://h.example/files/real.csv", "real.csv"),
    (".", "https://h.example/", "resource-3"),
    ("", "https://h.example/", "resource-3"),
    ("", "tapis://sys/dir/file.txt", "file.txt"),
    (None, "https://h.example/..%2f..%2fetc", "_.._etc"),
    ("...", "https://h.example/%2e%2e", "resource-3"),
    ("éè", "https://h.example/", "_"),
])
def test_a_file_name_is_safe_and_never_empty(declared, url, expected):
    assert gather_fetch.choose_name(declared, url, 3) == expected


def test_a_long_name_is_cut_but_keeps_its_extension():
    name = gather_fetch.choose_name("a" * 500 + ".csv", "https://h.example/x", 0)
    assert len(name) == 200 and name.endswith(".csv")
    name = gather_fetch.choose_name("b" * 500, "https://h.example/x", 0)
    assert len(name) == 200


def test_a_name_used_twice_gets_a_number_before_the_extension():
    taken: set[str] = set()
    names = [gather_fetch.unique_name(n, taken) for n in ("a.csv", "a.csv", "A.csv", "a-2.csv", "b", "b", "a.csv")]
    assert names == ["a.csv", "a-2.csv", "A-3.csv", "a-2-2.csv", "b", "b-2", "a-4.csv"]
    assert len({n.lower() for n in names}) == len(names)
    long = "x" * 200
    assert all(len(gather_fetch.unique_name(long, taken)) <= 200 for _ in range(3))


def test_names_come_out_distinct_in_the_staged_folder(monkeypatch):
    network = Network({("a.example", "/data.csv"): Reply(body=b"1"), ("b.example", "/data.csv"): Reply(body=b"2")})
    run(monkeypatch, network, [res("https://a.example/data.csv", "data.csv"), res("https://b.example/data.csv", "data.csv")])
    assert sorted(uploads(network)) == ["data-2.csv", "data.csv"]


@pytest.mark.parametrize("address,public", [
    ("93.184.216.34", True), ("8.8.8.8", True), ("2606:4700:4700::1111", True),
    ("::ffff:8.8.8.8", True), ("10.0.0.1", False), ("not an address", False), ("fe80::1%en0", False),
])
def test_only_public_unicast_addresses_pass(address, public):
    assert gather_fetch.is_public_address(address) is public


def test_the_task_sends_the_token_only_to_the_adapters_own_tapis_host(monkeypatch):
    # Whatever address the task is handed, the token goes to the one in its spec.
    network = Network()
    for given in ("https://evil.example", "https://" + TAPIS + ":8443", "https://" + TAPIS + ".evil.example"):
        with pytest.raises(SystemExit):
            run(monkeypatch, network, [res("https://a.example/x", "x")],
                inputs={**INPUTS, "TAPIS_BASE_URL": given})
    assert network.calls == []  # nothing was sent anywhere, with or without the token


def test_a_tapis_file_outside_the_allowed_systems_is_not_read(monkeypatch):
    network = Network()
    with pytest.raises(SystemExit):
        run(monkeypatch, network, [res("tapis://elsewhere/home/u/private.txt", "p")], tapis_systems=[])
    assert not any("/v3/files/content/" in call.path for call in network.calls)
