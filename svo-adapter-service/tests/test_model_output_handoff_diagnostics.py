from __future__ import annotations

import base64
import json
import io
import time
import urllib.parse
import urllib.request
import urllib.error

import pytest

from app.config import settings
from app.tapis import generate_tapis_workflow


def _model_code(output_file: str | None = None, output_name: str = "cbb") -> str:
    workflow = generate_tapis_workflow({
        "id": "diagnostic-plan",
        "plan_json": {
            "steps": [],
            "model_task": {
                "stage_id": "model",
                "output_name": output_name,
                "output_format": "cbc",
                **({"output_file": output_file} if output_file is not None else {}),
                "max_minutes": 1,
                "job_definition": {
                    "name": "mint-workflow-model-test",
                    "appId": "model-app",
                    "appVersion": "0.0.test",
                    "archiveSystemId": "ls6",
                },
            },
        },
    })
    return workflow["tasks"][0]["code"]


class _Response:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def getcode(self):
        return self.status

    def read(self):
        return json.dumps(self.payload).encode()


lookups = []


def _run(code, monkeypatch, capsys, responder, token="diagnostic-token", existing_jobs=()):
    """Run the generated model task. ``existing_jobs`` is what Tapis already holds under
    the job name (the re-attach lookup); by default there is none, so the task submits."""
    monkeypatch.setenv("TAPIS_TOKEN", token)
    monkeypatch.setenv("TAPIS_BASE_URL", "https://portals.example")
    lookups.clear()

    def urlopen(request, timeout=90):
        if "/v3/jobs/list" in request.full_url:
            lookups.append(request.full_url)
            return _Response({"result": list(existing_jobs)})
        return responder(request, timeout)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    exec(compile(code, "model-execution", "exec"), {})
    return json.loads(capsys.readouterr().out.strip())


def test_model_stage_captures_exact_job_uuid_and_discovers_declared_output(
    monkeypatch, capsys
):
    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == "diagnostic-token"
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-1"}})
        if request.full_url.endswith("/v3/jobs/provider-job-1/status"):
            return _Response({"result": {"status": "FINISHED"}})
        if request.full_url.endswith("/v3/jobs/provider-job-1"):
            return _Response({"result": {"uuid": "provider-job-1", "archiveSystemId": "ls6"}})
        if request.full_url.split("?")[0].endswith("/v3/jobs/provider-job-1/output/list/"):
            return _Response({"result": [{
                "type": "file",
                "name": "model.cbb",
                "path": "/scratch/model-job/model.cbb",
            }]})
        raise AssertionError(request.full_url)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert result["resource_uri"] == "tapis://ls6/scratch/model-job/model.cbb"
    assert result["model_job_uuid"] == "provider-job-1"
    assert "diagnostic-token" not in json.dumps(result)


def test_model_stage_fails_closed_when_declared_output_is_ambiguous(monkeypatch, capsys):
    def responder(request, _timeout):
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-2"}})
        if request.full_url.endswith("/status"):
            return _Response({"result": {"status": "COMPLETED"}})
        if request.full_url.endswith("/v3/jobs/provider-job-2"):
            return _Response({"result": {"archiveSystemId": "ls6"}})
        if request.full_url.split("?")[0].endswith("/output/list/"):
            return _Response({"result": [
                {"type": "file", "name": "a.cbb", "path": "/a.cbb"},
                {"type": "file", "name": "b.cbb", "path": "/b.cbb"},
            ]})
        raise AssertionError(request.full_url)

    with pytest.raises(RuntimeError, match="MODEL_OUTPUT_AMBIGUOUS"):
        _run(_model_code(), monkeypatch, capsys, responder)

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["code"] == "MODEL_OUTPUT_AMBIGUOUS"
    assert all("diagnostic-token" not in json.dumps(attempt) for attempt in payload["attempts"])


def test_model_stage_stops_on_tapis_normal_completion(monkeypatch, capsys):
    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == "diagnostic-token"
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-normal"}})
        if request.full_url.endswith("/v3/jobs/provider-job-normal/status"):
            return _Response({"result": {"status": "NORMAL_COMPLETION"}})
        if request.full_url.endswith("/v3/jobs/provider-job-normal"):
            return _Response({"result": {"uuid": "provider-job-normal", "archiveSystemId": "ls6"}})
        if request.full_url.split("?")[0].endswith("/v3/jobs/provider-job-normal/output/list/"):
            return _Response({"result": [{
                "type": "file",
                "name": "model.cbb",
                "path": "/scratch/model-job/model.cbb",
            }]})
        raise AssertionError(request.full_url)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert result["model_job_uuid"] == "provider-job-normal"


