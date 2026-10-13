"""Bounded deterministic inert files. All six carry the identical input provenance."""

import csv
import html
import io
import json

from specmate.design.operations import canonical_bytes
from specmate.operations import ValidationFailed
from specmate.preparation_documents.contracts import DOCUMENTS
from specmate.selected_packages.queries import digest

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_SET_BYTES = 8 * 1024 * 1024


def pretty(value):
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False)


def render(projection):
    inputs = projection["inputs"]
    sha = projection["inputs_sha256"]
    sections = projection["sections"]
    envelope = {
        "inputs": inputs,
        "inputs_sha256": sha,
        "readiness": projection["readiness"],
        "document_assessments": projection["document_assessments"],
        "issues": sections["issues"],
        "quantity_summary": {
            "meaning": "Declared design piece/relationship counts; no physical facts",
            "physical_pieces": [
                r for r in sections["cut_preparation"] if r["row_kind"] == "declared_physical_piece"
            ],
            "terminations": [
                {k: v for k, v in row.items() if k == "address" or k.endswith("count")}
                for row in sections["terminations"]
            ],
        },
    }
    files = {}

    def add(name, media_type, data):
        if len(data) > MAX_FILE_BYTES:
            raise ValidationFailed("Document output exceeds the bounded file size.")
        files[name] = (media_type, data)

    for name, data in (
        (
            "specifications",
            {
                "revision_declarations": sections["revision_specifications"],
                "contexts": sections["specifications"],
            },
        ),
        ("terminations", sections["terminations"]),
        ("test-intent", sections["test_intent"]),
    ):
        add(
            name + ".json",
            "application/json",
            canonical_bytes({**envelope, "declarations": data, "issues": sections["issues"]}),
        )
    # CSV contains a metadata record plus typed rows. Text never becomes a spreadsheet formula.
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(
        [
            "record",
            "input_sha256",
            "root_revision_id",
            "path",
            "section",
            "row_kind",
            "declared_mm",
            "suggested_mm",
            "design_count",
            "workshop_count",
            "design_total_mm",
            "workshop_total_mm",
            "data",
        ]
    )
    writer.writerow(
        [
            "metadata",
            sha,
            inputs["root"]["revision_id"],
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            pretty(envelope),
        ]
    )
    for kind, rows in (
        ("cut", sections["cut_preparation"]),
        ("preparation", sections["end_preparation"]),
    ):
        for row in rows:
            values = [
                kind,
                sha,
                inputs["root"]["revision_id"],
                "/".join(row["address"]["path"]),
                row.get("section_id"),
                row.get("row_kind", "end_preparation"),
                row.get("length_mm"),
                row.get("cut_mm"),
                row.get("design_piece_count"),
                row.get("workshop_piece_count"),
                row.get("design_total_mm", row.get("total_mm")),
                row.get("workshop_total_mm"),
                pretty(row),
            ]
            cells = ["unknown" if value is None else str(value) for value in values]
            writer.writerow(
                [
                    "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value
                    for value in cells
                ]
            )
    add("cut-preparation.csv", "text/csv", stream.getvalue().encode())
    # Nodes and lines portray only authored relationships, never native/physical routes.
    drawing, y = [], 110

    def label(x, y, text):
        return f'<text x="{x}" y="{y}" font-size="13">{html.escape(text)}</text>'

    for context in sections["schematic"]:
        address = "/".join(context["address"]["path"]) or "standalone"
        drawing.append(label(20, y, address + " · " + context["meaning"]))
        y += 32
        if "conductors" in context:
            for conductor in context["conductors"]:
                # Stock identity is a shared declared feature, not continuity evidence.
                drawing.append(
                    f'<rect x="390" y="{y - 18}" width="400" height="32" '
                    'fill="#eef" stroke="#333"/>'
                )
                drawing.append(label(400, y, conductor["element_path"]))
                for index, end in enumerate(conductor["ends"]):
                    left = index == 0
                    x = 20 if left else 840
                    assignment = end["assignment"]
                    text = (
                        end["endpoint_id"]
                        + " / "
                        + ("contact " + assignment["contact_id"] if assignment else "unassigned")
                    )
                    drawing.append(label(x, y, text))
                    if assignment:
                        x1, x2 = (290, 390) if left else (790, 830)
                        drawing.append(
                            f'<line x1="{x1}" y1="{y - 5}" x2="{x2}" y2="{y - 5}" stroke="#333"/>'
                        )
                y += 48
        else:
            for relationship in context["relationships"]:
                drawing.append(label(20, y, relationship["id"] + " · " + relationship["kind"]))
                y += 25
                for member in relationship["members"]:
                    drawing.append(
                        f'<line x1="40" y1="{y - 10}" x2="90" y2="{y - 10}" stroke="#333"/>'
                    )
                    drawing.append(label(100, y, pretty(member).replace("\n", " ")))
                    y += 28
                y += 15
    if not sections["schematic"]:
        drawing.append(label(20, y, "No supported wiring scope; connectivity unknown."))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 {y + 50}">'
        f"<metadata>{html.escape(pretty(envelope))}</metadata>"
        '<rect width="100%" height="100%" fill="white"/>'
        + label(20, 30, "Declared schematic · root " + inputs["root"]["revision_id"])
        + label(20, 58, "Physical continuity, routing and test outcome: not evaluated.")
        + label(
            20,
            78,
            "Each drawing depicts one declared contextual occurrence; "
            "batch quantities remain in the common metadata.",
        )
        + "".join(drawing)
        + "</svg>"
    )
    add("schematic.svg", "image/svg+xml", svg.encode())
    blocks = []
    for name, data in (
        ("Exact input provenance", envelope),
        ("Specifications", sections["specifications"]),
        ("Frozen procurement policy", sections["procurement"]),
        ("Declared cuts and separate suggestions", sections["cut_preparation"]),
        ("Per-end preparation intent", sections["end_preparation"]),
        ("Declared terminations", sections["terminations"]),
        ("Authored test intent; no physical test performed", sections["test_intent"]),
        ("Missing inputs and limits", sections["issues"]),
    ):
        blocks.append(
            f"<section><h2>{html.escape(name)}</h2><pre>{html.escape(pretty(data))}</pre></section>"
        )
    document = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta http-equiv="Content-Security-Policy" '
        "content=\"default-src 'none'; style-src 'unsafe-inline'\">"
        "<title>Coordinated build sheet</title><style>body{font:14px sans-serif;margin:2em}"
        "pre{white-space:pre-wrap;overflow-wrap:anywhere}section{break-inside:avoid}"
        "h2{font-size:1.2em}</style></head><body>"
        "<h1>Coordinated declared build sheet</h1><p>Not a release or physical qualification. "
        "Missing inputs stay unknown.</p>" + "".join(blocks) + "</body></html>"
    )
    add("build-sheet.html", "text/html", document.encode())
    if set(files) != set(DOCUMENTS) or sum(len(data) for _, data in files.values()) > MAX_SET_BYTES:
        raise ValidationFailed("Coordinated output set exceeds the bounded complete-file limits.")
    contexts = []
    for scope in sections["specifications"]:
        declarations = scope["declarations"]
        cable = declarations.get("cable")
        harness = declarations.get("harness")
        contexts.append(
            {
                "address": scope["address"],
                "kind": "cable" if cable is not None else "harness",
                "disposition": scope["disposition"],
                "sections": [
                    {
                        "section_id": None,
                        "stock_revision_id": cable["stock_revision_id"],
                        "end_ids": [e["local_id"] for e in cable["endpoints"]],
                    }
                ]
                if cable is not None
                else [
                    {
                        "section_id": s["local_id"],
                        "stock_revision_id": s["stock_revision_id"],
                        "end_ids": [e["local_id"] for e in s.get("physical_ends", [])],
                    }
                    for s in harness["sections"]
                ],
            }
        )
    manifest = {
        **envelope,
        "context_pins": contexts,
        "outputs": [
            {
                "filename": name,
                "sha256": digest(data),
                "size": len(data),
                "media_type": media,
                "rights": inputs["configuration"]["output_rights"],
                "inputs_sha256": sha,
            }
            for name, (media, data) in sorted(files.items())
        ],
    }
    return manifest, files
