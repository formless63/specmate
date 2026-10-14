"""Operator-approved, digest-pinned single-stage recipes. No client command strings."""

from typing import Literal

from django.conf import settings
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic import ValidationError as PydanticValidationError

from specmate.builds.tools import tool_for_image
from specmate.contracts import IDENT, check_file_tree, check_package_path
from specmate.operations import Unsupported, ValidationFailed

# Current native-runner capability envelope. Source storage can support larger
# bundles, but this runner cannot accept them as one execution stage.
MAX_FILES = 512
MAX_FILE_BYTES = 64 * 1024**2
MAX_INPUT_BYTES = 256 * 1024**2


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


class ToolNotEnabled(Unsupported):
    """The recipe's image is a catalog tool the operator has not enabled."""


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
    enabled = settings.SPECMATE_ENABLED_TOOLS
    if enabled is not None:
        tool = tool_for_image(recipe.image)
        if tool is not None and tool["id"] not in enabled:
            raise ToolNotEnabled(f"Tool {tool['id']} is not enabled on this installation.")
    return recipe
