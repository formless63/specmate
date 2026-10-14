"""Optional native tool catalog: pinned images an operator enables explicitly.

Enabling a tool records an operator decision in ``tools-enabled.json``; it never pulls
or runs anything by itself. Recipes still bind exact inputs and are approved separately
in ``recipes.json``. A recipe whose image belongs to a catalog tool that is not enabled
is refused. Images outside the catalog are not gated: the operator owns that choice.

This module uses only the standard library so the operator console can run it on the
host: ``PYTHONPATH=backend/src python3 -m specmate.builds.tools --stack-dir DIR list``.
"""

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

CATALOG_PATH = Path(__file__).with_name("tool_catalog.json")
DIGEST = re.compile(r"@(sha256:[0-9a-f]{64})$")
ARCH = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class ToolError(Exception):
    pass


def image_digest(image: str) -> str | None:
    match = DIGEST.search(image or "")
    return match.group(1) if match else None


def load_catalog(path: Path | None = None) -> list[dict]:
    data = json.loads((path or CATALOG_PATH).read_text())
    tools = data["tools"]
    seen = set()
    for tool in tools:
        if tool["id"] in seen or image_digest(tool["image"]) is None or not tool["platforms"]:
            raise ToolError(f"Invalid tool catalog entry {tool['id']!r}")
        seen.add(tool["id"])
    return tools


def tool_for_image(image: str, catalog: list[dict] | None = None) -> dict | None:
    digest = image_digest(image)
    for tool in catalog if catalog is not None else load_catalog():
        if digest and digest == image_digest(tool["image"]):
            return tool
    return None


