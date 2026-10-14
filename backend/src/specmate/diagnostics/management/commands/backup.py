"""Local operator console for product backup, verification and same-version restore."""

import json
import os
import sys
import tempfile
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from specmate.backups import bundle
from specmate.backups.service import BackupError, create_backup, restore_backup


def _read_input(value: str):
    return sys.stdin.buffer if value == "-" else open(value, "rb")


class Command(BaseCommand):
    help = (
        "create: write one consistent bundle (database snapshot, all artifact bytes, recipe "
        "registry and installation secrets). verify: check a bundle. restore: load a bundle "
        "into an EMPTY same-version target, which then starts in maintenance with execution "
        "disabled. Bundles contain secrets; store them privately."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        create = sub.add_parser("create", help="Write a backup bundle.")
        create.add_argument("--output", required=True, help="Bundle path, or - for stdout.")
        secrets = create.add_mutually_exclusive_group(required=True)
        secrets.add_argument(
            "--secrets-env",
            help="Installation environment file to include (path, or - for stdin).",
        )
        secrets.add_argument(
            "--without-secrets",
            action="store_true",
            help="Record that secrets are kept elsewhere; the bundle alone cannot recreate it.",
        )
        create.add_argument(
            "--allow-active-work",
            action="store_true",
            help="Back up while builds are unfinished; a restore cancels or interrupts them.",
        )
        create.add_argument("--work-dir", type=Path, help="Temporary directory for the dump.")
        for name in ("verify", "restore"):
            p = sub.add_parser(name)
            p.add_argument("--input", required=True, help="Bundle path, or - for stdin.")
            p.add_argument("--staging", type=Path, help="Directory for the verified copy.")

    def handle(self, *args, **options):
        try:
            action = options["action"]
            if action == "create":
                result = self._create(options)
            elif action == "verify":
                with (
                    tempfile.TemporaryDirectory(dir=options["staging"]) as tmp,
                    _read_input(options["input"]) as stream,
                ):
                    result = bundle.summary(bundle.read_bundle(stream, Path(tmp) / "bundle"))
            else:
                with _read_input(options["input"]) as stream:
                    result = restore_backup(stream, staging_parent=options["staging"])
        except (BackupError, bundle.BundleError) as exc:
            raise CommandError(str(exc)) from None
        # Bundles may be written to stdout, so reports always go to stderr.
        self.stderr.write(json.dumps(result, indent=2, sort_keys=True))

    def _create(self, options):
        secrets = None
        if options["secrets_env"]:
            with _read_input(options["secrets_env"]) as stream:
                secrets = stream.read()
            if not secrets.strip():
                raise CommandError("The secrets environment file is empty.")
        common = {
            "secrets_env": secrets,
            "allow_active_work": options["allow_active_work"],
            "work_dir": options["work_dir"],
        }
        if options["output"] == "-":
            manifest = create_backup(sys.stdout.buffer, **common)
            sys.stdout.buffer.flush()
        else:
            target = Path(options["output"])
            partial = target.with_name(target.name + ".partial")
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as out:
                    manifest = create_backup(out, **common)
                    out.flush()
                    os.fsync(out.fileno())
                if target.exists():
                    raise CommandError(f"{target} already exists; it is never overwritten.")
                os.replace(partial, target)
            finally:
                partial.unlink(missing_ok=True)
        return {
            "backup_id": manifest["backup_id"],
            "created_at": manifest["created_at"],
            "installation_id": manifest["installation_id"],
            "files": len(manifest["files"]),
            "artifacts": manifest["artifacts"],
            "work_at_backup": manifest["work_at_backup"],
            "secrets_included": manifest["secrets"]["included"],
        }
