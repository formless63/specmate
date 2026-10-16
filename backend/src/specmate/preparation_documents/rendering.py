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


def _cell(value):
    return f"<td>{html.escape(value)}</td>"


def _signals(contacts):
    if not contacts:
        return "unknown (reaches no connector contact)"
    parts = []
    for c in contacts:
        signal = c["signal"]
        text = (
            f"{signal['name']} ({signal['type'].replace('_', ' ')})" if signal else "signal unknown"
        )
        if c["status"] != "declared":
            text += " · path unknown"
        parts.append(f"{c['label']}: {text}")
    return "; ".join(parts)


def termination_tables(terminations):
    """Readable per-end tables: conductor, landing target, pin signal, parts."""
    blocks = []
    for context in terminations:
        rows = context.get("rows")
        if rows is None:
            continue
        where = "/".join(context["address"]["path"]) or "standalone cable"
        ends = {}
        for row in rows:
            ends.setdefault(
                (row["endpoint_id"], row["endpoint_label"], row["stock_end"]), []
            ).append(row)
        for (endpoint_id, label, stock_end), end_rows in sorted(ends.items()):
            body = "".join(
                "<tr>"
                + _cell(r["element_label"] or r["element_path"])
                + _cell(f"{r['layer_kind']} {r['target_label']}")
                + _cell(_signals(r["contacts"]))
                + _cell("; ".join(r["part_notes"]) or "none declared")
                + "</tr>"
                for r in end_rows
            )
            blocks.append(
                f"<h3>{html.escape(where)} · end {html.escape(endpoint_id)} "
                f"({html.escape(label)}) · stock end {html.escape(stock_end)}</h3>"
                "<table><thead><tr><th>Conductor</th><th>Lands on</th><th>Pin and signal</th>"
                f"<th>Parts</th></tr></thead><tbody>{body}</tbody></table>"
            )
    if not blocks:
        return ""
    return (
        "<section><h2>Terminations by end</h2><p>Declared landings and the typed signals of "
        "the contacts they reach. Not measured continuity.</p>" + "".join(blocks) + "</section>"
    )


def test_tables(tests):
    blocks = []
    for context in tests:
        plan = (context.get("declarations") or {}).get("test_plan")
        if not plan:
            continue

        def term(t):
            return f"{t['endpoint_id']} · {t.get('contact_id') or t.get('element_path')}"

        body = "".join(
            "<tr>"
            + _cell(p["local_id"])
            + _cell(term(p["first"]))
            + _cell(term(p["second"]))
            + _cell(p["intent"])
            + _cell(p.get("signal") or "")
            + _cell(
                "unknown"
                if p.get("expected_resistance_ohm") is None
                else f"{p['expected_resistance_ohm']:g} ohm"
            )
            + "</tr>"
            for p in plan["pairs"]
        )
        labels = "".join(
            "<tr>"
            + _cell(
                term(lbl["terminal"])
                if lbl.get("terminal")
                else f"end {lbl['endpoint_id']}"
                if lbl.get("endpoint_id")
                else "whole cable"
            )
            + _cell(lbl["text"])
            + "</tr>"
            for lbl in plan["labels"]
        )
        where = "/".join(context["address"]["path"]) or "standalone cable"
        blocks.append(
            f"<h3>{html.escape(where)}</h3><table><thead><tr><th>Pair</th><th>First</th>"
            "<th>Second</th><th>Expect</th><th>Signal</th><th>Series resistance</th></tr>"
            f"</thead><tbody>{body}</tbody></table>"
            + (
                "<table><thead><tr><th>Label at</th><th>Text</th></tr></thead>"
                f"<tbody>{labels}</tbody></table>"
                if labels
                else ""
            )
        )
    if not blocks:
        return ""
    return (
        "<section><h2>Test expectations and labels</h2><p>Authored expectations; no "
        "physical test performed.</p>" + "".join(blocks) + "</section>"
    )


def title_block(inputs):
    """Only explicit copied fields print. Old retained configurations use no live defaults."""
    snapshot = inputs["configuration"].get("document_settings")
    if snapshot is None:
        return "", ""
    rows = [
        ("Organization", snapshot.get("organization")),
        ("Designer", snapshot.get("designer")),
        ("Printed rights / confidentiality line", snapshot.get("rights_line")),
        ("Label QR address", snapshot.get("label_qr_url")),
    ]
    cells = "".join(
        f"<tr><th>{html.escape(label)}</th><td>{html.escape(value or 'Not declared')}</td></tr>"
        for label, value in rows
    )
    version = snapshot["source_settings_version"]
    layout = snapshot.get("title_block") or "generic"
    block = (
        f'<section class="document-title-block {layout}"><h2>Document title block</h2>'
        f"<p>Copied defaults, reviewed values. Declared settings version {version}. "
        "Printed text does not grant distribution rights.</p>"
        f"<table>{cells}</table></section>"
    )
    paper = snapshot.get("paper")
    # Captured settings opt into a versioned generator; legacy /2 bytes stay exact.
    # Standalone HTML must remain paper-readable under dark browser preferences.
    style = "html{color-scheme:light;background:#fff;color:#111}"
    style += "body{background:#fff;color:#111}"
    style += f"@page{{size:{paper};}}" if paper else ""
    if layout == "iso7200":
        style += ".document-title-block{margin-left:auto;max-width:32em}"
    elif layout == "ansi":
        style += ".document-title-block,.document-title-block table{width:100%}"
    return block, style


def render(projection):
    inputs = projection["inputs"]
    sha = projection["inputs_sha256"]
    sections = projection["sections"]
    title, title_style = title_block(inputs)
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
                        + (
                            "unassigned"
                            if not assignment
                            else "contact " + assignment["contact_id"]
                            if assignment.get("contact_id")
                            else assignment["layer_id"] + " " + assignment["terminal_label"]
                        )
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
        "<title>Coordinated build sheet</title><style>"
        + title_style
        + "body{font:14px sans-serif;margin:2em}"
        "pre{white-space:pre-wrap;overflow-wrap:anywhere}section{break-inside:avoid}"
        "h2{font-size:1.2em}h3{font-size:1em}table{border-collapse:collapse;margin:.5em 0}"
        "td,th{border:1px solid #888;padding:2px 6px;text-align:left}</style></head><body>"
        "<h1>Coordinated declared build sheet</h1><p>Not a release or physical qualification. "
        "Missing inputs stay unknown.</p>"
        + title
        + termination_tables(sections["terminations"])
        + test_tables(sections["test_intent"])
        + "".join(blocks)
        + "</body></html>"
    )
    add("build-sheet.html", "text/html", document.encode())
    if set(files) != set(DOCUMENTS) or sum(len(data) for _, data in files.values()) > MAX_SET_BYTES:
        raise ValidationFailed("Coordinated output set exceeds the bounded complete-file limits.")
    contexts = []
    for scope in sections["specifications"]:
        declarations = scope["declarations"]
        cable = declarations.get("cable")
        harness = declarations.get("harness")
        if cable is not None and declarations.get("topology") == "section_graph":
            harness, cable = cable, None
        contexts.append(
            {
                "address": scope["address"],
                "kind": "cable" if declarations.get("cable") is not None else "harness",
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
