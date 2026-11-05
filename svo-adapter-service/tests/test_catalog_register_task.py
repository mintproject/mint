"""The catalog_register task code (design 2026-11-05-output-publish-etl.md, section 2),
run as a subprocess against one fake Tapis Files + CKAN + STAC server. The real
stac-platform library does the publishing; it is found beside this repository (or at
$STAC_PLATFORM_PATH) and those tests skip when it is absent."""
from __future__ import annotations

import base64
import json
import os
import re
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

os.environ["SVO_ADAPTER_DEMO_MODE"] = "1"  # MUST precede importing app.config
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from app.config import settings  # noqa: E402
from app.task_code import get_code  # noqa: E402


def _stac_platform() -> str | None:
    if os.environ.get("STAC_PLATFORM_PATH"):
        return os.environ["STAC_PLATFORM_PATH"]
    for parent in ROOT.parents:
        if (parent / "stac-platform" / "stacmap").is_dir():
            return str(parent / "stac-platform")
    return None


STAC_PLATFORM = _stac_platform()
needs_stacmap = pytest.mark.skipif(STAC_PLATFORM is None, reason="stac-platform checkout not found")


def _jwt(username="alice", **claims) -> str:
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc({'tapis/username': username, **claims})}.signature-part"


TOKEN = _jwt("alice")


