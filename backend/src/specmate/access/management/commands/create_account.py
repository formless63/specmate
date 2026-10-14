"""Operator command: create a local account with a workspace role."""

import secrets
import sys

from django.core.management.base import BaseCommand, CommandError

from specmate.access.operations import provision_account
from specmate.operations import OperationError


class Command(BaseCommand):
    help = (
        "Create a local account and give it a workspace role. The first account on an "
        "installation without an owner becomes the installation owner (role admin). The "
        "password is generated and printed once, or read from stdin with --password-stdin."
    )

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument(
            "--role", required=True, choices=["viewer", "contributor", "editor", "admin"]
        )
        parser.add_argument("--password-stdin", action="store_true")

    def handle(self, *args, **options):
        generated = not options["password_stdin"]
        if generated:
            password = secrets.token_urlsafe(18)
        else:
            password = sys.stdin.readline().rstrip("\r\n")
            if not password:
                raise CommandError("No password was provided on stdin.")
        try:
            result = provision_account(options["username"], password, options["role"])
        except OperationError as exc:
            raise CommandError(exc.message) from None
        self.stdout.write(f"Created {result['username']} as {result['role']}.")
        if generated:
            self.stdout.write(f"Generated password (shown once): {password}")
