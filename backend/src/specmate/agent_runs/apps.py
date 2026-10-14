from django.apps import AppConfig


class AgentRunsConfig(AppConfig):
    name = "specmate.agent_runs"
    label = "agent_runs"

    def ready(self):
        from specmate.agent_runs import capture, operations  # noqa: F401
        from specmate.agent_runs.contracts import ActInRun, CreateRun
        from specmate.contracts import SCHEMAS

        capture.connect()
        SCHEMAS.update({"agent-run-create": CreateRun, "agent-run-act": ActInRun})
