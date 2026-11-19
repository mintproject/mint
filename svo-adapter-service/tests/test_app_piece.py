"""The code a flow runs for a piece that is a Tapis app: submit the job, wait for
it, find each output in the job's archive. Run here against a stand-in Tapis."""
from __future__ import annotations

import io
import json
import os
import sys
import types
import urllib.error
from pathlib import Path

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.app_piece import app_piece_code  # noqa: E402

SPEC = {
    "app_id": "some-app", "app_version": "1.0", "exec_system": "ls6", "job_name": "plan-step-1",
    "stage": "run", "env_keys": ["TOP_N", "UNSET"],
    "file_inputs": [{"name": "docs", "target_path": "docs", "task_input": "SOURCE_1"}],
    "outputs": [{"id": "result", "file": "clean_*.csv"}, {"id": "result_2", "file": None}],
    "job_uuid_output": "value_job_uuid", "outage_seconds": 0, "poll_seconds": 0,
}
INPUTS = {"TAPIS_BASE_URL": "https://tapis.example/", "TAPIS_TOKEN": "tok", "ALLOCATION": "ALLOC-1",
          "SOURCE_1": "tapis://sys/docs", "TOP_N": "5"}
ARCHIVE = [{"name": "clean_2024.csv", "path": "/archive/job-1/clean_2024.csv", "type": "file"},
           {"name": "notes.txt", "path": "/archive/job-1/notes.txt", "type": "file"},
           {"name": "sub", "path": "/archive/job-1/sub", "type": "dir"}]


class _Tapis:
    """Answers the Jobs API calls the piece makes, and records them."""

    def __init__(self, statuses=("PENDING", "RUNNING", "FINISHED"), archive=ARCHIVE, errors=None):
        self.statuses, self.archive, self.errors = list(statuses), archive, dict(errors or {})
        self.calls: list[tuple[str, str, dict | None, dict]] = []

    def __call__(self, request, timeout=None):
        path = request.full_url.replace("https://tapis.example", "")
        body = json.loads(request.data.decode()) if request.data else None
        self.calls.append((request.get_method(), path, body, dict(request.header_items())))
        for prefix, code in list(self.errors.items()):
            if path.startswith(prefix):
                raise urllib.error.HTTPError(request.full_url, code, "refused", {}, io.BytesIO(b""))
        if path == "/v3/jobs/submit":
            answer = {"result": {"uuid": "job-1"}}
        elif path == "/v3/jobs/job-1/status":
            answer = {"result": {"status": self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]}}
        elif path == "/v3/jobs/job-1":
            answer = {"result": {"archiveSystemId": "corral", "archiveSystemDir": "/archive/job-1"}}
        elif path.startswith("/v3/jobs/job-1/output/list/"):
            answer = {"result": self.archive if "skip=0" in path else []}
        else:
            raise AssertionError("unexpected call " + path)
        return io.BytesIO(json.dumps(answer).encode())


def run(monkeypatch, tapis, spec=SPEC, inputs=INPUTS):
    outputs: dict[str, str] = {}
    context = types.SimpleNamespace(get_input=lambda name: inputs.get(name),
                                    set_output=lambda name, value: outputs.__setitem__(name, value))
    runtime = types.ModuleType("owe_python_sdk.runtime")
    runtime.execution_context = context
    monkeypatch.setitem(sys.modules, "owe_python_sdk", types.ModuleType("owe_python_sdk"))
    monkeypatch.setitem(sys.modules, "owe_python_sdk.runtime", runtime)
    monkeypatch.setattr("urllib.request.urlopen", tapis)
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    exec(compile(app_piece_code(spec), "<app piece>", "exec"), {"__name__": "__piece__"})
    return outputs


