"""Local operator console for diagnostics, safe stop, resume and reconciliation."""

import json
import uuid

from django.core.management.base import BaseCommand, CommandError

from specmate.access.models import Installation
from specmate.operations import Context, OperationError, execute


class Command(BaseCommand):
    help = (
        "Show diagnostics, or drain/interrupt/resume work and reconcile expired stages. "
        "This never stops containers and never restarts interrupted work."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "action", choices=["diagnose", "drain", "interrupt", "resume", "reconcile"]
        )
        parser.add_argument("--reason", default="operator request")

    def handle(self, *args, **options):
        installation = Installation.objects.select_related("owner").filter(singleton=True).first()
        if installation is None or installation.owner is None:
            raise CommandError("Claim the installation owner before using work control.")
        action = options["action"]
        request_id = str(uuid.uuid4())

        def run(name, payload=None, expected_state=None):
            ctx = Context(
                user=installation.owner,
                via="internal",
                request_id=request_id,
                expected_state=expected_state,
            )
            try:
                return execute(name, ctx, payload or {}).result
            except OperationError as exc:
                raise CommandError(exc.message) from None

        if action == "diagnose":
            result = run("diagnostics.installation")
        elif action == "reconcile":
            result = run("installation.reconcile")
        else:
            token = run("diagnostics.installation")["work"]["state_token"]
            if action == "resume":
                result = run("installation.resume", expected_state=token)
            else:
                payload = {"mode": action, "reason": options["reason"]}
                result = run("installation.safe_stop", payload, expected_state=token)
        self.stdout.write(json.dumps(result, indent=2, sort_keys=True))
