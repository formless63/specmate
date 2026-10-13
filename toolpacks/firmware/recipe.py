#!/usr/bin/env python3
"""Generate operator-reviewable exact recipes; does not approve or execute anything."""

import argparse
import json

from specmate.firmware_builds.pack import recipe_for

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("inputs", help="Exact authorized options.inputs JSON file")
parser.add_argument("--image", required=True, help="Verified installed image@sha256 digest")
args = parser.parse_args()
with open(args.inputs) as stream:
    spec = json.load(stream)
print(json.dumps(recipe_for(spec, args.image), indent=2))