def test_it_submits_the_job_with_the_linked_input_and_settings(monkeypatch):
    tapis = _Tapis()
    run(monkeypatch, tapis)
    method, path, job, headers = tapis.calls[0]
    assert (method, path) == ("POST", "/v3/jobs/submit")
    assert headers["X-tapis-token"] == "tok"
    assert (job["appId"], job["appVersion"], job["execSystemId"], job["name"]) == ("some-app", "1.0", "ls6", "plan-step-1")
    assert job["fileInputs"] == [{"name": "docs", "sourceUrl": "tapis://sys/docs", "targetPath": "docs"}]
    # A setting with no value is left out, not sent empty.
    assert job["parameterSet"]["envVariables"] == [{"key": "STAGE", "value": "run"}, {"key": "TOP_N", "value": "5"}]
    assert job["parameterSet"]["schedulerOptions"] == [{"name": "TACC Allocation", "arg": "-A ALLOC-1"}]


def test_each_output_is_found_in_the_jobs_archive(monkeypatch):
    outputs = run(monkeypatch, _Tapis())
    assert outputs == {
        "result": "tapis://corral/archive/job-1/clean_2024.csv",   # the file the piece named
        "result_2": "tapis://corral/archive/job-1",                # no file named: the archive folder
        "value_job_uuid": "job-1",
    }


def test_it_waits_for_the_job_and_submits_it_once(monkeypatch):
    tapis = _Tapis(statuses=("PENDING", "QUEUED", "RUNNING", "ARCHIVING", "FINISHED"))
    run(monkeypatch, tapis)
    paths = [path for _, path, _, _ in tapis.calls]
    assert paths.count("/v3/jobs/submit") == 1
    assert paths.count("/v3/jobs/job-1/status") == 5


@pytest.mark.parametrize("status", ["FAILED", "CANCELLED"])
def test_a_job_that_fails_fails_the_step_and_sets_no_output(monkeypatch, capsys, status):
    with pytest.raises(SystemExit):
        run(monkeypatch, _Tapis(statuses=("RUNNING", status)))
    report = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert (report["code"], report["job_uuid"], report["status"]) == ("APP_PIECE_JOB_FAILED", "job-1", status)


@pytest.mark.parametrize("archive,code", [
    ([{"name": "notes.txt", "path": "/archive/job-1/notes.txt", "type": "file"}], "APP_PIECE_OUTPUT_MISSING"),
    (ARCHIVE + [{"name": "clean_2025.csv", "path": "/archive/job-1/clean_2025.csv", "type": "file"}],
     "APP_PIECE_OUTPUT_AMBIGUOUS"),
])
def test_an_output_file_that_is_missing_or_ambiguous_fails_the_step(monkeypatch, capsys, archive, code):
    with pytest.raises(SystemExit):
        run(monkeypatch, _Tapis(archive=archive))
    report = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert report["code"] == code and "notes.txt" in report["archived_files"]


def test_a_rejected_token_says_why(monkeypatch, capsys):
    with pytest.raises(SystemExit):
        run(monkeypatch, _Tapis(errors={"/v3/jobs/job-1/status": 401}))
    report = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert report["code"] == "APP_PIECE_AUTH_FAILED" and "outlasts the token" in report["message"]


def test_a_failed_submit_is_not_tried_again(monkeypatch):
    tapis = _Tapis(errors={"/v3/jobs/submit": 503})
    with pytest.raises(SystemExit):
        run(monkeypatch, tapis)
    assert [path for _, path, _, _ in tapis.calls] == ["/v3/jobs/submit"]


def test_a_missing_file_input_fails_before_anything_is_submitted(monkeypatch):
    tapis = _Tapis()
    with pytest.raises(SystemExit):
        run(monkeypatch, tapis, inputs={k: v for k, v in INPUTS.items() if k != "SOURCE_1"})
    assert tapis.calls == []


def test_the_spec_reaches_the_code_as_data_not_as_source():
    hostile = {**SPEC, "app_id": "x'); import os; os.system('id') #", "stage": '"""\n__import__("os")'}
    code = app_piece_code(hostile)
    compile(code, "<app piece>", "exec")
    assert code.count("__import__") == 1 and "json.loads(" in code  # only inside the quoted JSON
