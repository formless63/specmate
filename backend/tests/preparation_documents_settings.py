"""Isolated new-module verification before the integration owner mounts the app."""

from tests.settings import *  # noqa: F403

INSTALLED_APPS = [*INSTALLED_APPS, "specmate.preparation_documents"]  # noqa: F405
