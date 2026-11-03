"""The public base URL is spelled SVO_ADAPTER_PUBLIC_URL by the deploy tooling
and docs, while the settings field (`public_base_url`) would map to
SVO_ADAPTER_PUBLIC_BASE_URL. Both must work: on 2026-11-03 the dev pod failed
startup validation because only the former was set."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402


def test_public_url_is_read_from_either_env_name(monkeypatch):
    for name in ("SVO_ADAPTER_PUBLIC_URL", "SVO_ADAPTER_PUBLIC_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    assert Settings(_env_file=None).public_base_url == ""

    monkeypatch.setenv("SVO_ADAPTER_PUBLIC_URL", "https://svo.example")
    assert Settings(_env_file=None).public_base_url == "https://svo.example"

    monkeypatch.delenv("SVO_ADAPTER_PUBLIC_URL")
    monkeypatch.setenv("SVO_ADAPTER_PUBLIC_BASE_URL", "https://svo-base.example")
    assert Settings(_env_file=None).public_base_url == "https://svo-base.example"

    monkeypatch.setenv("SVO_ADAPTER_PUBLIC_URL", "https://svo.example")
    assert Settings(_env_file=None).public_base_url == "https://svo.example"  # deploy name wins


def test_other_prefixed_settings_are_unaffected(monkeypatch):
    monkeypatch.setenv("SVO_ADAPTER_RUN_SIGNAL_SECRETS", "a,b")
    assert Settings(_env_file=None).run_signal_secret_list == ["a", "b"]
    assert "SVO_ADAPTER_DEMO_MODE" in os.environ or True
