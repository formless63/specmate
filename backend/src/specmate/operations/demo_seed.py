"""Synthetic demo data for a freshly reset installation, built only through operations.

Every record goes through the shared operation layer as one existing account, so the
usual validation, permissions and immutability apply. Names are fixed and start with
"Demo", every value is invented, and nothing here is physical qualification. No native
tool runs, no account is created and no raw SQL is issued.
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from django.utils import timezone

from specmate.access.models import Project, Workspace, WorkspaceMember
from specmate.access.permissions import Perm, permissions_for
from specmate.design.models import Definition
from specmate.operations import Context, OperationError, execute

PROJECT_ONE = "Demo bench A"
PROJECT_TWO = "Demo bench B"
REQUIRED = (Perm.ITEM_CREATE, Perm.DESIGN_EDIT, Perm.DESIGN_FREEZE, Perm.INVENTORY_MANAGE)


class SeedRefused(Exception):
    """The installation or the acting account is not suitable for demo data."""


STOCK = {
    "construction": "bundle",
    "structure": {
        "id": "stock",
        "label": "Demo three-core stock",
        "kind": "group",
        "role": "stock",
        "children": [
            {"id": "core", "label": "Core", "kind": "conductor"},
            {"id": "screen", "label": "Screen", "kind": "shield"},
            {"id": "drain", "label": "Drain", "kind": "drain"},
            {"id": "jacket", "label": "Jacket", "kind": "jacket"},
        ],
    },
}

BODY = {
    "kind": "connector_body",
    "contacts": [
        {"contact_id": "a"},
        {"contact_id": "b"},
        {"contact_id": "shell", "physical_role": "shell"},
        {"contact_id": "key", "physical_role": "key"},
    ],
}

PAINT_NEEDS_SPLASH = {
    "kind": "requires",
    "key": "paint-sealing",
    "label": "Painted finish needs splash sealing",
    "basis": "Demo process note.",
    "when": {"option_key": "finish", "choice_key": "paint"},
    "option_key": "sealing",
    "choice_keys": ["splash"],
}


def _declaration(amount: str) -> dict:
    return {"amount_mm": amount, "basis": "human_declaration", "explanation": "Demo drawing"}


def _prepared(amount: str, source: str, extra: str, kind: str = "slack") -> dict:
    return {
        "declaration": _declaration(amount),
        "model": {
            "source": source,
            "review": "reviewed",
            "review_basis": "Reviewed demo allowance",
            "allowances": [{"kind": kind, "amount_mm": extra, "explanation": "Demo allowance"}],
        },
    }


def _length_plan() -> dict:
    return {
        "route": _declaration("1000"),
        "finished": _prepared("1050", "route", "50"),
        "stock_cut": _prepared("1070", "finished", "20", "preparation"),
        "conductor_cuts": [
            {"element_path": "stock.core", **_prepared("1060", "stock_cut", "10", "trim")}
        ],
    }


def _formula(stock_revision_id: str) -> dict:
    formula = {
        "local_id": "stock-cut",
        "label": "Reviewed physical piece",
        "target": "stock_piece",
        "input_length": "route",
        "input_basis": "declaration",
        "review": "reviewed",
        "review_basis": "Demo additive preparation model",
        "allowances": [
            {
                "local_id": name,
                "kind": kind,
                "scope": scope,
                "amount_mm": amount,
                "basis": f"Demo {name} allowance",
            }
            for name, kind, scope, amount in (
                ("end-a", "preparation", "end_a", "20"),
                ("end-b", "preparation", "end_b", "10"),
                ("slack", "slack", "whole_piece", "5"),
            )
        ],
    }
    return {"stock_revision_id": stock_revision_id, "formulas": [formula]}


def _terminal(segment: str, end: str, path: str) -> dict:
    return {"kind": "segment", "segment_id": segment, "end": end, "element_path": f"stock.{path}"}


def _contact(endpoint: str, feature: str) -> dict:
    return {"kind": "endpoint", "endpoint_id": endpoint, "contact_id": feature}


@dataclass
class Seeder:
    user: Any
    workspace: Workspace
    created: dict[str, int] = field(default_factory=dict)
    _n: int = 0

    # -- plumbing ---------------------------------------------------------------------
    def call(self, name: str, payload: dict, *, state: str | None = None, key: str | None = None):
        self._n += 1
        ctx = Context(
            user=self.user,
            via="internal",
            request_id=f"demo-seed-{self._n:04d}",
            expected_state=state,
            idempotency_key=key,
            attachments={},
        )
        return self._run(name, ctx, payload)

    def _run(self, name: str, ctx: Context, payload: dict):
        try:
            return execute(name, ctx, payload).result
        except OperationError as exc:
            raise SeedRefused(f"{name} failed: {exc.message} {exc.details or ''}") from exc

    def tally(self, what: str) -> None:
        self.created[what] = self.created.get(what, 0) + 1

    @property
    def ws(self) -> str:
        return str(self.workspace.id)

    def define(self, kind: str, name: str, content: dict | None = None) -> dict:
        """Create and freeze one generic definition; returns ids and the frozen revision."""
        draft = self.call(
            "definition.create",
            {"workspace_id": self.ws, "kind": kind, "name": name, "content": content or {}},
        )
        revision = self.call("draft.freeze", {"draft_id": draft["draft_id"]}, state=draft["state"])
        self.tally(kind)
        return {**draft, **revision}

    def freeze(self, operation: str, draft: dict) -> dict:
        frozen = self.call(operation, {"draft_id": draft["draft_id"]}, state=draft["state"])
        return {**draft, **frozen}

    def source(self, name: str, path: str, data: bytes, media_type: str) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        self._n += 1
        ctx = Context(
            user=self.user,
            via="internal",
            request_id=f"demo-seed-{self._n:04d}",
            attachments={"content": io.BytesIO(data)},
        )
        self._run(
            "source.register_blob",
            ctx,
            {
                "workspace_id": self.ws,
                "sha256": digest,
                "size": len(data),
                "media_type": media_type,
            },
        )
        bundle = self.call(
            "source.create_original_bundle",
            {
                "workspace_id": self.ws,
                "name": name,
                "files": [
                    {
                        "path": path,
                        "sha256": digest,
                        "media_type": media_type,
                        "rights": "synthetic-original",
                    }
                ],
            },
        )
        self.tally("source bundle")
        return bundle

    # -- sections ---------------------------------------------------------------------
    def av_interfaces(self) -> None:
        """Synthetic signal set, two bodies and their named pinout variants (INT-001)."""
        from specmate.interfaces import examples

        def interface(name: str, value: dict) -> dict:
            draft = self.call(
                "interface.create", {"workspace_id": self.ws, "name": name, "interface": value}
            )
            return self.freeze("interface.freeze", draft)

        signals = interface("Demo workshop AV signals", examples.av_signal_set())["revision_id"]
        self.tally("signal set")
        din = interface("Demo 10-pin round DIN socket", examples.round_din_10_socket())
        rgb = interface("Demo 21-pin RGB socket", examples.rgb_21_socket())
        variants = {}
        for variant in ("Console A AV", "Console B AV"):
            variants[variant] = interface(
                f"Demo 10-pin socket {variant}",
                examples.console_pinout(signals, din["revision_id"], variant),
            )["revision_id"]
            self.tally("pinout variant")
        roles = {}
        for role in ("sink", "source"):
            roles[role] = interface(
                f"Demo 21-pin RGB {role}",
                examples.rgb_pinout(signals, rgb["revision_id"], role),
            )["revision_id"]
            self.tally("pinout variant")
        # Cable-side plugs declare reviewed mating with the device sockets (INT-002).
        plug = interface(
            "Demo 10-pin round DIN plug", examples.round_din_10_plug(din["revision_id"])
        )
        # A bought black-box adapter board carrying the plug (PCB-006).
        board = interface("Demo AV adapter board", examples.av_adapter_board(plug["revision_id"]))
        self.tally("board")
        rgb_plug = interface("Demo 21-pin RGB plug", examples.rgb_21_plug(rgb["revision_id"]))
        for variant in ("Console A AV", "Console B AV"):
            device = f"{variant} out"
            interface(f"Demo {device}", examples.console_port(variants[variant], device))
            self.tally("port")
        interface("Demo RGB monitor 21-pin input", examples.rgb_monitor_port(roles["sink"]))
        self.tally("port")
        # A six-coax stock whose conductors a shop convention maps to the AV signals.
        stock_draft = self.call(
            "wire_stock.create",
            {
                "workspace_id": self.ws,
                "name": "Demo six-coax AV stock",
                "stock": examples.six_coax_stock(),
            },
        )
        stock = self.freeze("wire_stock.freeze", stock_draft)
        self.tally("wire stock")
        interface(
            "Demo six-coax AV convention",
            examples.av_coax_convention(signals, stock["revision_id"]),
        )
        self.tally("convention")
        interface("Demo AV colour code", examples.av_colour_code(signals))
        self.tally("convention")
        # Reusable cable ends: a board form and an inline-part form (CAB-001).
        plug_variant = interface(
            "Demo 10-pin plug Console A AV",
            examples.console_pinout(signals, plug["revision_id"], "Console A AV"),
        )
        self.tally("pinout variant")
        rgb_plug_variant = interface(
            "Demo 21-pin RGB plug RGB input",
            examples.rgb_pinout(signals, rgb_plug["revision_id"], "sink"),
        )
        self.tally("pinout variant")
        shell = self.define("part", "Demo small round overmould shell")
        hood = self.define("part", "Demo 21-pin hood")
        end_a = interface(
            "Demo 10-pin DIN plug + AV adapter board + shell",
            examples.din_adapter_end(
                board["revision_id"],
                plug["revision_id"],
                plug_variant["revision_id"],
                shell["revision_id"],
            ),
        )
        end_b = interface(
            "Demo 21-pin RGB plug with inline blanking resistor + hood",
            examples.rgb_inline_end(
                rgb_plug["revision_id"], rgb_plug_variant["revision_id"], hood["revision_id"]
            ),
        )
        self.tally("end assembly")
        self.tally("end assembly")
        cable = self.call(
            "cable.create",
            {
                "workspace_id": self.ws,
                "name": "Demo console to RGB monitor cable",
                "cable": examples.av_demo_cable(
                    stock["revision_id"], end_a["revision_id"], end_b["revision_id"]
                ),
            },
        )
        self.freeze("cable.freeze", cable)
        self.tally("cable")

    def library(self) -> dict:
        symbols = self.source(
            "Demo symbol and footprint files",
            "demo/symbols.txt",
            b"Synthetic demo symbol and footprint text; not a real library.\n",
            "text/plain",
        )
        sheets = self.source(
            "Demo datasheets",
            "demo/datasheet.txt",
            b"Synthetic demo datasheet text; invented values only.\n",
            "text/plain",
        )
        sensor_a = self.define("part", "Demo sensor A", {"variant": "A"})
        sensor_b = self.define("part", "Demo sensor B", {"variant": "B"})
        resistor = self.define("part", "Demo resistor 10k")
        for part, number in ((sensor_a, "DEMO-SENSE-A"), (sensor_b, "DEMO-SENSE-B")):
            self.call(
                "catalog.register_variant",
                {
                    "revision_id": part["revision_id"],
                    "manufacturer": "Demo Components",
                    "part_number": number,
                    "association_basis": "Declared demo association; unqualified.",
                },
            )
        for part, kind, label, bundle, path in (
            (sensor_a, "symbol", "Demo sensor symbol", symbols, "demo/symbols.txt"),
            (sensor_a, "footprint", "Demo sensor footprint", symbols, "demo/symbols.txt"),
            (sensor_a, "datasheet", "Demo sensor datasheet", sheets, "demo/datasheet.txt"),
            (resistor, "symbol", "Demo resistor symbol", symbols, "demo/symbols.txt"),
        ):
            self.call(
                "catalog.register_representation",
                {
                    "revision_id": part["revision_id"],
                    "kind": kind,
                    "label": label,
                    "source_bundle_revision_id": bundle["revision_id"],
                    "source_path": path,
                    "rights_status": "cleared",
                },
            )
        self.call(
            "catalog.register_source_identifier",
            {
                "revision_id": sensor_a["revision_id"],
                "scheme": "library-id",
                "identifier": "Demo:SENSOR_A",
                "label": "Demo library symbol id",
                "rights_status": "unknown",
                "rights": "Demo note; rights not assessed",
            },
        )
        body_draft = self.call(
            "interface.create",
            {"workspace_id": self.ws, "name": "Demo connector body", "interface": BODY},
        )
        body = self.freeze("interface.freeze", body_draft)
        pinout_draft = self.call(
            "interface.create",
            {
                "workspace_id": self.ws,
                "name": "Demo connector pinout",
                "interface": {
                    "kind": "pinout",
                    "body_revision_id": body["revision_id"],
                    "review": "reviewed",
                    "review_basis": "Demo pin table",
                    "assignments": [
                        {"contact_id": "a", "electrical": {"signal": "sense"}},
                        {"contact_id": "b", "electrical": {"signal": "return"}},
                    ],
                },
            },
        )
        pinout = self.freeze("interface.freeze", pinout_draft)
        self.tally("connector")
        stock_draft = self.call(
            "wire_stock.create",
            {"workspace_id": self.ws, "name": "Demo three-core stock", "stock": STOCK},
        )
        stock = self.freeze("wire_stock.freeze", stock_draft)
        self.tally("wire stock")
        return {
            "sensor_a": sensor_a,
            "sensor_b": sensor_b,
            "resistor": resistor,
            "body": body,
            "pinout": pinout,
            "stock": stock,
        }

    def cable_and_harness(self, lib: dict) -> dict:
        stock, body, pinout = lib["stock"], lib["body"], lib["pinout"]
        cable_content = {
            "stock_revision_id": stock["revision_id"],
            "endpoints": [
                {
                    "local_id": side,
                    "body_revision_id": body["revision_id"],
                    "pinout_revision_id": pinout["revision_id"],
                }
                for side in ("left", "right")
            ],
            "assignments": [
                {
                    "endpoint_id": side,
                    "element_path": "stock.core",
                    "contact_id": contact,
                    "basis": "Demo terminal table",
                }
                for side, contact in (("left", "a"), ("right", "b"))
            ],
            "review": "reviewed",
            "review_basis": "Checked against the demo terminal table",
            "lengths": _length_plan(),
        }
        cable_draft = self.call(
            "cable.create",
            {"workspace_id": self.ws, "name": "Demo sensor cable", "cable": cable_content},
        )
        cable = self.freeze("cable.freeze", cable_draft)
        self.tally("cable")
        harness_content = {
            "sections": [
                {
                    "local_id": "shared",
                    "stock_revision_id": stock["revision_id"],
                    "planned_cut_length_mm": 100,
                    "cut_basis": "Explicit planned cut",
                },
                {
                    "local_id": "branch",
                    "stock_revision_id": stock["revision_id"],
                    "planned_cut_length_mm": 40,
                    "cut_basis": "Explicit branch cut",
                },
            ],
            "segments": [
                {"local_id": "trunk", "section_id": "shared"},
                {"local_id": "leg-one", "section_id": "shared", "element_paths": ["stock.core"]},
                {"local_id": "leg-two", "section_id": "branch"},
            ],
            "endpoints": [
                {
                    "local_id": name,
                    "body_revision_id": body["revision_id"],
                    "pinout_revision_id": pinout["revision_id"],
                }
                for name in ("input", "output")
            ],
            "joints": [
                {
                    "local_id": "input-land",
                    "kind": "termination",
                    "members": [_terminal("trunk", "a", "core"), _contact("input", "a")],
                    "basis": "Input table",
                },
                {
                    "local_id": "output-land",
                    "kind": "termination",
                    "members": [_terminal("leg-one", "b", "core"), _contact("output", "b")],
                    "basis": "Output table",
                },
            ],
            "review": "reviewed",
            "review_basis": "Demo harness review",
        }
        harness_draft = self.call(
            "harness.create",
            {"workspace_id": self.ws, "name": "Demo branch harness", "harness": harness_content},
        )
        harness = self.freeze("harness.freeze", harness_draft)
        self.tally("harness")
        profile_draft = self.call(
            "preparation.create",
            {
                "workspace_id": self.ws,
                "name": "Demo cut profile",
                "profile": _formula(stock["revision_id"]),
            },
        )
        profile = self.freeze("preparation.freeze", profile_draft)
        self.tally("preparation profile")
        return {"cable": cable, "harness": harness, "profile": profile}

    def assembly_and_plans(self, lib: dict, made: dict) -> dict:
        def assembly(name: str, occurrences: list[tuple[str, dict, str]]) -> dict:
            draft = self.call(
                "assembly.create",
                {
                    "workspace_id": self.ws,
                    "name": name,
                    "assembly": {
                        "occurrences": [
                            {"local_id": lid, "revision_id": rev["revision_id"], "display_ref": ref}
                            for lid, rev, ref in occurrences
                        ]
                    },
                },
            )
            self.tally("assembly")
            return self.freeze("assembly.freeze", draft)

        board_part = self.define("board", "Demo sensor board")
        # The board population: the board with its fitted components by reference designator.
        populated = assembly(
            "Demo populated board",
            [
                ("board", board_part, "PCB1"),
                ("sensor", lib["sensor_a"], "U1"),
                ("pullup", lib["resistor"], "R1"),
            ],
        )
        root = assembly(
            "Demo sensor node",
            [("left", populated, "A1"), ("right", populated, "A2")],
        )
        policy = lambda path, rev, decision: {  # noqa: E731
            "path": path,
            "revision_id": rev["revision_id"],
            "decision": decision,
            "basis": "Explicit demo planning decision",
        }
        plan = {
            "assembly_revision_id": root["revision_id"],
            "quantity": {"status": "known", "amount": 1},
            "policies": [
                policy([], root, "make"),
                policy(["left"], populated, "buy"),
                policy(["right"], populated, "make"),
                policy(["right", "resistor"], lib["resistor"], "buy"),
            ],
            "occurrence_demands": [
                {
                    "path": path,
                    "revision_id": rev["revision_id"],
                    "quantity": {"status": "known", "amount": 1, "unit": "ea"},
                    "basis": "Demo demand",
                    "waste": {
                        "quantity": {"status": "known", "amount": 0, "unit": "ea"},
                        "basis": "No spare declared",
                    },
                }
                for path, rev in ((["left"], populated),)
            ],
        }
        plan["policies"][3]["path"] = ["right", "pullup"]
        bom_draft = self.call(
            "bom.create", {"workspace_id": self.ws, "name": "Demo bill of materials", "bom": plan}
        )
        bom = self.freeze("bom.freeze", bom_draft)
        self.tally("bom")
        material_draft = self.call(
            "material_plan.create",
            {
                "workspace_id": self.ws,
                "name": "Demo material plan",
                "plan": {
                    "subject_revision_id": made["cable"]["revision_id"],
                    "quantity": 2,
                    "decision": "make",
                    "decision_basis": "Demo bench build decision",
                    "pieces": [
                        {
                            "installed": {
                                "amount_mm": "1000",
                                "basis": "Demo material declaration",
                            },
                            "extra_waste": {
                                "amount_mm": "5",
                                "basis": "Demo material declaration",
                            },
                            "cut_basis": "preparation_suggestion",
                            "profile_revision_id": made["profile"]["revision_id"],
                        }
                    ],
                },
            },
        )
        material = self.freeze("material_plan.freeze", material_draft)
        self.tally("material plan")
        return {
            "board": board_part,
            "populated": populated,
            "root": root,
            "bom": bom,
            "material": material,
        }

    def configuration(self, lib: dict, plans: dict) -> dict:
        def options(name: str) -> dict:
            return {
                "option_set": {
                    "target_revision_id": plans["root"]["revision_id"],
                    "constraints": [PAINT_NEEDS_SPLASH],
                    "options": [
                        {
                            "key": "sensor",
                            "label": "Sensor part",
                            "domain": "part",
                            "default_choice": "a",
                            "choices": [
                                {
                                    "key": "a",
                                    "label": "Sensor A",
                                    "revision_id": lib["sensor_a"]["revision_id"],
                                },
                                {
                                    "key": "b",
                                    "label": "Sensor B",
                                    "revision_id": lib["sensor_b"]["revision_id"],
                                },
                            ],
                        },
                        {
                            "key": "finish",
                            "label": "Enclosure finish",
                            "domain": "process",
                            "choices": [
                                {"key": "bead", "label": "Bead blast", "value": "bead-blast"},
                                {"key": "paint", "label": "Painted", "value": "powder-coat"},
                            ],
                        },
                        {
                            "key": "sealing",
                            "label": "Sealing requirement",
                            "domain": "requirement",
                            "required": False,
                            "choices": [
                                {"key": "splash", "label": "Splash", "value": "splash-resistant"}
                            ],
                        },
                    ],
                }
            }

        option_set = self.define("option_set", "Demo sensor node options", options("demo"))

        def configure(name: str, finish: str) -> dict:
            draft = self.call(
                "definition.create",
                {
                    "workspace_id": self.ws,
                    "kind": "configuration",
                    "name": name,
                    "content": {
                        "configuration": {
                            "option_set_revision_id": option_set["revision_id"],
                            "selections": [],
                        }
                    },
                },
            )
            current = self.call("configuration.resolve", {"draft_id": draft["draft_id"]})
            body = {
                **current["configuration"],
                "selections": [{"option_key": "finish", "choice_key": finish}],
            }
            updated = self.call(
                "draft.update",
                {"draft_id": draft["draft_id"], "changes": {"configuration": body}},
                state=current["state"],
            )
            self.tally("configuration")
            return {**draft, "state": updated["state"]}

        good = configure("Demo configuration, bead blast", "bead")
        reviewed = self.call("configuration.resolve", {"draft_id": good["draft_id"]})
        resolved = self.call(
            "configuration.capture",
            {
                "draft_id": good["draft_id"],
                "review_sha256": reviewed["review_sha256"],
                "basis": "Reviewed demo resolution",
            },
            state=reviewed["state"],
        )
        painted = configure("Demo configuration, painted", "paint")
        need = self.call(
            "configuration.propose_development",
            {
                "draft_id": painted["draft_id"],
                "rule_key": "paint-sealing",
                "need": "adapter_board",
                "name": "Demo sealing adapter board",
                "summary": "Develop a demo adapter so the sealing rule can be met.",
                "basis": "Demo review: the painted combination fails this rule.",
            },
        )
        self.tally("development need")
        return {"option_set": option_set, "resolved": resolved, "need": need}

    def inventory(self, lib: dict) -> dict:
        shelf = self.call(
            "inventory.create_location", {"workspace_id": self.ws, "name": "Demo shelf A"}
        )
        bin_ = self.call(
            "inventory.create_location", {"workspace_id": self.ws, "name": "Demo bin 1"}
        )
        self.tally("location")
        lot = self.call(
            "catalog.register_lot",
            {"revision_id": lib["resistor"]["revision_id"], "label": "Demo resistor reel"},
        )
        spool = self.call(
            "catalog.register_lot",
            {"revision_id": lib["stock"]["revision_id"], "label": "Demo cable spool"},
        )

        def assertion(quantity: dict, **extra) -> dict:
            return {
                "quantity": quantity,
                "reason": "Demo stock assertion",
                "assertion_source": "Demo receipt record",
                "assertion_status": "declared",
                **extra,
            }

        reel = self.call(
            "inventory.open_stock",
            assertion(
                {"amount": "100", "unit": "ea"},
                lot_id=lot["lot_id"],
                location_id=bin_["location_id"],
                dimension="count",
            ),
        )
        self.call(
            "inventory.open_stock",
            assertion(
                {"amount": "25", "unit": "m"},
                lot_id=spool["lot_id"],
                location_id=shelf["location_id"],
                dimension="length",
            ),
        )
        self.tally("stock account")
        self.call(
            "inventory.reserve",
            {
                "account_id": reel["account_id"],
                "quantity": {"amount": "10", "unit": "ea"},
                "purpose": "Demo build preparation",
            },
            state=reel["state"],
        )
        return {"lot": lot, "spool": spool}

    def units_and_evidence(self, lib: dict, plans: dict, stock: dict) -> dict:
        sensor = lib["sensor_a"]
        work = self.call(
            "inventory.create_work_batch",
            {
                "revision_id": plans["populated"]["revision_id"],
                "kind": "batch",
                "label": "Demo batch of three",
                "planned_units": 3,
            },
            key="demo-work-batch",
        )
        units = []
        for n in (1, 2):
            unit = self.call(
                "physical_units.register",
                {
                    "revision_id": plans["populated"]["revision_id"],
                    "serial": f"DEMO-{n:04d}",
                    "origin": "assembled",
                    "lot_id": None,
                    "assertion_source": "Demo bench traveler",
                    "assertion_status": "observed",
                },
                key=f"demo-unit-{n}",
            )
            linked = self.call(
                "physical_units.link_work",
                {
                    "unit_id": unit["unit_id"],
                    "work_batch_id": work["work_batch_id"],
                    "assertion_source": "Demo build traveler",
                    "assertion_status": "declared",
                },
                state=work["state"],
                key=f"demo-link-{n}",
            )
            work = linked["work_batch"]
            units.append(unit)
            self.tally("physical unit")
        test = self.call(
            "evidence.record_test",
            {
                "subject": {"kind": "physical_unit", "unit_id": units[0]["unit_id"]},
                "test_kind": "continuity",
                "procedure": "Demo bench continuity procedure; no actual test was performed.",
                "instruments": [
                    {"name": "Demo meter", "identifier": "M-1", "calibration": "unknown"}
                ],
                "conditions": [
                    {
                        "property": "ambient_temperature",
                        "status": "known",
                        "value": {
                            "kind": "quantity",
                            "dimension": "temperature",
                            "unit": "degC",
                            "magnitude": "22",
                        },
                    },
                    {"property": "humidity", "status": "unknown"},
                ],
                "observed_at": "2026-01-01T12:00:00Z",
                "criterion": "Every pair of mapped terminals conducts",
                "finding": "criterion_met",
            },
            key="demo-continuity-test",
        )
        self.tally("subject test")
        ledger = self.call(
            "facts.register_subject",
            {"target": {"kind": "revision", "revision_id": sensor["revision_id"]}},
        )
        self.call(
            "facts.append",
            {
                "subject_id": ledger["subject_id"],
                "fact": {
                    "property": "supply_current",
                    "status": "known",
                    "purpose": "rating",
                    "role": "nominal",
                    "value": {
                        "kind": "quantity",
                        "dimension": "current",
                        "unit": "mA",
                        "magnitude": "12",
                    },
                    "basis": "Demo assertion; no physical qualification.",
                    "provenance": {
                        "method": "source_observation",
                        "evidence": [{"kind": "citation", "citation": "Demo datasheet, table 1."}],
                    },
                },
            },
            state=ledger["state"],
        )
        self.tally("recorded evidence")
        return {"units": units, "test": test}

    def release(self, lib: dict, plans: dict, cfg: dict) -> dict:
        request = {
            "root_revision_id": plans["root"]["revision_id"],
            "quantity": 2,
            "resolved_configuration_ids": [cfg["resolved"]["resolved_configuration_id"]],
            "rights_reviews": [
                {"subject": f"design:{rid}", "decision": "permitted", "basis": "Demo original"}
                for rid in (plans["root"]["revision_id"], lib["sensor_a"]["revision_id"])
            ],
        }
        reviewed = self.call("release.review", request)
        release = self.call(
            "release.create",
            {
                **request,
                "name": "Demo release A",
                "reviewed_sha256": reviewed["sha256"],
                "acknowledgement": {"reason": "Demo release; open items are expected."},
            },
        )
        self.tally("release")
        warning = self.call(
            "release.warn",
            {
                "release_id": release["release_id"],
                "kind": "engineering",
                "severity": "caution",
                "title": "Demo advisory",
                "body": "A later synthetic advisory concerns this closure.",
            },
        )
        self.tally("release warning")
        return {"release": release, "warning": warning}

    def sourcing_knowledge_preferences(self, lib: dict, plans: dict) -> None:
        self.call(
            "sourcing.record_offer",
            {
                "workspace_id": self.ws,
                "revision_id": plans["populated"]["revision_id"],
                "supplier": "Demo Supply",
                "source": "Demo emailed quote",
                "review_basis": "Compared against the demo quote",
                "offered_on": (date.today() - timedelta(days=2)).isoformat(),
            },
        )
        self.tally("sourcing offer")
        note = self.call(
            "knowledge.create",
            {
                "workspace_id": self.ws,
                "kind": "note",
                "content": {"title": "Demo crimp note", "body": "Synthetic bench note."},
                "links": [
                    {"kind": "revision", "revision_id": lib["sensor_a"]["revision_id"]},
                ],
            },
        )
        decision = self.call(
            "knowledge.create",
            {
                "workspace_id": self.ws,
                "kind": "decision",
                "content": {
                    "title": "Demo sensor choice",
                    "body": "Sensor A is the demo default.",
                    "decision_status": "accepted",
                },
                "links": [
                    {"kind": "definition", "definition_id": lib["sensor_a"]["definition_id"]}
                ],
            },
        )
        del note, decision
        self.tally("knowledge note")
        self.tally("knowledge note")
        self.call(
            "preferences.set",
            {
                "workspace_id": self.ws,
                "scope": "workspace",
                "values": {
                    "preferred_suppliers": ["Demo Supply"],
                    "wire_colours": ["red", "black"],
                    "default_length_unit": "mm",
                },
            },
            state="preferences-v0",
        )
        self.tally("preferences")

    def integration(self, lib: dict, plans: dict) -> None:
        """A file-based supplier integration with one import run of dated observations.

        Rows name items by registered source identifier (never by revision id), so the
        Integrations lens and the Sourcing "External observations" section both show
        them. One row is rejected on purpose so rejection reporting is visible too.
        Declaring an integration is a workspace-admin decision; other accounts skip it.
        """
        member = WorkspaceMember.objects.filter(user=self.user, workspace=self.workspace).first()
        if member is None or Perm.WORKSPACE_ADMIN not in permissions_for(member):
            return
        for revision, identifier in (
            (plans["populated"], "DEMO-SKU-BOARD"),
            (lib["resistor"], "DEMO-SKU-RES10K"),
        ):
            self.call(
                "catalog.register_source_identifier",
                {
                    "revision_id": revision["revision_id"],
                    "scheme": "supplier-sku",
                    "identifier": identifier,
                    "label": "Demo supplier catalogue number",
                    "rights_status": "unknown",
                    "rights": "Demo note; rights not assessed",
                },
            )
        created = self.call(
            "integration.create",
            {
                "workspace_id": self.ws,
                "name": "Demo supplier price file",
                "ownership": {"supplier_offer": "external"},
                "columns": {
                    "identifier": "sku",
                    "supplier": "vendor",
                    "price_amount": "unit_price",
                },
            },
        )
        self.tally("integration")
        today = date.today()
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(
            [
                "scheme",
                "sku",
                "vendor",
                "supplier_ref",
                "offered_on",
                "unit_price",
                "price_currency",
                "price_unit",
                "availability",
                "lead_time_days",
            ]
        )
        rows = (
            ("DEMO-SKU-BOARD", "42.50", "USD", "ea", "in_stock", "3"),
            ("DEMO-SKU-RES10K", "0.04", "USD", "ea", "limited", "14"),
            ("DEMO-SKU-MISSING", "1.00", "USD", "ea", "unknown", ""),
        )
        for sku, price, currency, unit, availability, lead in rows:
            writer.writerow(
                [
                    "supplier-sku",
                    sku,
                    "Demo Supply",
                    f"REF-{sku[-4:]}",
                    (today - timedelta(days=1)).isoformat(),
                    price,
                    currency,
                    unit,
                    availability,
                    lead,
                ]
            )
        self.call(
            "integration.import",
            {
                "integration_id": created["integration_id"],
                "field": "supplier_offer",
                "file_name": "demo-supplier-prices.csv",
                "file_format": "csv",
                "content": out.getvalue(),
            },
        )
        self.tally("import run")

    def agent_run(self) -> None:
        run = self.call(
            "agent_run.create",
            {
                "workspace_id": self.ws,
                "title": "Demo draft cleanup",
                "purpose": "Draft one synthetic stock definition for review",
                "allowed_actions": ["definition.create"],
                "max_actions": 5,
                "deadline": (timezone.now() + timedelta(days=7)).isoformat(),
            },
        )["run"]
        step = self.call(
            "agent_run.act",
            {
                "run_id": run["run_id"],
                "step_key": "demo-draft",
                "operation": "definition.create",
                "payload": {
                    "workspace_id": self.ws,
                    "kind": "wire_stock",
                    "name": "Demo agent-drafted stock",
                    "content": {"gauge": "unknown"},
                },
            },
        )["step"]
        if step["outcome"] != "applied":
            raise SeedRefused(f"The demo agent step was not applied: {step['error']}")
        self.call("agent_run.complete", {"run_id": run["run_id"], "note": "Demo run finished."})
        self.tally("agent run")

    def projects(self, lib: dict, plans: dict, made: dict) -> None:
        def project(name: str, purpose: str) -> str:
            created = self.call(
                "project.create", {"workspace_id": self.ws, "name": name, "purpose": purpose}
            )
            self.tally("project")
            return created["project_id"]

        def reference(project_id: str, kind: str, target: str, role: str) -> None:
            current = self.call("project.references", {"project_id": project_id})
            self.call(
                "project.add_reference",
                {"project_id": project_id, "kind": kind, "target_id": target, "role": role},
                state=current["state"],
            )
            self.tally("project reference")

        one = project(PROJECT_ONE, "Demo project following the latest library items.")
        two = project(PROJECT_TWO, "Demo project pinned to exact revisions.")
        for definition, role in (
            (plans["root"], "root assembly"),
            (lib["sensor_a"], "sensor"),
            (made["cable"], "cable"),
        ):
            reference(one, "definition", definition["definition_id"], role)
        for revision, role in (
            (plans["root"], "pinned root assembly"),
            (lib["sensor_a"], "pinned sensor"),
            (made["harness"], "pinned harness"),
        ):
            reference(two, "revision", revision["revision_id"], role)


def is_seeded(workspace: Workspace) -> bool:
    return Project.objects.filter(workspace=workspace, name=PROJECT_ONE).exists()


def acting_user(username: str | None):
    """The account the demo data is created as; it must already exist and be allowed."""
    from specmate.access.models import Installation

    if username:
        row = (
            WorkspaceMember.objects.select_related("user", "workspace")
            .filter(user__username=username, user__is_active=True)
            .first()
        )
    else:
        owner = Installation.objects.filter(owner__isnull=False).select_related("owner").first()
        row = (
            WorkspaceMember.objects.select_related("user", "workspace")
            .filter(user=owner.owner)
            .first()
            if owner
            else None
        )
    if row is None:
        raise SeedRefused(
            "No account to act as. Create one first (manage.py create_account --role admin) "
            "or name an existing member with --username; seed_demo creates no accounts."
        )
    missing = [p.value for p in REQUIRED if p not in permissions_for(row)]
    if missing:
        raise SeedRefused(f"Account {row.user.get_username()} lacks: {', '.join(missing)}.")
    return row.user, row.workspace


def seed(user, workspace: Workspace) -> dict[str, int]:
    if is_seeded(workspace):
        raise SeedRefused("Demo data is already present; reset the installation to seed again.")
    s = Seeder(user, workspace)
    lib = s.library()
    s.av_interfaces()
    made = s.cable_and_harness(lib)
    plans = s.assembly_and_plans(lib, made)
    cfg = s.configuration(lib, plans)
    stock = s.inventory(lib)
    s.units_and_evidence(lib, plans, stock)
    s.release(lib, plans, cfg)
    s.sourcing_knowledge_preferences(lib, plans)
    s.integration(lib, plans)
    s.agent_run()
    s.projects(lib, plans, made)
    return s.created


def refuse_unless_empty(workspace: Workspace) -> None:
    if is_seeded(workspace):
        raise SeedRefused("Demo data is already present; reset the installation to seed again.")
    if Definition.objects.filter(workspace=workspace).exists():
        raise SeedRefused("--allow is for empty databases; this workspace already holds items.")


__all__ = ["SeedRefused", "acting_user", "is_seeded", "refuse_unless_empty", "seed"]