def read_enabled(path: Path) -> dict[str, dict]:
    """Enabled tool entries; a missing or unreadable file means nothing is enabled."""
    try:
        data = json.loads(Path(path).read_text())
        enabled = data["enabled"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    return enabled if isinstance(enabled, dict) else {}


def write_enabled(path: Path, enabled: dict[str, dict]) -> None:
    path = Path(path)
    body = json.dumps({"format_version": 1, "enabled": enabled}, indent=2, sort_keys=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(body + "\n")
    temporary.chmod(0o644)
    os.replace(temporary, path)


def host_architecture() -> str:
    return ARCH.get(platform.machine().lower(), platform.machine().lower())


def inspect_image(image: str, run: Runner = subprocess.run) -> dict:
    """Ask the local Docker daemon about a cached image; never pulls."""
    try:
        done = run(
            ["docker", "image", "inspect", "--format", "{{json .}}", image],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {"state": "docker_unavailable"}
    if done.returncode != 0:
        text = (done.stderr or "").lower()
        return {"state": "missing" if "no such image" in text else "docker_unavailable"}
    try:
        info = json.loads(done.stdout)
        return {
            "state": "present",
            "architecture": info.get("Architecture"),
            "os": info.get("Os"),
            "installed_bytes": info.get("Size"),
        }
    except ValueError:
        return {"state": "docker_unavailable"}


def tool_report(
    tool: dict,
    enabled: dict[str, dict],
    recipes: dict,
    *,
    image: dict | None = None,
    host_arch: str | None = None,
) -> dict:
    """One tool's operator view. ``image`` None means availability was not evaluated."""
    digest = image_digest(tool["image"])
    approved = sorted(
        rid
        for rid, raw in recipes.items()
        if isinstance(raw, dict) and image_digest(raw.get("image", "")) == digest
    )
    arches = sorted({p.split("/", 1)[1] for p in tool["platforms"] if "/" in p})
    arch_ok = None if host_arch is None else host_arch in arches
    is_enabled = tool["id"] in enabled
    if image is None:
        state = "enabled" if is_enabled else "not_enabled"
        image_state = "not_evaluated"
    else:
        image_state = image["state"]
        if arch_ok is False:
            state = "unsupported_architecture"
        elif is_enabled and image_state == "present":
            state = "enabled"
        elif is_enabled:
            state = "enabled_image_missing" if image_state == "missing" else "enabled_unverified"
        elif image_state == "present":
            state = "available"
        elif image_state == "missing":
            state = "missing"
        else:
            state = "unknown"
    return {
        "id": tool["id"],
        "title": tool["title"],
        "state": state,
        "enabled": is_enabled,
        "image": tool["image"],
        "source": tool["source"],
        "platforms": tool["platforms"],
        "host_architecture": host_arch,
        "architecture_supported": arch_ok,
        "download_bytes": tool["download_bytes"],
        "installed_bytes": tool["installed_bytes"],
        "size_note": tool["size_note"],
        "capabilities": tool["capabilities"],
        "rights": tool["rights"],
        "qualification": tool["qualification"],
        "acquire": tool["acquire"],
        "image_state": image_state,
        "approved_recipe_ids": approved,
    }


def build_reports(stack_dir: Path, run: Runner = subprocess.run) -> list[dict]:
    stack_dir = Path(stack_dir)
    try:
        recipes = json.loads((stack_dir / "recipes.json").read_text())
    except (OSError, ValueError):
        recipes = {}
    enabled = read_enabled(stack_dir / "tools-enabled.json")
    arch = host_architecture()
    return [
        tool_report(t, enabled, recipes, image=inspect_image(t["image"], run), host_arch=arch)
        for t in load_catalog()
    ]


def _find(tool_id: str) -> dict:
    for tool in load_catalog():
        if tool["id"] == tool_id:
            return tool
    raise ToolError(f"Unknown tool {tool_id!r}; run the list command for catalog ids.")


def enable_tool(
    stack_dir: Path, tool_id: str, *, pull: bool = False, run: Runner = subprocess.run
) -> dict:
    tool = _find(tool_id)
    arch = host_architecture()
    if not any(p.endswith("/" + arch) for p in tool["platforms"]):
        raise ToolError(
            f"{tool_id} supports {', '.join(tool['platforms'])}; this host is linux/{arch}."
        )
    image = inspect_image(tool["image"], run)
    if image["state"] == "docker_unavailable":
        raise ToolError("The Docker daemon could not be queried; no change was made.")
    if image["state"] == "missing":
        if not pull:
            size = tool["download_bytes"]
            where = f"about {size / 1e6:.0f} MB to download" if size else "download size unknown"
            raise ToolError(
                f"Image for {tool_id} is not cached ({where}). Acquire it with:\n"
                f"  {tool['acquire']}\nor rerun enable with --pull for registry images."
            )
        if tool["source"] != "registry":
            raise ToolError(
                f"{tool_id} is built locally; --pull does not apply. Use: {tool['acquire']}"
            )
        done = run(["docker", "pull", tool["image"]], text=True, check=False)
        if done.returncode != 0:
            raise ToolError("docker pull failed; no change was made.")
        image = inspect_image(tool["image"], run)
        if image["state"] != "present":
            raise ToolError("Image is still not cached after pull; no change was made.")
    if image.get("architecture") and image["architecture"] != arch:
        raise ToolError(f"Cached image is {image['architecture']}, host is {arch}.")
    path = Path(stack_dir) / "tools-enabled.json"
    enabled = read_enabled(path)
    enabled[tool_id] = {
        "image": tool["image"],
        "enabled_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    write_enabled(path, enabled)
    return enabled[tool_id]


def disable_tool(stack_dir: Path, tool_id: str) -> bool:
    _find(tool_id)
    path = Path(stack_dir) / "tools-enabled.json"
    enabled = read_enabled(path)
    removed = enabled.pop(tool_id, None) is not None
    write_enabled(path, enabled)
    return removed


def _size(value: int | None) -> str:
    return "unknown" if value is None else f"{value / 1e6:,.0f} MB"


def format_reports(reports: list[dict]) -> str:
    lines = []
    for r in reports:
        lines.append(f"{r['id']}  [{r['state']}]  {r['title']}")
        lines.append(
            f"    platforms {', '.join(r['platforms'])} (host linux/{r['host_architecture']})"
            f"  download {_size(r['download_bytes'])}  installed {_size(r['installed_bytes'])}"
        )
        lines.append(f"    image {r['image']}  cached: {r['image_state']}")
        lines.extend(f"    - {c}" for c in r["capabilities"])
        if r["approved_recipe_ids"]:
            lines.append(f"    approved recipes: {len(r['approved_recipe_ids'])}")
    return "\n".join(lines)


def main(argv=None, run: Runner = subprocess.run) -> int:
    parser = argparse.ArgumentParser(description="List, enable or disable optional native tools.")
    parser.add_argument("--stack-dir", type=Path, default=Path.cwd())
    sub = parser.add_subparsers(dest="action", required=True)
    listing = sub.add_parser("list")
    listing.add_argument("--json", action="store_true")
    enable = sub.add_parser("enable")
    enable.add_argument("tool")
    enable.add_argument("--pull", action="store_true", help="docker pull a missing registry image")
    sub.add_parser("disable").add_argument("tool")
    args = parser.parse_args(argv)
    try:
        if args.action == "list":
            reports = build_reports(args.stack_dir, run)
            print(json.dumps(reports, indent=2) if args.json else format_reports(reports))
        elif args.action == "enable":
            enable_tool(args.stack_dir, args.tool, pull=args.pull, run=run)
            print(f"Enabled {args.tool}. Recreate app and jobs to load the change.")
        else:
            removed = disable_tool(args.stack_dir, args.tool)
            print(
                ("Disabled " if removed else "Already disabled: ")
                + f"{args.tool}. Recreate app and jobs to load the change; images and "
                "recipes are left in place."
            )
    except ToolError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
