"""Compact saved-state Library rows; numbering and compatibility are not inferred."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from specmate.workspace.contracts import LibraryPage, LibraryRecord, ListLibrary


class ListLibraryTable(ListLibrary):
    family: Literal["definition"] = "definition"
    catalog_class: Literal["parts", "hardware", "kits"] | None = None


class LibraryNumber(BaseModel):
    manufacturer: str
    value: str
    basis: Literal["manufacturer_variant"] = "manufacturer_variant"


class LibraryField(BaseModel):
    key: str
    label: str
    value: str | int | float | None = None
    unit: str | None = None


class LibrarySummary(BaseModel):
    basis: Literal["latest_frozen", "newest_draft", "unknown"]
    revision_id: UUID | None = None
    draft_id: UUID | None = None
    draft_version: int | None = None
    numbers: list[LibraryNumber] = Field(default_factory=list, max_length=20)
    numbers_truncated: bool = False
    fields: list[LibraryField] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)


class LibraryTableRecord(LibraryRecord):
    summary: LibrarySummary


class LibraryTablePage(LibraryPage):
    results: list[LibraryTableRecord]