def make_geotiff(west=-97.5, north=31.8, pixel=0.01, size=10) -> bytes:
    """A minimal EPSG:4326 GeoTIFF header (no pixel data): all the task reads."""
    geokeys = struct.pack("<16H", 1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326)
    scale = struct.pack("<3d", pixel, pixel, 0)
    tie = struct.pack("<6d", 0, 0, 0, west, north, 0)
    data_at = 8 + 2 + 5 * 12 + 4
    entries = [(256, 4, 1, size), (257, 4, 1, size),
               (33550, 12, 3, data_at), (33922, 12, 6, data_at + len(scale)),
               (34735, 3, len(geokeys) // 2, data_at + len(scale) + len(tie))]
    ifd = struct.pack("<H", len(entries)) + b"".join(
        struct.pack("<HHII", tag, kind, count, value) for tag, kind, count, value in entries)
    return b"II*\x00" + struct.pack("<I", 8) + ifd + struct.pack("<I", 0) + scale + tie + geokeys


class Fake:
    """Tapis Files (/tapis), CKAN (/ckan) and STAC (/stac) in one in-memory server."""

    def __init__(self):
        self.files = {
            "work/archive/opera_disp_s1_cumulative.tif": make_geotiff(),
            "work/archive/opera_disp_s1_velocity.tif": make_geotiff(),
            "work/archive/notes.txt": b"not a product",
        }
        self.datasets: dict[str, dict] = {}
        self.items: dict[str, dict] = {}
        self.collections: set[str] = set()
        self.requests: list[tuple[str, str]] = []
        self.payloads: list[tuple[str, dict]] = []
        self.echo_auth_on_ckan_create = False
        self.redirect_listing = False
        self.rename_dataset_to = None
        self.auth_seen: list[tuple[str, str | None]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def _send(self, status, payload, raw=None):
                body = raw if raw is not None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self, method):
                url = urlparse(self.path)
                path = unquote(url.path)
                body = self._body()
                fake.requests.append((method, path))
                fake.auth_seen.append((path, self.headers.get("X-Tapis-Token")))
                if path.startswith("/tapis/"):
                    return fake.tapis(self, method, path[len("/tapis"):], url, body)
                if path.startswith("/ckan/"):
                    return fake.ckan(self, method, path[len("/ckan"):], body)
                if path.startswith("/stac/"):
                    return fake.stac(self, method, path[len("/stac"):], body)
                self._send(404, {})

            do_GET = lambda self: self._handle("GET")  # noqa: E731
            do_POST = lambda self: self._handle("POST")  # noqa: E731
            do_PUT = lambda self: self._handle("PUT")  # noqa: E731
            do_PATCH = lambda self: self._handle("PATCH")  # noqa: E731

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    # -- Tapis Files
    def tapis(self, h, method, path, url, body):
        _, _, _, kind, system, rest = (path.split("/", 5) + [""])[:6]
        prefix = rest.strip("/")
        if kind == "ops" and method == "GET" and self.redirect_listing:
            h.send_response(302)
            h.send_header("Location", "/capture/elsewhere")
            h.send_header("Content-Length", "0")
            h.end_headers()
            return
        if kind == "ops" and method == "GET":
            rows = [{"name": p.rsplit("/", 1)[-1], "path": "/" + p, "type": "file", "size": len(b),
                     "lastModified": "2025-06-01T12:00:00Z"}
                    for p, b in sorted(self.files.items()) if p.startswith(prefix + "/")]
            return h._send(200, {"result": rows})
        if kind == "content" and method == "GET":
            return h._send(200, None, raw=self.files[prefix]) if prefix in self.files else h._send(404, {})
        if kind == "ops" and method == "POST":
            boundary = ("--" + re.search(r"boundary=(.+)", h.headers["Content-Type"]).group(1)).encode()
            part = body.split(boundary)[1].strip(b"\r\n")
            self.files[prefix] = part.partition(b"\r\n\r\n")[2]
            return h._send(200, {})
        h._send(404, {})

    # -- CKAN
    def ckan(self, h, method, path, body):
        action = path.rsplit("/", 1)[-1]
        ctype = h.headers.get("Content-Type", "")
        fields = self.form(ctype, body) if "multipart" in ctype else (json.loads(body or b"{}"))
        self.payloads.append((action, fields))
        ok = lambda result, status=200: h._send(status, {"success": True, "result": result})  # noqa: E731
        if action == "package_show":
            ds = self.datasets.get(fields["id"])
            return ok(ds) if ds else h._send(404, {"success": False, "error": {"__type": "Not Found"}})
        if action == "package_create":
            if self.echo_auth_on_ckan_create:
                return h._send(403, {"success": False, "error": {
                    "message": "denied", "echo": h.headers.get("Authorization")}})
            ds = {**fields, "id": "id-" + fields["name"], "resources": []}
            self.datasets[fields["name"]] = ds
            if self.rename_dataset_to:  # CKAN may report a different name than the one requested
                ds["name"] = self.rename_dataset_to
                self.datasets[self.rename_dataset_to] = ds
            return ok(ds)
        if action == "package_patch":
            self.datasets[fields["id"]].update({k: v for k, v in fields.items() if k != "id"})
            return ok(self.datasets[fields["id"]])
        if action in ("resource_create", "resource_patch"):
            data = {k: v for k, v in fields.items() if k != "upload"}
            if action == "resource_create":
                res = {**data, "id": "res-%d" % sum(len(d["resources"]) for d in self.datasets.values()),
                       "url": "%s/ckan/dl/%s" % (self.url, data["name"]), "size": 1, "hash": "h"}
                self.datasets[data["package_id"]]["resources"].append(res)
            else:
                res = next(r for d in self.datasets.values() for r in d["resources"] if r["id"] == data["id"])
                res.update(data)
            return ok(res)
        h._send(404, {"success": False})

    @staticmethod
    def form(ctype, body):
        boundary = ("--" + re.search(r"boundary=(.+)", ctype).group(1)).encode()
        out = {}
        for part in body.split(boundary)[1:-1]:
            head, _, value = part.strip(b"\r\n").partition(b"\r\n\r\n")
            name = re.search(rb'name="([^"]+)"', head).group(1).decode()
            out[name] = "<file>" if b"filename=" in head else value.decode()
        return out

    # -- STAC
    def stac(self, h, method, path, body):
        parts = path.strip("/").split("/")
        if parts[0] == "collections" and len(parts) == 2:
            if method == "GET":
                return h._send(200 if parts[1] in self.collections else 404, {})
        if path == "/collections" and method == "POST":
            self.collections.add(json.loads(body)["id"])
            return h._send(201, {})
        if len(parts) == 4 and parts[2] == "items":
            key = f"{parts[1]}/{parts[3]}"
            if method == "GET":
                return h._send(200, self.items[key]) if key in self.items else h._send(404, {})
            if method == "PUT":
                self.items[key] = json.loads(body)
                return h._send(200, {})
        h._send(404, {})

    def writes(self):
        return [(m, p) for m, p in self.requests if m != "GET" and not p.startswith("/stac/collections/x")]


@pytest.fixture
def fake():
    server = Fake()
    yield server
    server.close()


def run_task(fake, token=TOKEN, **overrides):
    env = {
        "TAPIS_TOKEN": token, "TAPIS_BASE_URL": fake.url + "/tapis", "SOURCE_URI": "tapis://ls6/work/archive",
        "STAC_URL": fake.url + "/stac", "CKAN_URL": fake.url + "/ckan", "STAC_COLLECTION": "subsidence-rates-dev",
        "CKAN_ORG": "dso-internal", "PUBLIC": "false", "STAC_ITEM_ID": "ue_1", "EXECUTION_ID": "ue_1",
        "PRODUCT_PATTERN": "opera_disp_s1_cumulative.tif,opera_disp_s1_velocity.tif", **overrides}
    stub = (
        "import sys, types\n"
        "_m = types.ModuleType('owe_python_sdk.runtime.execution_context')\n"
        "_m.get_input = lambda name: None\n"
        "_m.set_output = lambda k, v: print('RESULT:' + v)\n"
        "for _n in ('owe_python_sdk', 'owe_python_sdk.runtime'):\n"
        "    sys.modules[_n] = types.ModuleType(_n)\n"
        "sys.modules['owe_python_sdk.runtime'].execution_context = _m\n"
        "sys.modules['owe_python_sdk.runtime.execution_context'] = _m\n"
        f"sys.path.insert(0, {STAC_PLATFORM!r})\n" if STAC_PLATFORM else "")
    settings.publish_enabled = True
    child_env = {k: v for k, v in os.environ.items() if k not in env}
    proc = subprocess.run([sys.executable, "-I", "-c", stub + get_code("catalog_register")],
                          env={**child_env, **env}, capture_output=True, text=True, timeout=120)
    result = [ln[7:] for ln in proc.stdout.splitlines() if ln.startswith("RESULT:")]
    return proc, (json.loads(result[-1]) if result else None)


# --- refusals happen before any request ------------------------------------------------
@pytest.mark.parametrize("override", [
    {"token": ""},
    {"token": "not-a-jwt"},
    {"token": _jwt(exp=1)},
    {"CKAN_URL": ""},
    {"STAC_URL": "ftp://stac.example"},
    {"CKAN_URL": "https://user:pw@ckan.example"},
    {"SOURCE_URI": "/work/archive"},
    {"STAC_ITEM_ID": "../escape"},
    {"CATALOGS": "stac"},    # STAC assets are CKAN resources; CKAN cannot be left out
    {"CATALOGS": "zenodo"},
])
def test_malformed_input_exits_2_before_any_http_call(fake, override):
    proc, result = run_task(fake, **override)
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert result["status"] == "error"
    assert fake.requests == []


@needs_stacmap
def test_an_item_published_by_someone_else_is_not_overwritten(fake):
    fake.collections.add("subsidence-rates-dev")
    fake.items["subsidence-rates-dev/ue_1"] = {"id": "ue_1", "properties": {"published_by": "bob"}}
    proc, result = run_task(fake)
    assert proc.returncode == 2 and "not published by this user" in result["message"]
    assert fake.writes() == []
    assert fake.items["subsidence-rates-dev/ue_1"]["properties"] == {"published_by": "bob"}


@needs_stacmap
def test_an_item_with_no_owner_is_not_overwritten_either(fake):
    fake.items["subsidence-rates-dev/ue_1"] = {"id": "ue_1", "properties": {}}
    proc, _ = run_task(fake)
    assert proc.returncode == 2 and fake.writes() == []


# --- publishing -------------------------------------------------------------------------
def counts(fake):
    out: dict[str, int] = {}
    for action, _ in fake.payloads:
        out[action] = out.get(action, 0) + 1
    return out


@needs_stacmap
def test_success_creates_one_dataset_uploads_products_and_upserts_one_stamped_item(fake):
    proc, result = run_task(fake)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert result == {"catalog": "ckan+stac", "public": False,
                      "ckan_dataset": fake.url + "/ckan/dataset/subsidence-rates-dev--ue_1",
                      "stac_item": fake.url + "/stac/collections/subsidence-rates-dev/items/ue_1"}
    tally = counts(fake)
    assert tally["package_create"] == 1
    assert tally["resource_create"] == 3  # cumulative, velocity, manifest
    assert "resource_patch" not in tally
    puts = [r for r in fake.requests if r[0] == "PUT"]
    assert len(puts) == 1
    item = fake.items["subsidence-rates-dev/ue_1"]
    assert item["properties"]["published_by"] == "alice"
    assert item["properties"]["execution_id"] == "ue_1"
    west, south, east, north = item["bbox"]
    assert (round(west, 2), round(south, 2), round(east, 2), round(north, 2)) == (-97.5, 31.7, -97.4, 31.8)
    assert item["properties"]["start_datetime"].startswith("2025-06-01")
    assert set(item["assets"]) >= {"cumulative", "velocity", "metadata"}
    # Private by default; the manifest is written back beside the products.
    assert fake.datasets["subsidence-rates-dev--ue_1"]["private"] is True
    assert "work/archive/ue_1-manifest.json" in fake.files
    manifest = json.loads(fake.files["work/archive/ue_1-manifest.json"])
    assert manifest["execution_id"] == "ue_1"
    assert manifest["artifacts"]["cumulative_displacement_geotiff"]["path"] == "opera_disp_s1_cumulative.tif"


@needs_stacmap
def test_ckan_only_writes_the_dataset_and_never_calls_stac(fake):
    proc, result = run_task(fake, CATALOGS="ckan")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert result == {"catalog": "ckan", "public": False, "stac_item": None,
                      "ckan_dataset": fake.url + "/ckan/dataset/subsidence-rates-dev--ue_1"}
    assert not [p for _, p in fake.requests if p.startswith("/stac")]
    assert fake.items == {} and fake.collections == set()
    assert counts(fake)["package_create"] == 1 and counts(fake)["resource_create"] == 3
    # No stac_collection extra: the reconcile bridge adopts datasets by that extra
    # and would otherwise publish this one to STAC after all.
    create = next(f for a, f in fake.payloads if a == "package_create")
    extras = {e["key"]: e["value"] for e in json.loads(create["extras"])} if isinstance(
        create.get("extras"), str) else {e["key"]: e["value"] for e in create.get("extras") or []}
    assert "stac_collection" not in extras
    assert extras["stac_item_id"] == "ue_1" and extras["catalogs"] == "ckan"


@needs_stacmap
def test_an_explicit_ckan_stac_choice_matches_the_default(fake):
    proc, result = run_task(fake, CATALOGS="stac+ckan")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert result["catalog"] == "ckan+stac" and result["stac_item"]
    create = next(f for a, f in fake.payloads if a == "package_create")
    extras = {e["key"]: e["value"] for e in (json.loads(create["extras"]) if isinstance(
        create.get("extras"), str) else create.get("extras") or [])}
    assert extras["stac_collection"] == "subsidence-rates-dev" and extras["catalogs"] == "ckan+stac"


@needs_stacmap
@pytest.mark.parametrize("public, private", [("false", True), ("true", False)])
def test_dataset_visibility_follows_public(fake, public, private):
    proc, result = run_task(fake, PUBLIC=public)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    create = next(f for a, f in fake.payloads if a == "package_create")
    assert create["private"] is private and create["owner_org"] == "dso-internal"
    assert result["public"] is (public == "true")


@needs_stacmap
def test_second_run_updates_only(fake):
    assert run_task(fake)[0].returncode == 0
    first = counts(fake)
    fake.payloads.clear()
    proc, _ = run_task(fake)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    second = counts(fake)
    assert "package_create" not in second and "resource_create" not in second
    assert second["resource_patch"] == first["resource_create"]
    assert fake.items["subsidence-rates-dev/ue_1"]["properties"]["published_by"] == "alice"


@needs_stacmap
def test_second_run_can_open_a_private_dataset(fake):
    run_task(fake, PUBLIC="false")
    run_task(fake, PUBLIC="true")
    patch = [f for a, f in fake.payloads if a == "package_patch"]
    assert patch and patch[0]["private"] is False


@needs_stacmap
def test_a_dataset_that_is_not_this_users_run_is_never_touched(fake):
    name = "subsidence-rates-dev--ue_1"
    for extras in ([{"key": "stac_item_id", "value": "ue_1"}, {"key": "published_by", "value": "bob"}],
                   [{"key": "stac_item_id", "value": "other"}, {"key": "published_by", "value": "alice"}],
                   []):
        fake.datasets[name] = {"name": name, "id": "x", "private": True, "extras": extras, "resources": []}
        fake.payloads.clear()
        proc, result = run_task(fake, PUBLIC="true")
        assert proc.returncode == 2 and "does not belong to this run and user" in result["message"]
        assert counts(fake).keys() <= {"package_show"}, counts(fake)
        assert fake.datasets[name]["private"] is True


@needs_stacmap
def test_the_dataset_link_uses_the_name_ckan_reported(fake):
    fake.rename_dataset_to = "renamed-by-ckan"
    proc, result = run_task(fake)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert result["ckan_dataset"] == fake.url + "/ckan/dataset/renamed-by-ckan"


def test_a_redirect_is_refused_and_the_token_is_not_replayed(fake):
    fake.redirect_listing = True
    proc, result = run_task(fake)
    assert proc.returncode == 2 and "HTTP 302" in result["message"]
    assert not [p for p, _ in fake.auth_seen if p.startswith("/capture")]


@needs_stacmap
def test_no_matching_products_fails_cleanly(fake):
    proc, result = run_task(fake, PRODUCT_PATTERN="*.nc")
    assert proc.returncode == 2 and "no products matching" in result["message"]
    assert fake.writes() == []


@needs_stacmap
def test_an_echoing_server_leaves_no_token_in_the_output(fake):
    fake.echo_auth_on_ckan_create = True
    proc, result = run_task(fake)
    assert proc.returncode == 2
    assert "HTTP 403" in result["message"]
    assert TOKEN not in proc.stdout + proc.stderr
    assert not re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", proc.stdout + proc.stderr)
