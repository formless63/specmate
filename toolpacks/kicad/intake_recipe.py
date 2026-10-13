#!/usr/bin/env python3
"""Write one recipe for operator review; this does not enable or execute it."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend/src"))

from specmate.contracts import check_package_path
from specmate.pcb.pack import recipe_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("board_path", help="Exact relative board path in the source bundle")
    parser.add_argument("--rights", required=True, help="Rights declared by every source file")
    args = parser.parse_args()
    path = check_package_path(args.board_path)
    if not path.lower().endswith(".kicad_pcb") or not 1 <= len(args.rights) <= 200:
        parser.error("Expected .kicad_pcb path and 1-200 character rights declaration")
    recipe = recipe_for(path, args.rights)
    print(json.dumps({recipe["id"]: recipe}, indent=2))


if __name__ == "__main__":
    main()
