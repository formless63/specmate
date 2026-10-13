#!/usr/bin/env python3
"""Check bootstrap structure and independent examples, not application behavior."""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
# Installed dependencies and build outputs are not repository guidance.
SKIP = {".git", "node_modules", ".venv", "dist", "build", ".pytest_cache", ".ruff_cache"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load(path: str) -> dict:
    result = json.loads((ROOT / path).read_text(encoding="utf-8"))
    require(isinstance(result, dict), f"Expected object: {path}")
    return result


def existing(path: str) -> None:
    target = ROOT / path
    require(target.resolve().is_relative_to(ROOT), f"Escaping reference: {path}")
    require(target.is_file(), f"Missing file: {path}")


def unique(rows: list[dict], label: str) -> dict:
    result = {}
    for row in rows:
        key = row.get("id")
        require(isinstance(key, str) and bool(key), f"Missing {label} ID")
        require(key not in result, f"Duplicate {label}: {key}")
        result[key] = row
    return result


def check_catalogs() -> tuple[int, int, int]:
    c = load("spec/capabilities.json")
    a = load("spec/acceptance.json")
    groups = unique(c["groups"], "group")
    caps = unique(c["capabilities"], "capability")
    scenarios = unique(a["scenarios"], "acceptance")
    journeys = unique(a["journeys"], "journey")
    covered: set[str] = set()
    for cid, row in caps.items():
        require(row["group"] in groups, f"Unknown group: {cid}")
        require(row["horizon"] == groups[row["group"]]["horizon"], f"Horizon mismatch: {cid}")
        require(row["horizon"] in ("baseline", "later"), f"Bad horizon: {cid}")
        require(not {"status", "implementation_status", "owner", "progress"} & row.keys(),
                f"Public catalog is not a task tracker: {cid}")
        existing(row["document"])
        require(bool(row["acceptance_ids"]), f"Missing acceptance: {cid}")
        for aid in row["acceptance_ids"]:
            require(aid in scenarios and cid in scenarios[aid]["capabilities"], f"Bad mapping: {cid}/{aid}")
    for aid, row in scenarios.items():
        require(row["kind"] == "scenario-specification", f"Do not imply implemented test: {aid}")
        require(bool(row["expect"]) and bool(row["required_evidence"]), f"Empty expectation: {aid}")
        for cid in row["capabilities"]:
            require(cid in caps and aid in caps[cid]["acceptance_ids"], f"Bad reverse mapping: {aid}")
    for jid, row in journeys.items():
        for gid in row["groups"]:
            require(gid in groups, f"Unknown journey group: {jid}")
            covered.add(gid)
        for path in row["fixtures"]:
            existing(path)
    require(covered == set(groups), "A capability group lacks an integration journey")
    return len(caps), len(scenarios), len(journeys)


def check_examples() -> None:
    for directory in ("tests/fixtures", "contracts/examples"):
        for path in (ROOT / directory).glob("*.json"):
            data = json.loads(path.read_text())
            require(data.get("synthetic") is True, f"Fixture classification: {path.name}")
    source = (ROOT / "tests/fixtures/source-original.txt").read_bytes()
    entry = load("contracts/examples/source-bundle.json")["files"][0]
    require(entry["bytes"] == len(source), "Source fixture byte count")
    require(entry["sha256"] == hashlib.sha256(source).hexdigest(), "Source fixture hash")

    stock = load("tests/fixtures/stock-section.json")
    previous = Decimal(0)
    for layer in stock["layers"]:
        inner, outer = Decimal(str(layer["r_inner"])), Decimal(str(layer["r_outer"]))
        require(inner == previous and outer > inner, "Section layer boundaries")
        previous = outer
    require(2 * previous == Decimal(str(stock["expected"]["outer_diameter_mm"])), "Section diameter")
    require(len(stock["layers"]) == stock["expected"]["layer_count"], "Section layer count")

    prep = load("tests/fixtures/preparation.json")
    total = sum(Decimal(str(prep["inputs_mm"][key])) for key in prep["formula_terms"])
    require(total == prep["expected"]["stock_cut_mm"], "Preparation formula expectation")
    require(prep["unknown_case"]["expected_stock_cut_mm"] is None, "Unknown allowance became a number")

    inv = load("tests/fixtures/inventory.json")
    physical = inv["receipt"] - inv["consume"]
    reserved = inv["accepted_reservation"] - inv["consume"]
    require(sum(inv["competing_reservations"]) > inv["receipt"], "Reservation conflict fixture")
    require(inv["expected"]["both_reservations_succeed"] is False, "Overreservation expectation")
    require(physical == inv["expected"]["physical_after_consume"], "Physical ledger arithmetic")
    require(physical - reserved == inv["expected"]["available_with_remaining_reservation"], "Availability arithmetic")
    reserved -= inv["release_unused"]
    require(physical - reserved == inv["expected"]["available_after_release"], "Reservation release arithmetic")
    require(physical + inv["return_consumed"] - reserved == inv["expected"]["available_after_return"], "Return arithmetic")

    occ = load("tests/fixtures/occurrences.json")
    require(len(set(map(tuple, occ["paths"]))) == occ["expected"]["distinct_occurrence_addresses"], "Occurrence identities")
    require(math.dist(*occ["canonical_translations_mm"]) == occ["expected"]["canonical_distance_mm"], "Canonical placement")
    require(occ["expected"]["view_changes_canonical"] is False, "Display transform rewrites canonical")


def check_links() -> None:
    # Only repository-local Markdown destinations; remote pages/heading existence not checked.
    pattern = re.compile(r"(?<!!)\[[^\]\n]+\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
    for path in ROOT.rglob("*.md"):
        if SKIP & set(path.relative_to(ROOT).parts):
            continue
        text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
        for dest in pattern.findall(text):
            if dest.startswith(("#", "http:", "https:", "mailto:", "urn:")):
                continue
            target = (path.parent / unquote(dest.split("#", 1)[0])).resolve()
            require(target.is_relative_to(ROOT), f"External local link: {path.relative_to(ROOT)}")
            require(target.exists(), f"Broken local link in {path.relative_to(ROOT)}: {dest}")


def main() -> int:
    try:
        counts = check_catalogs()
        check_examples()
        check_links()
    except (ValueError, KeyError, OSError, TypeError) as exc:
        print(f"Guidance check failed: {exc}", file=sys.stderr)
        return 1
    print(f"Guidance integrity passed: {counts[0]} capabilities, {counts[1]} acceptance specifications, {counts[2]} journeys.")
    print("This is not application, native-tool, security, or physical qualification.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
