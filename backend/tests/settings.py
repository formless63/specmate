"""Test settings: the development profile against a real PostgreSQL (SPECMATE_DB_*)."""

import os

os.environ.setdefault("SPECMATE_ENVIRONMENT", "development")

from specmate.settings import *  # noqa: F403
