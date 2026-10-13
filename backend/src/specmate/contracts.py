"""Authoritative v0 boundary contracts. JSON Schema is generated from these models
(`manage.py export_contract_schemas`) and checked against contracts/examples."""

from __future__ import annotations

import unicodedata
from pathlib import PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "0.1"
SHA256 = r"^[0-9a-f]{64}$"
IDENT = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"


class OperationEnvelope(BaseModel):
    """Transport-neutral command request. Actor and scope are derived by the server,
    never read from this envelope."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["0.1"] = SCHEMA_VERSION
    synthetic: bool = False
    operation: str = Field(pattern=r"^[a-z][a-z_]*(\.[a-z][a-z_]*)+$", max_length=100)
    request_id: str = Field(pattern=IDENT)
    idempotency_key: str | None = Field(default=None, pattern=IDENT)
    expected_state: str | None = Field(default=None, max_length=128)
    payload: dict[str, Any] = Field(default_factory=dict)


def check_package_path(value: str) -> str:
    """Portable package-relative path: no traversal, absolute, drive, control or
    backslash components, already normalized."""
    if not value or len(value) > 512 or value != unicodedata.normalize("NFC", value):
        raise ValueError("path must be non-empty, NFC-normalized and at most 512 characters")
    if any(ord(c) < 32 or c in '\\:*?"<>|' or ord(c) == 127 for c in value):
        raise ValueError("path contains a forbidden character")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(p in ("", ".", "..") for p in path.parts):
        raise ValueError("path must be relative and normalized without '.' or '..'")
    return value


class SourceBundleFileEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    sha256: str = Field(pattern=SHA256)
    bytes: int = Field(ge=0)
    media_type: str = Field(min_length=1, max_length=200)
    rights: str = Field(min_length=1, max_length=200)

    @field_validator("path")
    @classmethod
    def portable_path(cls, value: str) -> str:
        return check_package_path(value)


class SourceBundleManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["0.1"] = SCHEMA_VERSION
    synthetic: bool = False
    bundle_id: str = Field(pattern=IDENT)
    source_revision: str = Field(pattern=IDENT)
    ancestry: list[str] = Field(default_factory=list)
    files: list[SourceBundleFileEntry] = Field(min_length=1, max_length=10000)

    @model_validator(mode="after")
    def unique_paths(self) -> SourceBundleManifest:
        folded = [f.path.casefold() for f in self.files]
        if len(set(folded)) != len(folded):
            raise ValueError("file paths must be unique, ignoring case")
        return self


SCHEMAS: dict[str, type[BaseModel]] = {
    "operation-envelope": OperationEnvelope,
    "source-bundle-manifest": SourceBundleManifest,
}
