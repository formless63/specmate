#!/usr/bin/env python3
"""Heuristic publication checks. Not a guarantee of privacy or a secret-scanner replacement."""
from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP = {".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "dist", "build", ".cache"}
FORBIDDEN = {".beads", "private", "private-data", "references", "sessions", "scratch", ".state"}
RULES = [
    ("personal-home-path", re.compile(r"(?:/home/|/Users/)[A-Za-z0-9_.-]+/[^\s\"'<>]+")),
    ("windows-user-path", re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+\\", re.I)),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
]


def git(*args: str) -> bytes:
    result = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, check=False)
    if result.returncode:
        raise ValueError("Git operation failed; verify the repository and revision range.")
    return result.stdout


def is_repo() -> bool:
    try:
        return Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve() == ROOT
    except (OSError, ValueError):
        return False


def denylist(path: Path | None) -> list[str]:
    if path is None:
        return []
    absolute = path.expanduser().resolve(strict=True)
    if absolute.is_relative_to(ROOT):
        raise ValueError("Private denylist must be outside the public application root.")
    return [x.casefold() for line in absolute.read_text(encoding="utf-8").splitlines()
            if (x := line.strip()) and not x.startswith("#")]


def unsafe_path(name: str) -> bool:
    parts = PurePosixPath(name).parts
    return (name.startswith("/") or ".." in parts or bool(set(parts) & FORBIDDEN)
            or any(p == ".env" or (p.startswith(".env.") and not p.endswith((".example", ".sample"))) for p in parts)
            or name.endswith(("publication-denylist.txt", ".pem", ".key")))


def inspect(label: str, name: str, data: bytes, needles: list[str], errors: list[str], manual: set[str]) -> None:
    if any(needle in name.casefold() for needle in needles):
        label = "[redacted-path]"
    if unsafe_path(name):
        errors.append(f"{label}: forbidden deliverable path")
    if b"\0" in data:
        manual.add(label)
        return
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        manual.add(label)
        return
    for number, line in enumerate(text.splitlines(), 1):
        for rule, pattern in RULES:
            if pattern.search(line):
                errors.append(f"{label}:{number}: {rule} (match redacted)")
        if any(needle in line.casefold() for needle in needles):
            errors.append(f"{label}:{number}: private-denylist match (redacted)")
    if any(needle in name.casefold() for needle in needles):
        errors.append(f"{label}: private-denylist filename match (redacted)")


def snapshot(ref: str, needles: list[str], errors: list[str], manual: set[str]) -> None:
    for record in git("ls-tree", "-r", "-z", ref).split(b"\0"):
        if not record:
            continue
        meta, name_raw = record.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        name = name_raw.decode("utf-8", errors="replace")
        label = f"{ref[:12]}:{name}"
        if kind != "blob":
            manual.add(label)
            continue
        if mode == "120000":
            # Symlinks need explicit review even if apparently internal.
            errors.append(f"{label}: symlink requires review; not allowed by bootstrap gate")
        inspect(label, name, git("cat-file", "blob", oid), needles, errors, manual)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="Scan actual Git index blobs, not working copies.")
    mode.add_argument("--git-range", help="Scan every snapshot and commit metadata reachable in a rev-list expression.")
    parser.add_argument("--denylist", type=Path, help="External private file of literal identifiers, one per line.")
    parser.add_argument("--require-text-only", action="store_true", help="Fail when binary/manual review remains.")
    args = parser.parse_args()
    errors: list[str] = []
    manual: set[str] = set()
    try:
        needles = denylist(args.denylist)
        repo = is_repo()
        if repo and git("for-each-ref", "--format=%(refname)", "refs/dolt/").strip():
            errors.append("Git refs: Dolt tracker data must not exist in the public repository")
        if (args.staged or args.git_range) and not repo:
            raise ValueError("This mode requires app/ to be an independent Git repository.")
        if args.git_range:
            if args.git_range.startswith("-") or any(c.isspace() for c in args.git_range):
                raise ValueError("Use one Git revision expression, not command-line options.")
            revisions = git("rev-list", args.git_range, "--").decode().splitlines()
            if not revisions:
                raise ValueError("No commits selected; no history verification performed.")
            for revision in revisions:
                metadata = git("show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", revision, "--")
                inspect(f"{revision[:12]}:commit-metadata", "commit-metadata", metadata, needles, errors, manual)
                snapshot(revision, needles, errors, manual)
        elif args.staged:
            names = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(b"\0")
            for raw in filter(None, names):
                name = raw.decode("utf-8")
                listing = git("ls-files", "--stage", "--", name)
                if listing.startswith(b"120000 "):
                    errors.append(f"index:{name}: symlink requires review")
                inspect(f"index:{name}", name, git("show", ":" + name), needles, errors, manual)
        else:
            # Trackable working files in Git; all non-generated payload files before Git init.
            if repo:
                names = sorted(set(filter(None, git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0"))))
            else:
                names = []
                for directory, dirs, files in os.walk(ROOT, followlinks=False):
                    dirs[:] = [d for d in dirs if d not in SKIP]
                    for d in dirs:
                        if (Path(directory) / d).is_symlink():
                            errors.append(f"{(Path(directory)/d).relative_to(ROOT)}: directory symlink requires review")
                    names.extend(str((Path(directory) / f).relative_to(ROOT)) for f in files)
            # Refuse a tracker/private directory even if gitignored. They belong outside app/.
            for forbidden in FORBIDDEN:
                if (ROOT / forbidden).exists() or (ROOT / forbidden).is_symlink():
                    errors.append(f"{forbidden}: private directory exists inside app/")
            for name in names:
                path = ROOT / name
                if path.is_symlink():
                    errors.append(f"{name}: symlink requires review")
                    continue
                if not path.exists():  # a tracked working-tree deletion has no current content
                    continue
                if not path.resolve().is_relative_to(ROOT):
                    errors.append(f"{name}: path escapes application")
                    continue
                inspect(name, name, path.read_bytes(), needles, errors, manual)
        for item in sorted(set(errors)):
            print(item, file=sys.stderr)
        for item in sorted(manual):
            print(f"Manual artifact review required: {item}", file=sys.stderr)
        if errors or (manual and args.require_text_only):
            print("Publication heuristic check failed; matches are not echoed.", file=sys.stderr)
            return 1
        print("No configured heuristic hazards found in the selected content.")
        print("This does not replace Gitleaks, rights review, binary review, or publication authorization.")
        return 0
    except (OSError, ValueError, UnicodeError) as exc:
        print(f"Check not completed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