def test_model_stage_reports_auth_failure_without_echoing_the_token(monkeypatch, capsys):
    secret = "diagnostic-token"

    def responder(request, _timeout):
        assert request.headers["X-tapis-token"] == secret
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "provider-job-auth"}})
        raise urllib.error.HTTPError(
            request.full_url,
            401,
            "unauthorized",
            hdrs=None,
            fp=io.BytesIO(b'{"message":"owner mismatch"}'),
        )

    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_AUTH_FAILED"):
        _run(_model_code(), monkeypatch, capsys, responder)

    output = capsys.readouterr().out
    assert "MODEL_PROVIDER_AUTH_FAILED" in output
    assert secret not in output


def _jwt(expires_in: int) -> str:
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return ".".join([
        part({"alg": "none"}),
        part({"exp": int(time.time()) + expires_in,
              "tapis/username": "alice", "tapis/tenant_id": "portals"}),
        "sig",
    ])


def _job_responder(statuses, seen_tokens, mint=None):
    """Serve one model job whose status walks through ``statuses``."""
    polls = iter(statuses)

    def responder(request, _timeout):
        seen_tokens.append((request.get_method(), request.full_url.rsplit("/v3", 1)[1],
                            request.headers["X-tapis-token"]))
        if request.full_url.endswith("/v3/tokens"):
            return _Response(mint(request))
        if request.full_url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "long-job"}})
        if request.full_url.endswith("/v3/jobs/long-job/status"):
            return _Response({"result": {"status": next(polls)}})
        if request.full_url.endswith("/v3/jobs/long-job"):
            return _Response({"result": {"uuid": "long-job", "archiveSystemId": "ls6"}})
        if request.full_url.split("?")[0].endswith("/v3/jobs/long-job/output/list/"):
            return _Response({"result": [{"type": "file", "name": "model.cbb", "path": "/m/model.cbb"}]})
        raise AssertionError(request.full_url)

    return responder


def test_model_stage_polls_until_the_job_is_terminal_with_no_poll_limit(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    seen = []
    # Far more polls than any fixed window would have allowed.
    statuses = ["QUEUED"] * 2000 + ["RUNNING"] * 50 + ["FINISHED"]

    result = _run(_model_code(), monkeypatch, capsys, _job_responder(statuses, seen))

    assert result["status"] == "ok"
    assert sum(1 for _m, path, _t in seen if path.endswith("/status")) == len(statuses)


def test_model_stage_renews_its_token_before_it_expires(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    monkeypatch.setattr(settings, "run_token_enabled", True)
    monkeypatch.setattr(settings, "run_token_ttl_seconds", 3600)
    expiring, fresh = _jwt(60), _jwt(3600)
    minted = []

    def mint(request):
        minted.append(json.loads(request.data))
        return {"result": {"access_token": {"access_token": fresh}}}

    seen = []
    result = _run(_model_code(), monkeypatch, capsys,
                  _job_responder(["QUEUED", "RUNNING", "FINISHED"], seen, mint), token=expiring)

    assert result["status"] == "ok"
    # One renewal while waiting, then one forced mint so the next stage gets a full-lifetime token.
    assert len(minted) == 2
    assert all(m["token_username"] == "alice" and m["access_token_ttl"] == 3600 for m in minted)
    # The renewal call authenticates with the expiring token; every call after uses the fresh one.
    mint_indexes = [i for i, (_m, path, _t) in enumerate(seen) if path == "/tokens"]
    assert seen[mint_indexes[0]][2] == expiring
    assert all(token == fresh for _m, _p, token in seen[mint_indexes[0] + 1:])
    assert fresh not in json.dumps(result)


def test_model_stage_keeps_polling_when_a_renewal_attempt_fails(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    monkeypatch.setattr(settings, "run_token_enabled", True)
    expiring = _jwt(120)

    def mint(_request):
        raise OSError("tokens API unavailable")

    seen = []
    result = _run(_model_code(), monkeypatch, capsys,
                  _job_responder(["QUEUED", "FINISHED"], seen, mint), token=expiring)

    assert result["status"] == "ok"
    assert {token for _m, _p, token in seen} == {expiring}


def _flaky_responder(poll_failures, finish_after=1):
    """Serve one job whose first status polls raise the given errors."""
    state = {"polls": 0, "failures": list(poll_failures)}

    def responder(request, _timeout):
        url = request.full_url
        if url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "flaky-job"}})
        if url.endswith("/v3/jobs/flaky-job/status"):
            if state["failures"]:
                raise state["failures"].pop(0)
            state["polls"] += 1
            return _Response({"result": {"status": "FINISHED" if state["polls"] >= finish_after else "QUEUED"}})
        if url.endswith("/v3/jobs/flaky-job"):
            return _Response({"result": {"uuid": "flaky-job", "archiveSystemId": "ls6"}})
        if url.split("?")[0].endswith("/v3/jobs/flaky-job/output/list/"):
            return _Response({"result": [{"type": "file", "name": "model.cbb", "path": "/m/model.cbb"}]})
        raise AssertionError(url)

    return responder, state


