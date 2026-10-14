"""Reference file adapter: CSV/JSON text in, CSV/JSON text out. No network, no secrets.

Parsing uses the standard library ``csv`` and ``json`` modules. Blank cells and JSON nulls
are unknown (``None``); they are never coerced to zero or defaulted.
"""

import csv
import io
import json
from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from specmate.inventory.contracts import UNITS, Amount, Unit
from specmate.operations import ValidationFailed

MAX_ROWS = 5000

IMPORT_COLUMNS = {
    "supplier_offer": [
        "revision_id",
        "scheme",
        "identifier",
        "supplier",
        "supplier_ref",
        "offered_on",
        "valid_until",
        "price_amount",
        "price_currency",
        "price_unit",
        "availability",
        "lead_time_days",
    ],
    "stock_observation": [
        "revision_id",
        "scheme",
        "identifier",
        "external_ref",
        "observed_on",
        "quantity_amount",
        "quantity_unit",
        "location_label",
    ],
}
EXPORT_COLUMNS = [
    "revision_id",
    "unit",
    "required_amount",
    "net_amount",
    "waste_status",
    "origin_kind",
    "origin_address",
]


def _blank_is_unknown(value):
    if isinstance(value, str) and not value.strip():
        return None
    return value


class _Row(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    # Exactly one way to name the item: an exact revision id, or a registered source
    # identifier (scheme + identifier) resolved within the workspace.
    revision_id: UUID | None = None
    scheme: str | None = None
    identifier: str | None = None

    @field_validator("*", mode="before")
    @classmethod
    def blank(cls, value):
        return _blank_is_unknown(value)

    @model_validator(mode="after")
    def names_one_item(self):
        by_id = self.revision_id is not None
        by_source = self.scheme is not None or self.identifier is not None
        if by_id == by_source:
            raise ValueError("Give either revision_id or both scheme and identifier.")
        if by_source and (self.scheme is None or self.identifier is None):
            raise ValueError("scheme and identifier must be given together.")
        return self


class OfferRow(_Row):
    supplier: str
    supplier_ref: str | None = None
    offered_on: date
    valid_until: date | None = None
    price_amount: Amount | None = None
    price_currency: str | None = None
    price_unit: Unit | None = None
    availability: Literal["in_stock", "limited", "unavailable", "unknown"] | None = None
    lead_time_days: int | None = None

    @field_validator("lead_time_days", mode="before")
    @classmethod
    def integer_days(cls, value):
        if value is None:
            return None
        text = str(value)
        if not text.isdigit() or int(text) > 3650:
            raise ValueError("Lead time must be a whole number of days.")
        return int(text)

    @model_validator(mode="after")
    def coherent(self):
        if self.price_amount is not None and self.price_amount < 0:
            raise ValueError("A price cannot be negative.")
        if self.price_currency is not None and not (
            len(self.price_currency) == 3 and self.price_currency.isupper()
        ):
            raise ValueError("Currency must be a three-letter uppercase code.")
        if self.valid_until is not None and self.valid_until < self.offered_on:
            raise ValueError("An offer cannot expire before it was made.")
        if self.offered_on > date.today():
            raise ValueError("An offer cannot be dated in the future.")
        return self


class StockRow(_Row):
    external_ref: str | None = None
    observed_on: date
    quantity_amount: Amount
    quantity_unit: Unit
    location_label: str | None = None

    @model_validator(mode="after")
    def coherent(self):
        if self.quantity_amount < 0:
            raise ValueError("A quantity cannot be negative.")
        if self.quantity_unit not in UNITS:
            raise ValueError("Unknown unit.")
        if self.observed_on > date.today():
            raise ValueError("An observation cannot be dated in the future.")
        return self


ROW_MODELS = {"supplier_offer": OfferRow, "stock_observation": StockRow}


def _text(value):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("Booleans are not valid cell values.")
    if isinstance(value, float):
        raise ValueError("Use strings for decimal numbers in JSON files.")
    return str(value)


def read_rows(content: str, file_format: str, columns: dict[str, str]) -> list[dict]:
    """Return raw rows keyed by canonical column names."""
    rename = {external: canonical for canonical, external in columns.items()}
    if file_format == "csv":
        reader = csv.DictReader(io.StringIO(content, newline=""))
        raw = list(reader)
    else:
        try:
            body = json.loads(content, parse_float=Decimal)
        except json.JSONDecodeError:
            raise ValidationFailed("The file is not valid JSON.") from None
        raw = body.get("rows") if isinstance(body, dict) else body
        if not isinstance(raw, list) or not all(isinstance(r, dict) for r in raw):
            raise ValidationFailed("JSON files must be a list of row objects.")
    if len(raw) > MAX_ROWS:
        raise ValidationFailed(f"A file may carry at most {MAX_ROWS} rows.")
    rows = []
    for item in raw:
        row = {}
        for key, value in item.items():
            if key is None:  # CSV row longer than its header
                continue
            if isinstance(value, Decimal):
                value = format(value, "f")
            row[rename.get(key, key)] = value
        rows.append(row)
    return rows


def validate_row(field: str, raw: dict):
    """Return (validated model, None) or (None, reason)."""
    allowed = set(IMPORT_COLUMNS[field])
    try:
        cleaned = {k: _text(v) for k, v in raw.items() if k in allowed}
        return ROW_MODELS[field].model_validate(cleaned), None
    except (ValidationError, ValueError) as exc:
        if isinstance(exc, ValidationError):
            first = exc.errors()[0]
            loc = ".".join(str(p) for p in first["loc"]) or "row"
            return None, f"{loc}: {first['msg']}"
        return None, str(exc)


def write_rows(rows: list[dict], file_format: str, columns: dict[str, str]) -> str:
    names = {c: columns.get(c, c) for c in EXPORT_COLUMNS}
    if file_format == "json":
        return json.dumps(
            {"rows": [{names[c]: r[c] for c in EXPORT_COLUMNS} for r in rows]},
            indent=2,
            sort_keys=True,
        )
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow([names[c] for c in EXPORT_COLUMNS])
    for row in rows:
        # Spreadsheet formula injection: neutralize cells that start with a formula marker.
        writer.writerow(["" if row[c] is None else _safe(str(row[c])) for c in EXPORT_COLUMNS])
    return out.getvalue()


def _safe(text: str) -> str:
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text
