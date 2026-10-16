"""Typed, exact source provenance embedded in immutable engineering content.

An origin is evidence of conversion, never executable instructions or an assertion
of design qualification. Frozen content owns the relation; no mutable side table can
silently change the source of an existing revision.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from specmate.operations import NotFound, ValidationFailed


class SourceOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    schema_version: Literal["0.1"] = "0.1"
    namespace: str = Field(min_length=1, max_length=100)
    record_key: str = Field(min_length=1, max_length=512)
    upstream_revision: str | None = Field(default=None, max_length=200)
    source_status: Literal["active", "development", "legacy", "retired", "unknown"] = "unknown"
    synthetic_example: bool = False
    converter: str = Field(min_length=1, max_length=200)
    source_bundle_revision_id: UUID
    source_path: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(
        min_length=1, max_length=512
    )
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    rights: str = Field(min_length=1, max_length=200)


class SourceOrigins(BaseModel):
    origins: list[SourceOrigin] = Field(max_length=256)


def parse(content):
    if "source_origins" not in content:
        return []
    try:
        origins = SourceOrigins(origins=content["source_origins"]).origins
    except ValidationError:
        raise ValidationFailed("Invalid source origins.") from None
    keys = [
        (o.namespace, o.record_key, o.upstream_revision, o.source_bundle_revision_id, o.source_path)
        for o in origins
    ]
    if len(keys) != len(set(keys)):
        raise ValidationFailed("Duplicate source origin.")
    return origins


def validate_content(content):
    if "source_origins" not in content:
        return content
    return {**content, "source_origins": [o.model_dump(mode="json") for o in parse(content)]}


def authorize_content(user, definition, content):
    from specmate.queries import get_bundle_revision

    origins = parse(content)
    # Resolve scope/authority before path/hash diagnostics, including dual members.
    revisions = {}
    for origin in origins:
        source = revisions.get(origin.source_bundle_revision_id)
        if source is None:
            source = get_bundle_revision(user, origin.source_bundle_revision_id)
            if source.bundle.workspace_id != definition.workspace_id:
                raise NotFound("Not found.")
            revisions[source.id] = source
    for origin in origins:
        source = revisions[origin.source_bundle_revision_id]
        file = source.files.select_related("blob").filter(path=origin.source_path).first()
        if file is None:
            raise NotFound("Source origin file not found.")
        if file.blob.sha256 != origin.sha256 or file.rights != origin.rights:
            raise ValidationFailed("Source origin hash or rights differ from the exact source.")