def test_model_stage_rides_out_transient_network_errors_while_polling(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    responder, state = _flaky_responder([
        urllib.error.URLError("timed out"),
        urllib.error.HTTPError("https://portals.example/x", 503, "unavailable", {}, None),
        urllib.error.HTTPError("https://portals.example/x", 429, "slow down", {}, None),
        ConnectionResetError("reset by peer"),
    ], finish_after=2)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert state["failures"] == []


def test_model_stage_fails_when_tapis_stays_unreachable_past_the_outage_window(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    monkeypatch.setattr(settings, "model_poll_outage_seconds", 0)
    responder, _state = _flaky_responder([urllib.error.URLError("timed out")] * 50)

    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_REQUEST_FAILED"):
        _run(_model_code(), monkeypatch, capsys, responder)


def test_model_stage_still_fails_at_once_when_a_poll_is_unauthorized(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    responder, _state = _flaky_responder([
        urllib.error.HTTPError("https://portals.example/x", 401, "unauthorized", {}, None),
    ])

    with pytest.raises(RuntimeError, match="MODEL_PROVIDER_AUTH_FAILED"):
        _run(_model_code(), monkeypatch, capsys, responder)


def test_model_stage_retries_the_reads_made_after_the_job_finishes(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    calls = {"detail": 0}

    def responder(request, _timeout):
        url = request.full_url
        if url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": "late-job"}})
        if url.endswith("/status"):
            return _Response({"result": {"status": "FINISHED"}})
        if url.endswith("/v3/jobs/late-job"):
            calls["detail"] += 1
            if calls["detail"] < 3:
                raise urllib.error.URLError("timed out")
            return _Response({"result": {"uuid": "late-job", "archiveSystemId": "ls6"}})
        if url.split("?")[0].endswith("/output/list/"):
            return _Response({"result": [{"type": "file", "name": "model.cbb", "path": "/m/model.cbb"}]})
        raise AssertionError(url)

    result = _run(_model_code(), monkeypatch, capsys, responder)

    assert result["status"] == "ok"
    assert calls["detail"] == 3


def _attach_responder(submitted):
    def responder(request, _timeout):
        url = request.full_url
        if url.endswith("/v3/jobs/submit"):
            submitted.append(True)
            return _Response({"result": {"uuid": "new-job"}})
        if url.endswith("/status"):
            return _Response({"result": {"status": "FINISHED"}})
        job = url.split("/v3/jobs/")[1].split("/")[0]
        if url.split("?")[0].endswith("/output/list/"):
            return _Response({"result": [{"type": "file", "name": "model.cbb", "path": "/m/model.cbb"}]})
        return _Response({"result": {"uuid": job, "archiveSystemId": "ls6"}})

    return responder


def test_model_stage_attaches_to_a_job_it_already_submitted(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    submitted = []
    existing = [{"uuid": "orphan-job", "name": "mint-workflow-model-test", "status": "QUEUED"}]

    result = _run(_model_code(), monkeypatch, capsys, _attach_responder(submitted),
                  existing_jobs=existing)

    assert result["status"] == "ok" and result["model_job_uuid"] == "orphan-job"
    assert submitted == []
    assert "name.eq.mint-workflow-model-test" in lookups[0]


def test_model_stage_ignores_failed_jobs_and_other_names_when_attaching(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    submitted = []
    existing = [
        {"uuid": "dead-job", "name": "mint-workflow-model-test", "status": "FAILED"},
        {"uuid": "other-job", "name": "mint-workflow-model-test-2", "status": "RUNNING"},
    ]

    result = _run(_model_code(), monkeypatch, capsys, _attach_responder(submitted),
                  existing_jobs=existing)

    assert result["model_job_uuid"] == "new-job"
    assert submitted == [True]


def test_model_stage_submits_when_no_job_exists_yet(monkeypatch, capsys):
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    submitted = []

    result = _run(_model_code(), monkeypatch, capsys, _attach_responder(submitted))

    assert result["model_job_uuid"] == "new-job" and submitted == [True]


# --- explicit output file binding (design 2026-11-07-output-file-binding.md) ---------------
def _listing_responder(pages, uuid="bind-job", seen=None):
    """Serve a finished job whose archive listing is ``pages`` (a list of entry lists)."""
    def responder(request, _timeout):
        url = request.full_url
        if url.endswith("/v3/jobs/submit"):
            return _Response({"result": {"uuid": uuid}})
        if url.endswith("/status"):
            return _Response({"result": {"status": "FINISHED"}})
        if "/output/list/" in url:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            if seen is not None:
                seen.append(query)
            index = int(query["skip"][0]) // int(query["limit"][0])
            return _Response({"result": pages[index] if index < len(pages) else []})
        return _Response({"result": {"uuid": uuid, "archiveSystemId": "ls6"}})

    return responder


def _files(*names):
    return [{"type": "file", "name": n, "path": "/scratch/" + n} for n in names]


OPERA = ["disp_displacement.tif", "disp_overlay.png", "opera_disp_s1_cumulative.tif",
         "opera_disp_s1_velocity.tif", "run-manifest.json", "tapisjob.out"]


def _bound_ok(monkeypatch, capsys, output_file, names=OPERA, output_name="Cumulative displacement GeoTIFF"):
    return _run(_model_code(output_file, output_name), monkeypatch, capsys,
                _listing_responder([_files(*names)]))


def _bound_error(monkeypatch, capsys, output_file, pages=None, output_name="Cumulative displacement GeoTIFF"):
    pages = pages if pages is not None else [_files(*OPERA)]
    with pytest.raises(RuntimeError) as exc:
        _run(_model_code(output_file, output_name), monkeypatch, capsys, _listing_responder(pages))
    payload = json.loads(capsys.readouterr().out.strip())
    assert str(exc.value).startswith(payload["code"])
    return payload


def test_literal_binding_selects_one_tif_among_several(monkeypatch, capsys):
    result = _bound_ok(monkeypatch, capsys, "opera_disp_s1_cumulative.tif")
    assert result["resource_uri"] == "tapis://ls6/scratch/opera_disp_s1_cumulative.tif"
    assert result["selected_by"] == "binding"
    assert result["output_file"] == "opera_disp_s1_cumulative.tif"
    assert result["archived_name"] == "opera_disp_s1_cumulative.tif"
    assert "diagnostic-token" not in json.dumps(result)


def test_glob_binding_selects_the_single_match(monkeypatch, capsys):
    result = _bound_ok(monkeypatch, capsys, "*_cumulative.tif")
    assert result["archived_name"] == "opera_disp_s1_cumulative.tif"
    assert result["selected_by"] == "binding"


def test_literal_binding_may_contain_a_bracket(monkeypatch, capsys):
    result = _bound_ok(monkeypatch, capsys, "run[1].tif", names=["run[1].tif", "run1.tif"])
    assert result["archived_name"] == "run[1].tif"


def test_binding_is_case_sensitive(monkeypatch, capsys):
    payload = _bound_error(monkeypatch, capsys, "OPERA_DISP_S1_CUMULATIVE.TIF")
    assert payload["code"] == "MODEL_OUTPUT_MISSING"


def test_a_bound_output_never_falls_back_to_the_name_rule(monkeypatch, capsys):
    # The name rule would pick model.cbb; the binding names a file that is absent.
    payload = _bound_error(monkeypatch, capsys, "heads.hds",
                           pages=[_files("model.cbb", "model.hds")], output_name="cbb")
    assert payload["code"] == "MODEL_OUTPUT_MISSING"


def test_missing_binding_reports_candidates_and_a_hint(monkeypatch, capsys):
    payload = _bound_error(monkeypatch, capsys, "cumulative.tif")
    assert payload["code"] == "MODEL_OUTPUT_MISSING"
    details = payload["details"]
    assert details["output_file"] == "cumulative.tif"
    assert details["output_name"] == "cumulative displacement geotiff"
    assert details["candidates"] == ["disp_displacement.tif", "opera_disp_s1_cumulative.tif",
                                     "opera_disp_s1_velocity.tif"]
    assert details["hint"] == "re-register the configuration's output binding"
    assert details["job_uuid"] == "bind-job" and details["truncated"] is False
    assert details["listed"] == 5  # tapisjob.out is not a candidate
    assert "tapisjob.out" not in details["archived_files"]
    assert "diagnostic-token" not in json.dumps(payload)


def test_glob_matching_many_files_is_ambiguous(monkeypatch, capsys):
    payload = _bound_error(monkeypatch, capsys, "*.tif")
    assert payload["code"] == "MODEL_OUTPUT_AMBIGUOUS"
    assert "candidates" not in payload["details"] and payload["details"]["output_file"] == "*.tif"


def test_tapisjob_files_are_never_candidates(monkeypatch, capsys):
    payload = _bound_error(monkeypatch, capsys, "*.out")
    assert payload["code"] == "MODEL_OUTPUT_MISSING"
    result = _run(_model_code(output_name="result.out"), monkeypatch, capsys,
                  _listing_responder([_files("tapisjob.out", "result.out")]))
    assert result["archived_name"] == "result.out" and result["selected_by"] == "name"


def test_unbound_output_records_the_name_rule_in_the_manifest(monkeypatch, capsys):
    result = _run(_model_code(), monkeypatch, capsys, _listing_responder([_files("model.cbb")]))
    assert result["selected_by"] == "name" and result["output_file"] is None


def test_listing_is_paged_until_a_short_page(monkeypatch, capsys):
    seen = []
    first = _files(*["f%04d.txt" % i for i in range(1000)])
    pages = [first, _files("late.tif")]
    result = _run(_model_code("late.tif"), monkeypatch, capsys, _listing_responder(pages, seen=seen))
    assert result["archived_name"] == "late.tif"
    assert [(q["limit"], q["skip"]) for q in seen] == [(["1000"], ["0"]), (["1000"], ["1000"])]


def test_listing_stops_after_five_full_pages_and_flags_truncation(monkeypatch, capsys):
    seen = []
    pages = [_files(*["p%d_%04d.txt" % (p, i) for i in range(1000)]) for p in range(6)]
    with pytest.raises(RuntimeError, match="MODEL_OUTPUT_MISSING"):
        _run(_model_code("gone.tif"), monkeypatch, capsys, _listing_responder(pages, seen=seen))
    payload = json.loads(capsys.readouterr().out.strip())
    assert len(seen) == 5
    assert payload["details"]["truncated"] is True and payload["details"]["listed"] == 5000
    assert len(payload["details"]["archived_files"]) == 40


@pytest.mark.parametrize("bad", ["a/b", "..", "/abs", "tapisjob.out", "{param:x}", "x" * 256,
                                 "it's.tif", "a\nb.tif"])
def test_the_task_itself_rejects_an_invalid_binding(bad, monkeypatch, capsys):
    code = _model_code("placeholder.tif").replace("'placeholder.tif'", repr(bad))
    with pytest.raises(RuntimeError, match="MODEL_OUTPUT_FILE_INVALID"):
        _run(code, monkeypatch, capsys, _listing_responder([_files("a.tif")]))
    capsys.readouterr()


def test_output_file_is_substituted_last_so_it_cannot_inject_a_placeholder():
    # Rejected at submit, but the generator must still be inert for any string.
    code = _model_code("__OUTPUT_NAME__")
    assert "_output_file = '__OUTPUT_NAME__'" in code
