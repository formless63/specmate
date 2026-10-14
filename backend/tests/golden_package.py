"""Deterministic ids and a plain summary of a package, so a golden copy can pin exact bytes."""

import hashlib
import itertools
import uuid

import pytest
from django.apps import apps
from django.db import models


@pytest.fixture
def sequential_ids(monkeypatch):
    """Make every generated UUID (model defaults and direct uuid4 calls) a per-test counter.

    Ids feed manifest hashes and sort orders, so without this no byte-exact golden is possible.
    """
    counter = itertools.count(1)

    def next_id():
        return uuid.UUID(int=next(counter))

    for model in apps.get_models():
        for field in model._meta.local_fields:
            if isinstance(field, models.UUIDField) and field.default is uuid.uuid4:
                monkeypatch.setattr(field, "default", next_id)
                field.__dict__.pop("_get_default", None)
    monkeypatch.setattr(uuid, "uuid4", next_id)  # ids minted directly by operations
    yield
    for model in apps.get_models():
        for field in model._meta.local_fields:
            field.__dict__.pop("_get_default", None)


def summarise(files):
    """Exact bytes of the manifest and review page, plus a SHA-256 for every other file."""
    return {
        "manifest.json": files["manifest.json"].decode(),
        "review.html": files["review.html"].decode(),
        "sha256": {
            path: hashlib.sha256(data).hexdigest()
            for path, data in sorted(files.items())
            if path not in {"manifest.json", "review.html"}
        },
    }
