"""Reset a verified disposable pre-1.0 installation to the current baseline."""

from django.core.management.base import BaseCommand, CommandError

from specmate.operations import disposable


class Command(BaseCommand):
    help = (
        "Recreate the database baseline and clear the artifact root of a marked disposable "
        "installation. Refuses unknown targets. Never touches containers, volumes, Temporal "
        "or any path outside the marked artifact root."
    )

    def add_arguments(self, parser):
        parser.add_argument("--marker", help="Marker path (default SPECMATE_DISPOSABLE_MARKER).")
        parser.add_argument("--confirm", help="Must equal the marker installation ID.")
        parser.add_argument("--check", action="store_true", help="Verify only; change nothing.")

    def handle(self, *args, **options):
        try:
            verified = disposable.verify(options["marker"])
            if options["check"]:
                self.stdout.write(f"Verified disposable installation {verified.installation_id}.")
                return
            if options["confirm"] != str(verified.installation_id):
                raise disposable.ResetRefused("--confirm must equal the installation ID.")
            if verified.installation_row_exists:
                disposable.assert_quiescent()
            removed = disposable.clear_artifact_root(verified)
            disposable.reset_database(verified)
        except disposable.ResetRefused as exc:
            raise CommandError(f"Reset refused: {exc}") from None
        self.stdout.write(
            f"Reset {verified.database_name}; cleared {removed} artifact entries; "
            f"installation {verified.installation_id} retained."
        )
