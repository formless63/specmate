"""Recognized KiCad s-expression file format versions.

KiCad writes ``(version N)`` near the start of every board and schematic file. Only
released stable formats are recognized; intermediate development versions written by
nightly builds are unknown, not guessed. The app never reads source bytes to classify
them: the trusted native programs embed ``CLASSIFIER`` (the same source this module
executes) and report what they found.
"""

# The pinned KiCad 10.0.6 pack writes and reads these natively.
NATIVE_KICAD = 10
NATIVE_BOARD_FORMAT = 20260206
NATIVE_SCHEMATIC_FORMAT = 20260306

# Released formats the recorded upgrade stage accepts (format -> KiCad major).
# KiCad 5.0/5.1 boards are 20171130; KiCad 5 schematics are legacy .sch, not .kicad_sch.
UPGRADABLE_BOARD_FORMATS = {20171130: 5, 20211014: 6, 20221018: 7, 20240108: 8, 20241229: 9}
UPGRADABLE_SCHEMATIC_FORMATS = {20211123: 6, 20230121: 7, 20231120: 8, 20250114: 9}

# One classifier text, executed here and embedded verbatim in the native programs.
CLASSIFIER = f"""
FORMATS={{"board":({NATIVE_BOARD_FORMAT},{UPGRADABLE_BOARD_FORMATS!r}),
    "schematic":({NATIVE_SCHEMATIC_FORMAT},{UPGRADABLE_SCHEMATIC_FORMATS!r})}}
def format_message(kind,version):
    native,old=FORMATS[kind]
    if version is None:
        return f"Not a KiCad s-expression {{kind}} file: no format version was found."
    if version==native:
        return f"KiCad 10 {{kind}} format {{version}} is current."
    if version in old:
        return (f"KiCad {{old[version]}} {{kind}} format {{version}} must be upgraded first: "
            "request the recorded KiCad 10 format upgrade.")
    if version<min(old):
        first=min(old.values())
        return (f"{{kind.capitalize()}} format {{version}} predates KiCad {{first}} and is too "
            f"old for the recorded upgrade (KiCad {{first}}-9 formats only).")
    if version>native:
        return f"{{kind.capitalize()}} format {{version}} is newer than KiCad 10.0.6 supports."
    return (f"{{kind.capitalize()}} format {{version}} is not a released KiCad 5-10 format "
        "(development build?); it cannot be upgraded.")
""".strip()

_namespace: dict = {}
exec(CLASSIFIER, _namespace)  # noqa: S102 - constant program text defined above


def format_message(kind: str, version: int | None) -> str:
    """Specific text for a file KiCad 10 extraction cannot read directly."""
    return _namespace["format_message"](kind, version)


def kicad_major(kind: str, version: int) -> int | None:
    native, upgradable = _namespace["FORMATS"][kind]
    return NATIVE_KICAD if version == native else upgradable.get(version)
