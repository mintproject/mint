"""Fetching a piece's source from a public GitHub repository at a pinned commit.

No network: the host lookup and the connection are replaced, so what is asserted is
what the adapter asks for, where it connects, and what it refuses.
"""
from __future__ import annotations

import os

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config

import pytest  # noqa: E402

from app import gather_fetch, piece_authoring  # noqa: E402
from app.piece_authoring import MAX_SOURCE_BYTES, PieceError, fetch_source  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef01234567"
CODE = "def run(inputs):\n    return 'tapis://sys/out'\n"
PUBLIC = "140.82.112.4"


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = body
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.closed = False

    def getheader(self, name, default=None):
        return self._headers.get(name.lower(), default)

    def read(self, count=-1):
        chunk, self._body = self._body[:count], self._body[count:]
        return chunk

    def close(self):
        self.closed = True


@pytest.fixture
def wire(monkeypatch):
    """Replace the connection. ``wire.respond(...)`` sets the answer; ``wire.sent``
    records every connection made as (host, address, method, target)."""
    class Wire:
        sent: list = []
        response = FakeResponse(200, CODE.encode())

        def respond(self, status=200, body=b"", headers=None):
            self.response = FakeResponse(status, body, headers)

        def answer(self, host, contains, status=200, body=b"", headers=None):
            """Answer requests to ``host`` whose target contains ``contains``."""
            self.answers.append((host, contains, FakeResponse(status, body, headers)))

    state = Wire()
    state.sent = []
    state.answers = []
    state.headers = []

    class Connection:
        def __init__(self, host, address, timeout=30):
            self.host, self.address = host, address

        def request(self, method, target, headers=None):
            self.target = target
            state.sent.append((self.host, self.address, method, target))
            state.headers.append(headers or {})

        def getresponse(self):
            for host, contains, response in state.answers:
                if host == self.host and contains in self.target:
                    return response
            return state.response

        def close(self):
            pass

    monkeypatch.setattr(gather_fetch, "PinnedHTTPSConnection", Connection)
    monkeypatch.setattr(gather_fetch, "resolve_public", lambda host: [PUBLIC])
    return state


def code_of(call):
    with pytest.raises(PieceError) as raised:
        call()
    return raised.value.detail["code"]


def test_the_file_is_read_from_the_pinned_commit_and_stored_as_fetched(wire):
    wire.respond(200, CODE.encode("utf-8"), {"Content-Length": str(len(CODE))})
    got = fetch_source("Some-Org/some.repo", SHA.upper(), "pkg/piece.py")
    assert wire.sent == [("raw.githubusercontent.com", PUBLIC, "GET",
                          f"/Some-Org/some.repo/{SHA}/pkg/piece.py")]
    assert got["code"] == CODE
    assert got["sha256"] == piece_authoring.stored_source.source_sha256(CODE)
    assert got["commit"] == SHA  # normalised, so one address names one file
    assert got["url"].startswith("https://raw.githubusercontent.com/")


@pytest.mark.parametrize("commit", [
    "main", "v1.0.0", "refs/heads/main", SHA[:7], SHA[:39], SHA + "0", "g" * 40, "", SHA + "\n"])
def test_anything_but_a_full_commit_sha_is_refused_before_any_request(wire, commit):
    assert code_of(lambda: fetch_source("org/repo", commit, "piece.py")) == "PIECE_COMMIT_INVALID"
    assert wire.sent == []


@pytest.mark.parametrize("path", [
    "../piece.py", "/piece.py", "a//b.py", "a/./b.py", "piece.txt", "piece", "", "a b.py",
    "a\\b.py", "a/b.py?raw=1", "a/b.py#x", "x" * 400 + ".py"])
def test_a_path_must_be_a_plain_relative_python_file(wire, path):
    assert code_of(lambda: fetch_source("org/repo", SHA, path)) == "PIECE_PATH_INVALID"
    assert wire.sent == []


@pytest.mark.parametrize("repository", [
    "", "repo", "a/b/c", "-x/y", "x/..", "x/.", "x/y.git", "https://github.com/x/y", "x/y z",
    "a@b/c", "x/y?z"])
def test_a_repository_is_owner_slash_name(wire, repository):
    assert code_of(lambda: fetch_source(repository, SHA, "piece.py")) == "PIECE_REPOSITORY_INVALID"
    assert wire.sent == []


@pytest.mark.parametrize("status", [401, 403, 404])
def test_a_private_or_missing_file_is_not_found(wire, status):
    wire.respond(status)
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_NOT_FOUND"


def test_no_credential_is_ever_sent():
    # Nothing in the fetch takes a token, so a private repository cannot be read.
    import inspect
    assert "token" not in inspect.signature(fetch_source).parameters
    assert "Authorization" not in inspect.getsource(fetch_source)


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_a_redirect_is_not_followed_even_to_another_host(wire, status):
    wire.respond(status, headers={"Location": "https://evil.example/piece.py"})
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_REDIRECTED"
    assert len(wire.sent) == 1  # nothing was requested from the Location


