#!/usr/bin/env python3
"""Trusted checkout entry point for stdlib-only, offline selected-package verification."""

import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(
        str(
            Path(__file__).resolve().parents[1]
            / "backend/src/specmate/selected_packages/verification.py"
        ),
        run_name="__main__",
    )
