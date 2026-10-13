"""Operator-approved, digest-pinned single-stage recipes. No client command strings."""

from pathlib import PurePosixPath
from typing import Literal

from django.conf import settings
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic import ValidationError as PydanticValidationError

from specmate.contracts import IDENT, check_package_path
from specmate.operations import Unsupported, ValidationFailed

# Current native-runner capability envelope. Source storage can support larger
# bundles, but this runner cannot accept them as one execution stage.
MAX_FILES = 512
MAX_FILE_BYTES = 64 * 1024**2
MAX_INPUT_BYTES = 256 * 1024**2


def check_file_tree(paths: list[str], *, max_depth: int | None = None) -> None:
    normalized = [check_package_path(path).casefold() for path in paths]
    unique = set(normalized)
    if len(unique) != len(normalized):
        raise ValueError("file paths must be unique, ignoring case")
    for path in unique:
        pure = PurePosixPath(path)
        if max_depth is not None and len(pure.parts) > max_depth:
            raise ValueError("output paths exceed the runner's directory nesting limit")
        if any(str(parent) in unique for parent in pure.parents):
            raise ValueError("file paths contain a file/directory collision")


class Limits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cpus: float = Field(ge=0.1, le=32)
    memory_bytes: int = Field(ge=16 * 1024 * 1024, le=64 * 1024**3)
    timeout_seconds: int = Field(ge=1, le=86400)
    pids: int = Field(ge=1, le=1024)
    max_output_bytes: int = Field(ge=1, le=MAX_FILE_BYTES)


class OutputSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    media_type: str = Field(min_length=1, max_length=200)
    rights: str = Field(min_length=1, max_length=200)

    @field_validator("path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value)


class Recipe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=IDENT)
    image: str = Field(pattern=r"^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$")
    argv: list[str] = Field(min_length=1, max_length=100)
    input_mount: Literal["/inputs"] = "/inputs"
    output_mount: Literal["/outputs"] = "/outputs"
    network: Literal["none"] = "none"
    limits: Limits
    outputs: list[OutputSpec] = Field(max_length=MAX_FILES)

    @model_validator(mode="after")
    def valid_recipe(self):
        if self.image.endswith("0" * 64):
            raise ValueError("placeholder image digest is not executable")
        if any(not a or "\x00" in a or len(a) > 8192 for a in self.argv):
            raise ValueError("argv contains an invalid argument")
        if not self.argv[0].startswith("/"):
            raise ValueError("argv must start with an absolute executable path")
        check_file_tree([output.path for output in self.outputs], max_depth=32)
        return self


def approved_recipe(recipe_id: str) -> Recipe:
    raw = settings.SPECMATE_APPROVED_RECIPES.get(recipe_id)
    if raw is None:
        raise Unsupported("Recipe is not approved on this installation.")
    try:
        recipe = Recipe.model_validate(raw)
    except PydanticValidationError:
        raise ValidationFailed("Approved recipe configuration is invalid.") from None
    if recipe.id != recipe_id:
        raise ValidationFailed("Approved recipe identifier does not match registry key.")
    return recipe
