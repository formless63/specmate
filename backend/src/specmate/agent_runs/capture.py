"""Record-level change capture while one agent run step executes.

Model ``save()`` and ``delete()`` calls made by the inner operation are observed through
Django signals and stored with their exact before/after field values. Bulk queryset
writes (``update()``, ``bulk_create()``) do not emit these signals; the step keeps the
operation, payload and result in every case, and the review package says so.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models.signals import post_delete, post_save, pre_delete, pre_save

# Bookkeeping models whose writes are not engineering changes of the step.
IGNORED = frozenset({"agent_runs.agentrun", "agent_runs.agentrunstep", "sessions.session"})
MAX_RECORDS = 200


def label(model) -> str:
    return model._meta.label_lower


def record_ref(model, pk) -> str:
    return f"{label(model)}:{pk}"


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        data = bytes(value)
        return {"bytes_sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    if isinstance(value, dict):
        return {str(k): json_value(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [json_value(v) for v in value]
    return {"repr_b64": base64.b64encode(repr(value).encode()).decode()}


def fields_of(instance) -> dict[str, Any]:
    return {
        f.attname: json_value(getattr(instance, f.attname)) for f in instance._meta.concrete_fields
    }


def stored_fields(model, pk) -> dict[str, Any] | None:
    row = (
        model._base_manager.filter(pk=pk)
        .values(*[f.attname for f in model._meta.concrete_fields])
        .first()
    )
    return None if row is None else {k: json_value(v) for k, v in row.items()}


@dataclass
class Recorder:
    entries: dict[str, dict] = field(default_factory=dict)
    truncated: bool = False

    def entry(self, model, pk) -> dict | None:
        ref = record_ref(model, pk)
        if ref not in self.entries:
            if len(self.entries) >= MAX_RECORDS:
                self.truncated = True
                return None
            self.entries[ref] = {"record": ref, "model": label(model), "pk": str(pk)}
        return self.entries[ref]

    def changes(self) -> list[dict]:
        out = []
        for entry in self.entries.values():
            before, after = entry.get("before"), entry.get("after")
            if before is None and after is None:
                continue
            action = "created" if before is None else "deleted" if after is None else "updated"
            changed = sorted(
                key
                for key in set(before or {}) | set(after or {})
                if (before or {}).get(key) != (after or {}).get(key)
            )
            if action == "updated" and not changed:
                continue
            out.append({**entry, "action": action, "changed_fields": changed})
        return out


_active: ContextVar[Recorder | None] = ContextVar("specmate_agent_capture", default=None)


@contextmanager
def capture() -> Iterator[Recorder]:
    recorder = Recorder()
    token = _active.set(recorder)
    try:
        yield recorder
    finally:
        _active.reset(token)


def _recorder(sender) -> Recorder | None:
    recorder = _active.get()
    if recorder is None or sender._meta.label_lower in IGNORED:
        return None
    return recorder


def _pre_save(sender, instance, raw=False, **kwargs):
    recorder = _recorder(sender)
    if recorder is None or raw:
        return
    if instance._state.adding or instance.pk is None:
        return
    entry = recorder.entry(sender, instance.pk)
    if entry is not None and "before" not in entry:
        entry["before"] = stored_fields(sender, instance.pk)


def _post_save(sender, instance, created=False, raw=False, **kwargs):
    recorder = _recorder(sender)
    if recorder is None or raw:
        return
    entry = recorder.entry(sender, instance.pk)
    if entry is None:
        return
    if created and "before" not in entry:
        entry["before"] = None
    entry["after"] = fields_of(instance)


def _pre_delete(sender, instance, **kwargs):
    recorder = _recorder(sender)
    if recorder is None:
        return
    entry = recorder.entry(sender, instance.pk)
    if entry is not None and "before" not in entry:
        entry["before"] = stored_fields(sender, instance.pk)


def _post_delete(sender, instance, **kwargs):
    recorder = _recorder(sender)
    if recorder is None:
        return
    entry = recorder.entry(sender, instance.pk)
    if entry is not None:
        entry["after"] = None


def connect() -> None:
    pre_save.connect(_pre_save, dispatch_uid="agent_runs_pre_save")
    post_save.connect(_post_save, dispatch_uid="agent_runs_post_save")
    pre_delete.connect(_pre_delete, dispatch_uid="agent_runs_pre_delete")
    post_delete.connect(_post_delete, dispatch_uid="agent_runs_post_delete")
