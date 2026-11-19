"""The code a flow runs for a piece that is a Tapis app.

A Tapis Workflows job task returns nothing a later task can read. So in a flow
an app piece runs as a hosted function that submits the job itself, waits for
it, and then finds the piece's outputs in the job's archive on storage: each
output by the file name the piece declared, or the archive folder when it
declared none. Each becomes a named task output, like any other piece's.

This is separate from the model stage (``tapis._model_execution_code``), which
also reports liveness to the Ensemble Manager, renews its token and fetches
stored credentials. An app piece does none of that yet: a job that outlasts the
runner's Tapis token cannot be followed to its end, and says so.
"""
from __future__ import annotations

import json
from typing import Any

_TEMPLATE = r'''
import fnmatch, json, time, urllib.error as _ue, urllib.parse as _up, urllib.request as _ur
from owe_python_sdk.runtime import execution_context as _ctx

_SPEC = json.loads(__SPEC__)


def _in(name):
    value = _ctx.get_input(name)
    return "" if value is None else str(value)


def _die(code, message, **details):
    print(json.dumps({"status": "error", "code": code, "message": message, **details}))
    raise SystemExit(1)


_base = _in("TAPIS_BASE_URL").rstrip("/")
_token = _in("TAPIS_TOKEN")
if not _base or not _token:
    _die("APP_PIECE_AUTH_REQUIRED", "the step was given no Tapis address or token")


class _Transient(Exception):
    pass


def _request(path, method="GET", payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"X-Tapis-Token": _token, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        with _ur.urlopen(_ur.Request(_base + path, data=body, headers=headers, method=method), timeout=90) as response:
            return json.loads(response.read().decode())
    except _ue.HTTPError as error:
        if error.code in (401, 403):
            _die("APP_PIECE_AUTH_FAILED",
                 "Tapis rejected the run's token; a job that outlasts the token cannot be followed to its end",
                 http_status=error.code, path=path)
        if error.code >= 500 or error.code in (408, 429):
            raise _Transient()
        _die("APP_PIECE_REQUEST_FAILED", "Tapis answered HTTP %s" % error.code, path=path)
    except (_ue.URLError, OSError, ValueError):
        raise _Transient()


def _read(path):
    # A read after the job is done: a blip must not throw the run away.
    for _ in range(6):
        try:
            return _request(path)
        except _Transient:
            time.sleep(10)
    _die("APP_PIECE_REQUEST_FAILED", "Tapis kept failing", path=path)


_env = [{"key": "STAGE", "value": _SPEC["stage"]}]
for _key in _SPEC["env_keys"]:
    if _in(_key) != "":
        _env.append({"key": _key, "value": _in(_key)})
_files = []
for _file in _SPEC["file_inputs"]:
    _source = _in(_file["task_input"])
    if not _source:
        _die("APP_PIECE_INPUT_MISSING", "no location was given for the app's file input %s" % _file["name"])
    _entry = {"name": _file["name"], "sourceUrl": _source}
    if _file.get("target_path"):
        _entry["targetPath"] = _file["target_path"]
    _files.append(_entry)
_job = {
    "name": _SPEC["job_name"], "appId": _SPEC["app_id"], "appVersion": _SPEC["app_version"],
    "execSystemId": _SPEC["exec_system"], "nodeCount": 1, "archiveOnAppError": True,
    "fileInputs": _files, "parameterSet": {"envVariables": _env},
}
if _in("ALLOCATION"):
    _job["parameterSet"]["schedulerOptions"] = [{"name": "TACC Allocation", "arg": "-A " + _in("ALLOCATION")}]

try:
    # Not retried: Tapis may have accepted the job before an error came back, and
    # a second submit would run it twice.
    _submitted = _request("/v3/jobs/submit", method="POST", payload=_job)
except _Transient:
    _die("APP_PIECE_SUBMIT_FAILED", "Tapis could not be reached to submit the job")
_uuid = str(((_submitted or {}).get("result") or {}).get("uuid") or "")
if not _uuid:
    _die("APP_PIECE_SUBMIT_FAILED", "Tapis returned no job id")
print(json.dumps({"status": "submitted", "job_uuid": _uuid}))

_status_path = "/v3/jobs/%s/status" % _up.quote(_uuid, safe="")
_last_ok = time.time()
while True:
    try:
        _status = str((((_request(_status_path) or {}).get("result")) or {}).get("status") or "").upper()
    except _Transient:
        if time.time() - _last_ok > _SPEC["outage_seconds"]:
            _die("APP_PIECE_REQUEST_FAILED", "the job's status could not be read for too long", job_uuid=_uuid)
        time.sleep(_SPEC["poll_seconds"])
        continue
    _last_ok = time.time()
    if _status == "FINISHED":
        break
    if _status in ("FAILED", "CANCELLED"):
        _die("APP_PIECE_JOB_FAILED", "the job ended with status %s" % _status, job_uuid=_uuid, status=_status)
    time.sleep(_SPEC["poll_seconds"])

_detail = (_read("/v3/jobs/%s" % _up.quote(_uuid, safe="")) or {}).get("result") or {}
_system = str(_detail.get("archiveSystemId") or "")
_folder = str(_detail.get("archiveSystemDir") or "").strip("/")
if not _system or not _folder:
    _die("APP_PIECE_ARCHIVE_UNKNOWN", "Tapis did not say where the job's archive is", job_uuid=_uuid)

_listed = []
if any(_output.get("file") for _output in _SPEC["outputs"]):
    # Tapis pages the listing. Stop on an empty page, not a short one.
    for _page in range(5):
        _found = (_read("/v3/jobs/%s/output/list/?limit=1000&skip=%d" % (_up.quote(_uuid, safe=""), _page * 1000))
                  or {}).get("result") or []
        if not _found:
            break
        _listed.extend(entry for entry in _found if isinstance(entry, dict) and entry.get("type") != "dir")
_names = [str(entry.get("name") or "") for entry in _listed]

_results = {}
for _output in _SPEC["outputs"]:
    _wanted = _output.get("file")
    if not _wanted:
        _results[_output["id"]] = "tapis://%s/%s" % (_system, _folder)
        continue
    _matches = [entry for entry in _listed if fnmatch.fnmatchcase(str(entry.get("name") or ""), _wanted)]
    if len(_matches) != 1:
        _die("APP_PIECE_OUTPUT_MISSING" if not _matches else "APP_PIECE_OUTPUT_AMBIGUOUS",
             "the output file %s matched %d files in the job's archive" % (_wanted, len(_matches)),
             job_uuid=_uuid, archived_files=_names[:40])
    _path = str(_matches[0].get("path") or "").lstrip("/")
    _results[_output["id"]] = "tapis://%s/%s" % (_system, _path or (_folder + "/" + str(_matches[0].get("name"))))
if _SPEC.get("job_uuid_output"):
    _results[_SPEC["job_uuid_output"]] = _uuid
for _id, _value in _results.items():
    _ctx.set_output(_id, _value)
print(json.dumps({"status": "ok", "job_uuid": _uuid, "outputs": _results}))
'''


def app_piece_code(spec: dict[str, Any]) -> str:
    """The function task's code for one app piece. ``spec`` is plain data built by
    the pipeline generator; it reaches the code as one JSON string, never as
    interpolated source."""
    return _TEMPLATE.replace("__SPEC__", repr(json.dumps(spec, sort_keys=True)))
