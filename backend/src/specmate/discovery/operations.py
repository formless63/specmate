"""Discovery is a fresh, side-effect-free evaluation shared by every transport."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from specmate.discovery.service import describe
from specmate.operations import Context, operation


class Capabilities(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The workspace whose role is evaluated; a project id selects its workspace and is
    # echoed as navigation context only.
    workspace_id: UUID | None = None
    project_id: UUID | None = None
    include_schemas: bool = False


@operation(
    "discovery.capabilities",
    Capabilities,
    summary="List this instance's operations and which the current actor may call in a workspace.",
    supports_idempotency=False,
)
def capabilities(ctx: Context, p: Capabilities) -> dict:
    return describe(ctx, p.workspace_id, p.project_id, p.include_schemas)
