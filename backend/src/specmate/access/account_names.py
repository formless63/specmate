"""Validate the stored Unicode-normalized local account name before database writes."""

import unicodedata
from typing import Annotated

from pydantic import BeforeValidator, Field


def normalize(value):
    return unicodedata.normalize("NFKC", value) if isinstance(value, str) else value


LocalUsername = Annotated[
    str,
    BeforeValidator(normalize),
    Field(min_length=1, max_length=150, pattern=r"^[\w.@+-]+$"),
]