def test_a_redirect_to_a_private_address_is_not_followed_either(wire):
    wire.respond(302, headers={"Location": "https://169.254.169.254/latest/meta-data"})
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_REDIRECTED"
    assert [s[0] for s in wire.sent] == ["raw.githubusercontent.com"]


def test_a_file_over_the_limit_is_refused_by_its_declared_length(wire):
    wire.respond(200, b"x", {"Content-Length": str(MAX_SOURCE_BYTES + 1)})
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_TOO_LARGE"


def test_a_file_over_the_limit_is_refused_by_what_arrives_not_what_is_declared(wire):
    wire.respond(200, b"#" * (MAX_SOURCE_BYTES + 1), {"Content-Length": "10"})
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_TOO_LARGE"
    wire.respond(200, b"#" * (MAX_SOURCE_BYTES + 1))  # chunked: no length at all
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_TOO_LARGE"


def test_a_file_exactly_at_the_limit_is_accepted(wire):
    wire.respond(200, b"#" * MAX_SOURCE_BYTES)
    assert fetch_source("org/repo", SHA, "piece.py")["bytes"] == MAX_SOURCE_BYTES


def test_a_file_that_is_not_utf8_is_refused(wire):
    wire.respond(200, b"\xff\xfe\x00")
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_NOT_TEXT"


def test_a_server_error_is_reported_as_unavailable(wire):
    wire.respond(503)
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_UNAVAILABLE"
    wire.respond(418)
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_FAILED"


def test_a_host_that_resolves_to_a_private_address_is_refused(monkeypatch):
    import socket
    monkeypatch.setattr(gather_fetch.socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.4", 443)),
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 443))])
    made = []
    monkeypatch.setattr(gather_fetch, "PinnedHTTPSConnection", lambda *a, **k: made.append(a))
    assert code_of(lambda: fetch_source("org/repo", SHA, "piece.py")) == "PIECE_SOURCE_ADDRESS_REFUSED"
    assert made == []


def test_the_connection_goes_to_the_checked_address_not_the_name(wire, monkeypatch):
    monkeypatch.setattr(gather_fetch, "resolve_public", lambda host: ["140.82.112.4", "140.82.112.5"])
    fetch_source("org/repo", SHA, "piece.py")
    assert wire.sent[0][1] == "140.82.112.4"


@pytest.mark.parametrize("code,problem", [
    ("", "PIECE_SOURCE_EMPTY"),
    ("def run(:\n", "PIECE_SOURCE_INVALID"),
    ("x = 1\n", "PIECE_ENTRYPOINT_INVALID"),
    ("async def run(inputs):\n    pass\n", "PIECE_ENTRYPOINT_INVALID"),
])
def test_the_file_must_define_the_entrypoint_as_a_plain_function(code, problem):
    assert code_of(lambda: piece_authoring.check_source(code, "run")) == problem


def test_an_entrypoint_that_is_not_a_name_is_refused():
    assert code_of(lambda: piece_authoring.check_source(CODE, "run; import os")) == "PIECE_ENTRYPOINT_INVALID"


def test_an_entrypoint_taking_more_than_one_argument_is_warned():
    assert piece_authoring.check_source("def run(a, b):\n    pass\n", "run")
    assert piece_authoring.check_source(CODE, "run") == []


# --- the commit belongs to the repository -----------------------------------
import json  # noqa: E402


def api(wire, repo=(200, {"default_branch": "main"}), compare=(200, {"status": "behind"}), **kw):
    wire.answer("api.github.com", "/compare/", compare[0], json.dumps(compare[1]).encode(), kw.get("compare_headers"))
    wire.answer("api.github.com", "/repos/org/repo", repo[0], json.dumps(repo[1]).encode(), kw.get("repo_headers"))


@pytest.mark.parametrize("status", ["identical", "behind"])
def test_a_commit_in_the_default_branch_history_is_verified(wire, status):
    api(wire, compare=(200, {"status": status}))
    assert piece_authoring.verify_commit("org/repo", SHA) == "main"
    targets = [t for h, _, _, t in wire.sent if h == "api.github.com"]
    assert targets == ["/repos/org/repo", f"/repos/org/repo/compare/main...{SHA}?per_page=1"]


def test_no_credential_is_sent_to_the_api(wire):
    api(wire)
    piece_authoring.verify_commit("org/repo", SHA)
    assert all("Authorization" not in h for h in wire.headers)


@pytest.mark.parametrize("status", ["ahead", "diverged"])
def test_a_fork_only_or_side_branch_commit_is_refused(wire, status):
    api(wire, compare=(200, {"status": status}))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_COMMIT_NOT_ON_BRANCH"


