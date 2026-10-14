"""Populate a freshly reset disposable installation with clearly synthetic demo data."""

import os

from django.core.management.base import BaseCommand, CommandError

from specmate.operations import demo_seed, disposable


class Command(BaseCommand):
    help = (
        "Create synthetic demo data through the application's own operations so every page "
        "has content. Allowed only on an installation carrying a verified disposable marker, "
        "or with --allow on an empty development database. Creates no accounts: it acts as an "
        "existing admin (the installation owner by default). Refuses if already seeded."
    )

    def add_arguments(self, parser):
        parser.add_argument("--marker", help="Marker path (default SPECMATE_DISPOSABLE_MARKER).")
        parser.add_argument("--allow", action="store_true", help="Seed an empty dev database.")
        parser.add_argument("--username", help="Existing admin member to act as.")

    def handle(self, *args, **options):
        marker = options["marker"] or os.environ.get("SPECMATE_DISPOSABLE_MARKER")
        try:
            if marker:
                disposable.verify(marker)
            elif not options["allow"]:
                raise demo_seed.SeedRefused(
                    "No disposable marker is configured; pass --allow only for an empty "
                    "development database."
                )
            user, workspace = demo_seed.acting_user(options["username"])
            if not marker:
                demo_seed.refuse_unless_empty(workspace)
            created = demo_seed.seed(user, workspace)
        except (demo_seed.SeedRefused, disposable.ResetRefused) as exc:
            raise CommandError(f"Seed refused: {exc}") from None
        summary = ", ".join(f"{count} {what}" for what, count in created.items())
        self.stdout.write(f"Seeded synthetic demo data as {user.get_username()}: {summary}.")
