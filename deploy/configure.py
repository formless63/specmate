"""Create a private installation environment once, without overwriting existing secrets."""

import argparse
import os
import secrets
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    text = (source / ".env.example").read_text()
    text = text.replace("SPECMATE_SOURCE_DIR=.\n", f"SPECMATE_SOURCE_DIR={source}\n")
    text = text.replace(
        "SPECMATE_RUNNER_HOST_STATE_DIR=\n",
        f"SPECMATE_RUNNER_HOST_STATE_DIR={args.output.resolve().parent / 'runner-state'}\n",
    )
    for name in (
        "SPECMATE_SECRET_KEY",
        "POSTGRES_PASSWORD",
        "SPECMATE_DB_PASSWORD",
        "TEMPORAL_DB_PASSWORD",
        "TEMPORAL_VISIBILITY_DB_PASSWORD",
    ):
        text = text.replace(f"{name}=\n", f"{name}={secrets.token_urlsafe(48)}\n")
    # O_EXCL prevents even an accidental rerun from replacing live credentials.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(text)
    recipes = args.output.parent / "recipes.json"
    if not recipes.exists():
        # This file contains approved public recipe manifests, not credentials. The
        # application container's unprivileged user needs read access through its mount.
        with recipes.open("x") as output:
            output.write("{}\n")
        recipes.chmod(0o644)
    print(
        f"Created {args.output}; keep this file private and retain it across restarts."
    )


if __name__ == "__main__":
    main()
