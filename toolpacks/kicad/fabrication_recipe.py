#!/usr/bin/env python3
"""Print an exact recipe for operator review; never install or enable it."""

import argparse
import json

from specmate.builds.recipes import Recipe
from specmate.pcb_fabrication.pack import recipe_for

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("board_path")
parser.add_argument("--rights", required=True)
args = parser.parse_args()
recipe = Recipe.model_validate(recipe_for(args.board_path, args.rights))
print(json.dumps(recipe.model_dump(mode="json"), indent=2))
