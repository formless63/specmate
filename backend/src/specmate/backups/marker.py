"""Restore-in-progress marker kept beside the artifact store.

A restore writes this file before it loads the database and removes it only after the
restored state has been fenced against side-effect replay and every byte is in place.
While it exists the schema is never reported ready, so neither the app nor the jobs
worker starts (and the worker never dispatches) against a partially restored state.
"""

from pathlib import Path

from django.conf import settings

NAME = "restore-in-progress.json"


def path() -> Path:
    return Path(settings.SPECMATE_ARTIFACT_ROOT) / NAME


def restore_in_progress() -> bool:
    try:
        return path().exists()
    except OSError:
        # An unreadable storage location cannot prove that no restore is under way.
        return True
