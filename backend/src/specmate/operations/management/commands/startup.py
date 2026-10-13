from django.core.management.base import BaseCommand, CommandError

from specmate.operations.startup import initialize


class Command(BaseCommand):
    help = "Apply approved migrations under a lock, or wait read-only for schema readiness."

    def add_arguments(self, parser):
        parser.add_argument("--check", action="store_true", help="Read-only readiness check.")
        parser.add_argument("--timeout", type=float, default=120)

    def handle(self, *args, **options):
        if options["timeout"] < 0:
            raise CommandError("--timeout must be nonnegative.")
        initialize(timeout=options["timeout"], check_only=options["check"], stdout=self.stdout)
        self.stdout.write("Application schema ready.")