@pytest.mark.parametrize("answer", [404, 422])
def test_a_commit_github_cannot_find_in_the_repository_is_refused(wire, answer):
    api(wire, compare=(answer, {"message": "No commit found"}))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_COMMIT_NOT_IN_REPOSITORY"


def test_a_repository_github_does_not_know_is_not_found(wire):
    api(wire, repo=(404, {"message": "Not Found"}))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_SOURCE_NOT_FOUND"


def test_an_unreadable_answer_is_not_taken_as_verified(wire):
    api(wire, compare=(200, {"status": "who knows"}))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_UNAVAILABLE"
    wire.answers.clear()
    wire.answer("api.github.com", "/repos/org/repo", 200, b"<html>")
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_UNAVAILABLE"


def test_the_rate_limit_is_reported_clearly_never_as_verified(wire):
    api(wire, repo=(403, {"message": "rate limit exceeded"}),
        repo_headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000"})
    with pytest.raises(PieceError) as raised:
        piece_authoring.verify_commit("org/repo", SHA)
    assert raised.value.detail["code"] == "PIECE_PROVENANCE_RATE_LIMITED"
    assert "1700000000" in raised.value.detail["message"]
    wire.answers.clear()
    wire.answer("api.github.com", "/compare/", 429)
    wire.answer("api.github.com", "/repos/org/repo", 200, b'{"default_branch": "main"}')
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_RATE_LIMITED"


def test_a_server_error_from_the_api_is_unavailable(wire):
    api(wire, repo=(503, {}))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_UNAVAILABLE"


def test_the_api_gets_the_same_care_as_the_raw_fetch(wire, monkeypatch):
    # No redirect, whatever it points at.
    wire.answer("api.github.com", "/repos/org/repo", 301, headers={"Location": "https://evil.example/"})
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_SOURCE_REDIRECTED"
    assert {h for h, *_ in wire.sent} == {"api.github.com"}
    # An oversized answer, by declared length and by what arrives.
    wire.answers.clear()
    wire.answer("api.github.com", "/repos/org/repo", 200, b"{}", {"Content-Length": str(10**7)})
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_UNAVAILABLE"
    wire.answers.clear()
    wire.answer("api.github.com", "/repos/org/repo", 200, b" " * (piece_authoring.MAX_API_BYTES + 1))
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_PROVENANCE_UNAVAILABLE"
    # A host that resolves to a private address is refused before any connection.
    wire.answers.clear()
    monkeypatch.setattr(gather_fetch, "resolve_public", lambda host: (_ for _ in ()).throw(
        gather_fetch.GatherError("GATHER_ADDRESS_REFUSED", "the host resolves to an address that is not public")))
    wire.sent.clear()
    assert code_of(lambda: piece_authoring.verify_commit("org/repo", SHA)) == "PIECE_SOURCE_ADDRESS_REFUSED"
    assert wire.sent == []


def test_a_branch_name_with_a_slash_is_kept_and_odd_characters_are_quoted(wire):
    api(wire, repo=(200, {"default_branch": "release/v 1#"}))
    piece_authoring.verify_commit("org/repo", SHA)
    assert wire.sent[-1][3] == f"/repos/org/repo/compare/release/v%201%23...{SHA}?per_page=1"


def test_verified_source_records_the_branch(wire):
    api(wire)
    wire.answer("raw.githubusercontent.com", SHA, 200, CODE.encode())
    got = piece_authoring.fetch_verified_source("org/repo", SHA, "p.py")
    assert got["verified_on_branch"] == "main" and got["code"] == CODE


def test_an_unverified_commit_is_not_returned_as_a_piece_source(wire):
    api(wire, compare=(200, {"status": "diverged"}))
    wire.answer("raw.githubusercontent.com", SHA, 200, CODE.encode())
    assert code_of(lambda: piece_authoring.fetch_verified_source("org/repo", SHA, "p.py")) == "PIECE_COMMIT_NOT_ON_BRANCH"


def test_the_origin_carries_the_branch_it_was_verified_on():
    built = piece_authoring.build_piece(
        {"label": "x", "entrypoint": "run",
         "inputs": [{"standard_variable_uri": "u"}], "outputs": [{"standard_variable_uri": "v"}]},
        {"code": CODE, "repository": "o/r", "commit": SHA, "path": "p.py", "url": "u", "sha256": "h",
         "fetched_at": "t", "verified_on_branch": "main"},
        "https://id/x")
    assert built["object"]["runtime_json"]["origin"]["verified_on_branch"] == "main"


def test_the_registration_limiter_allows_thirty_an_hour_per_user():
    limiter = piece_authoring.RateLimiter(30, 3600.0)
    assert all(limiter.take("a", now=float(i)) is None for i in range(30))
    wait = limiter.take("a", now=30.0)
    assert wait is not None and 3569 < wait <= 3570
    assert limiter.take("b", now=30.0) is None  # another user is not affected
    assert limiter.take("a", now=3600.0) is None  # the first call has aged out
