"""How a flow's settings are described, and what its author decided about them.

A piece describes each setting in its ``parameters_schema_json`` as JSON Schema:
``title``, ``description``, ``type``, ``default``, ``oneOf`` (choices, each with
a ``title`` and ``description``) or a plain ``enum``, ``minimum``, ``maximum``,
and ``x-advanced``. Every key is optional; an older piece has only a type and a
description.

The flow's author decides, per setting, who may see it and who may change it. That
is kept on the flow as ``settings_json``::

    {"<setting name>": {"visibility": "shown" | "advanced" | "hidden", "fixed": true}}

The author's values stay in each step's settings. When a run starts a setting takes
the first value found in this order: the author's fixed value, the runner's value
(refused for a setting that is fixed or hidden), the author's default, the piece's
default.

This module is pure: it reads dicts and returns dicts and problems.
"""
from __future__ import annotations

from typing import Any, Iterable

VISIBILITIES = ("shown", "advanced", "hidden")

# Between the flow's parameter ids and the setting names: ``{configuration}_setting_{name}``.
PARAMETER_MARKER = "_setting_"

_PASSED_ON = ("type", "default", "description", "title", "minimum", "maximum")


def choices_of(prop: Any) -> list[dict[str, Any]]:
    """The choices a setting offers, as ``[{value, title?, description?}]``.

    From ``oneOf`` (each entry a ``const`` with an optional title and description)
    or, when there is none, from a plain ``enum`` (values only). A setting with
    neither has no choices.
    """
    if not isinstance(prop, dict):
        return []
    choices: list[dict[str, Any]] = []
    for entry in prop.get("oneOf") if isinstance(prop.get("oneOf"), list) else []:
        if isinstance(entry, dict) and "const" in entry:
            choices.append({"value": entry["const"], **{
                key: entry[key] for key in ("title", "description") if entry.get(key) is not None}})
    if choices:
        return choices
    return [{"value": value} for value in prop["enum"]] if isinstance(prop.get("enum"), list) else []


def describe(prop: Any) -> dict[str, Any]:
    """What a setting's schema says about it. Only what is there: a schema with
    just a type and a description gives just those."""
    if not isinstance(prop, dict):
        return {}
    described = {key: prop[key] for key in _PASSED_ON if prop.get(key) is not None}
    choices = choices_of(prop)
    if choices:
        described["choices"] = choices
    if prop.get("x-advanced") is True:
        described["advanced"] = True
    return described


def piece_default(piece: dict[str, Any], name: str) -> Any:
    """The default the piece itself gives a setting, or None."""
    prop = ((piece.get("parameters_schema_json") or {}).get("properties") or {}).get(name)
    return prop.get("default") if isinstance(prop, dict) else None


def rule_of(rules: Any, name: str) -> dict[str, Any]:
    rule = rules.get(name) if isinstance(rules, dict) else None
    return rule if isinstance(rule, dict) else {}


def visibility_of(rules: Any, name: str, advanced: bool = False) -> str:
    """The author's choice, else the piece's own hint (``x-advanced``), else shown."""
    chosen = rule_of(rules, name).get("visibility")
    if chosen in VISIBILITIES:
        return str(chosen)
    return "advanced" if advanced else "shown"


def is_fixed(rules: Any, name: str) -> bool:
    return rule_of(rules, name).get("fixed") is True


def thread_bound_names(thread_bindings: Any) -> set[str]:
    """Settings the thread fills in itself (the dates), from the flow's thread
    bindings, which name the flow's parameter ids."""
    names: set[str] = set()
    for role, target in (thread_bindings.items() if isinstance(thread_bindings, dict) else []):
        parameter = target.get("parameter") if isinstance(target, dict) else None
        if role != "collections" and isinstance(parameter, str) and PARAMETER_MARKER in parameter:
            names.add(parameter.rpartition(PARAMETER_MARKER)[2])
    return names


def rules_problems(rules: Any, known: Iterable[str]) -> list[str]:
    """Why the flow's ``settings`` are not usable, one message each."""
    if rules is None or rules == {}:
        return []
    if not isinstance(rules, dict):
        return ["a flow's settings are an object of setting names"]
    known = set(known)
    problems: list[str] = []
    for name in sorted(rules, key=str):
        rule = rules[name]
        if name not in known:
            problems.append(f"no step has a setting named {name}")
        elif not isinstance(rule, dict) or set(rule) - {"visibility", "fixed"}:
            problems.append(f"{name}: a setting's choices are a visibility and whether it is fixed")
        elif rule.get("visibility") is not None and rule["visibility"] not in VISIBILITIES:
            problems.append(f"{name}: visibility is one of {', '.join(VISIBILITIES)}")
        elif rule.get("fixed") is not None and not isinstance(rule["fixed"], bool):
            problems.append(f"{name}: fixed is true or false")
    return problems


def resolve(
    rules: Any,
    pieces: Iterable[dict[str, Any] | None],
    step_settings: Iterable[dict[str, Any]],
    refused: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Every setting of the flow's pieces as a runner meets it, by name.

    ``pieces`` are piece views (see ``main._piece_view``) and ``step_settings`` the
    author's values, one dict per step. Each entry carries the schema's description
    of the setting, the value a run would start from (``default``), whether it is
    ``fixed``, and its ``visibility``. A setting shared by several steps is one
    entry, described by the first piece that declares it.
    """
    refused_names = {str(name).lower() for name in refused}
    author: dict[str, Any] = {}
    for settings in step_settings:
        for name, value in (settings or {}).items():
            author.setdefault(name, value)
    found: dict[str, dict[str, Any]] = {}
    for piece in pieces:
        properties = ((piece or {}).get("parameters_schema_json") or {}).get("properties") or {}
        for name, prop in properties.items():
            if str(name).lower() in refused_names or name in found:
                continue
            details = describe(prop)
            value = author[name] if name in author else details.get("default")
            fixed = is_fixed(rules, name)
            found[name] = {
                "name": name, **details,
                **({"default": value} if value is not None else {}),
                "visibility": visibility_of(rules, name, bool(details.get("advanced"))),
                **({"fixed": True} if fixed else {}),
                **({"author_default": True} if name in author else {}),
            }
    return [found[name] for name in sorted(found)]


def hidden_without_value(
    rules: Any,
    piece: dict[str, Any],
    author_values: Iterable[str],
    wired: Iterable[str],
) -> list[str]:
    """Settings of one piece that the author hid, that the piece requires, and that
    nothing gives a value: no fixed or default value from the author, no link from an
    earlier step and no default in the piece. A run could never start."""
    schema = piece.get("parameters_schema_json") or {}
    properties = schema.get("properties") or {}
    required = {str(name) for name in schema.get("required") or []}
    valued = set(author_values) | set(wired)
    return sorted(
        name for name in required
        if name in properties and name not in valued
        and visibility_of(rules, name, False) == "hidden"
        and piece_default(piece, name) is None)
