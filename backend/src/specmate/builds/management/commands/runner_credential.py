"""Issue/revoke scoped runner authority from the installation's local operator shell."""

import json
import uuid

from django.core.management.base import BaseCommand, CommandError

from specmate.access.models import Installation
from specmate.operations import Context, OperationError, execute


class Command(BaseCommand):
    help = "Issue a scoped runner token (shown once), or revoke an existing credential."

    def add_arguments(self, parser):
        parser.add_argument("--project")
        parser.add_argument("--name", default="local-runner")
        parser.add_argument("--recipe", action="append", default=[])
        parser.add_argument("--hours", type=int, default=24)
        parser.add_argument("--revoke")

    def handle(self, *args, **options):
        installation = Installation.objects.select_related("owner").filter(singleton=True).first()
        if installation is None or installation.owner is None:
            raise CommandError("Claim the installation owner before enrolling a runner.")
        ctx = Context(user=installation.owner, via="internal", request_id=str(uuid.uuid4()))
        if options["revoke"]:
            name, payload = "runner.revoke", {"credential_id": options["revoke"]}
        elif options["project"] and options["recipe"]:
            name, payload = (
                "runner.enroll",
                {
                    "project_id": options["project"],
                    "name": options["name"],
                    "recipe_ids": options["recipe"],
                    "lifetime_hours": options["hours"],
                },
            )
        else:
            raise CommandError("Supply --project and at least one --recipe, or --revoke.")
        try:
            result = execute(name, ctx, payload)
        except OperationError as exc:
            raise CommandError(exc.message) from None
        self.stdout.write(json.dumps(result.result))
