"""Shared physical wiring addresses, independent of product classification."""

from typing import Annotated
from uuid import UUID

from pydantic import Field

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.interfaces.contracts import Text

CONNECTOR_LAYER = "connector"

ElementPath = Annotated[
    str, Field(min_length=1, max_length=1000, pattern=r"^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$")
]


class Endpoint(StrictModel):
    """A schema 0.1 cable end (and a harness end): one connector body and pinout."""

    local_id: LocalId
    label: Text | None = None
    body_revision_id: UUID
    pinout_revision_id: UUID
