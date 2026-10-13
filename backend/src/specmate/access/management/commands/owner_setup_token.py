from django.core.management.base import BaseCommand, CommandError

from specmate.access.operations import OWNER_TOKEN_LIFETIME, issue_owner_setup_token
from specmate.operations import Conflict


class Command(BaseCommand):
    help = "Issue a one-time installation owner setup token (only while no owner exists)."

    def handle(self, *args, **options):
        try:
            token, _ = issue_owner_setup_token()
        except Conflict as exc:
            raise CommandError(exc.message) from None
        minutes = int(OWNER_TOKEN_LIFETIME.total_seconds() // 60)
        self.stdout.write(f"Owner setup token (single use, expires in {minutes} minutes):")
        self.stdout.write(token)
