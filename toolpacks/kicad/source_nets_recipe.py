#!/usr/bin/env python3
"""Print a source-net extraction recipe for operator review; never install it."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend/src"))

from specmate.pcb_disagreement.pack import recipe_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_path")
    parser.add_argument(
        "--source-role", required=True, choices=("schematic", "netlist")
    )
    parser.add_argument("--rights", required=True)
    args = parser.parse_args()
    try:
        recipe = recipe_for(args.source_path, args.rights, args.source_role)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps({recipe["id"]: recipe}, indent=2))


if __name__ == "__main__":
    main()
