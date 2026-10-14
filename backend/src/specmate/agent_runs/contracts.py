"""Payloads of the agent run operations (contracts/schema/agent-run-*.json)."""

from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue

OPERATION = r"^[a-z][a-z_]*(\.[a-z][a-z_]*)+$"
STEP_KEY = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
MAX_ACTIONS = 1000


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateRun(_Strict):
    """Grant an agent account a bounded, draft-level scope on the sponsor's behalf."""

    workspace_id: UUID
    project_id: UUID | None = None
    title: str = Field(min_length=1, max_length=200)
    purpose: str = Field(default="", max_length=4000)
    # Workspace member that calls agent_run.act; defaults to the sponsor's own account.
    agent_username: str | None = Field(default=None, min_length=1, max_length=150)
    allowed_actions: list[str] = Field(min_length=1, max_length=100)
    # Execution/release/inventory/freeze operations, each granted explicitly.
    boundary_actions: list[str] = Field(default_factory=list, max_length=20)
    max_actions: int = Field(ge=1, le=MAX_ACTIONS)
    deadline: AwareDatetime
    checkpoint_every: int | None = Field(default=None, ge=1, le=MAX_ACTIONS)


class RunRef(_Strict):
    run_id: UUID


class ActInRun(_Strict):
    """One operation call inside a run. ``step_key`` makes it safe to retry or resume."""

    run_id: UUID
    step_key: str = Field(pattern=STEP_KEY)
    operation: str = Field(pattern=OPERATION, max_length=100)
    payload: dict[str, JsonValue] = Field(default_factory=dict)
    # Expected state of the target record, passed to the inner operation unchanged.
    expected_state: str | None = Field(default=None, max_length=128)
    # Idempotency key for the inner operation. Without one, a key is derived from the run
    # and step_key, so the step's effect is stable across retries.
    idempotency_key: str | None = Field(default=None, pattern=STEP_KEY)
    note: str = Field(default="", max_length=2000)


class ProposeInRun(_Strict):
    run_id: UUID
    summary: str = Field(min_length=1, max_length=4000)
    operation: str | None = Field(default=None, pattern=OPERATION, max_length=100)
    payload: dict[str, JsonValue] | None = None


class CheckpointRun(_Strict):
    run_id: UUID
    note: str = Field(min_length=1, max_length=4000)
    pause: bool = False


class StopRun(_Strict):
    run_id: UUID
    note: str = Field(default="", max_length=4000)


class ResumeRun(_Strict):
    run_id: UUID
    add_actions: int = Field(default=0, ge=0, le=MAX_ACTIONS)
    deadline: AwareDatetime | None = None
    grant_boundary_actions: list[str] = Field(default_factory=list, max_length=20)
    note: str = Field(default="", max_length=4000)


class ReviewRun(_Strict):
    run_id: UUID
    decision: Literal["accepted", "changes_requested", "rejected"]
    note: str = Field(default="", max_length=4000)


class RevertChange(_Strict):
    run_id: UUID
    step_id: UUID
    record: str = Field(min_length=1, max_length=200)  # "<app_label.model>:<pk>"


class ListRuns(_Strict):
    workspace_id: UUID
    project_id: UUID | None = None
    status: str | None = Field(default=None, max_length=20)
    limit: int = Field(default=50, ge=1, le=200)


class ReadRun(_Strict):
    run_id: UUID


__all__ = [
    "ActInRun",
    "CheckpointRun",
    "CreateRun",
    "ListRuns",
    "ProposeInRun",
    "ReadRun",
    "ResumeRun",
    "RevertChange",
    "ReviewRun",
    "RunRef",
    "StopRun",
]
