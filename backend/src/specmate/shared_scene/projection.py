"""Fresh projections of authorized immutable state; no mesh/source parsing or mutation.

All occurrences survive missing geometry. Geometry resources can be shared, while
selection always includes root snapshot, contextual path and stable feature ID.
"""

import hashlib
import json
from uuid import UUID

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import get_snapshot, occurrence_result
from specmate.catalog_matching.queries import current_actor
from specmate.catalog_packs.authoring import authorize_origin
from specmate.design.models import Revision, Snapshot
from specmate.mechanical_sources.operations import evaluate, parse_content
from specmate.operations import NotFound, ValidationFailed
from specmate.pcb.models import PcbInterpretation
from specmate.pcb.population import review_payload
from specmate.pcb.report import Report
from specmate.shared_scene.transforms import IDENTITY, compose, millimeter_factor, placement_matrix
from specmate.sources.models import SourceBundleFile

MAX_FEATURES = 100000


def scene_snapshot(user, snapshot_id):
    # Own root provenance is distinct from the child references covered by Closure.
    root = Snapshot.objects.select_related("definition").filter(id=snapshot_id).first()
    if root is None:
        raise NotFound("Scene unavailable.")
    authorize(user, root.definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, root.definition)
    return get_snapshot(user, snapshot_id)


def list_scenes(user, workspace_id=None):
    from specmate.access.workspaces import actor_workspace_id

    user = current_actor(user)
    workspace = authorize(user, actor_workspace_id(user, workspace_id), Perm.WORKSPACE_READ)
    # Every member reads the whole collection, so membership alone decides the listing;
    # opening a scene still checks its exact closure and typed source authority.
    revisions = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition__workspace=workspace, definition__kind="assembly")
        .order_by("-frozen_at", "id")[:50]
    )
    rows = [
        {
            "snapshot_id": str(revision.snapshot_id),
            "revision_id": str(revision.id),
            "definition_id": str(revision.definition_id),
            "name": revision.definition.name,
            "number": revision.number,
        }
        for revision in revisions
    ]
    return {
        "workspace_id": str(workspace.id),
        "assemblies": rows,
        "window": "latest_50_frozen_revisions",
    }


def identity(revision):
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "snapshot_sha256": revision.snapshot.sha256,
        "kind": revision.definition.kind,
    }


def content_of(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


class Resources:
    def __init__(self, user, closure):
        self.user = user
        self.closure = closure
        self.resources = {}
        self.by_revision = {}
        self.feature_count = 0

    def revision(self, revision_id):
        # Closure has authorized every dependency before any resource is assembled.
        return self.closure.revisions[revision_id]

    def add(self, revision, local_id, data):
        resource = {"owner": identity(revision), "local_id": local_id, **data}
        digest = hashlib.sha256(
            json.dumps(resource, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        key = f"geometry:{digest}"
        self.resources[key] = {"geometry_id": key, **resource}
        return key

    def describe(self, revision, content):
        if revision.id in self.by_revision:
            return self.by_revision[revision.id]
        features, geometry_ids, provenance, limitations = [], [], [], []
        kind = revision.definition.kind

        def feature(local_id, role, label, data=None, geometry_id=None):
            self.feature_count += 1
            if self.feature_count > MAX_FEATURES:
                raise ValidationFailed("Scene exceeds the supported feature limit.")
            features.append(
                {
                    "feature_id": local_id,
                    "role": role,
                    "label": label,
                    "data": data or {},
                    "geometry_id": geometry_id,
                    "placement_status": "unknown",
                    "local_transform": None,
                    "world_transform": None,
                }
            )

        def stock_geometry(stock, local_id, length=None):
            specification = content_of(stock).get("stock")
            if specification is None:
                limitations.append("Pinned stock has no typed construction; geometry unknown.")
                return None

            def construction_features(element, prefix=""):
                path = prefix + element["id"]
                if element["kind"] == "group":
                    for child in element["children"]:
                        construction_features(child, path + ".")
                else:
                    feature(
                        local_id + ":element:" + path,
                        "stock_element",
                        element["label"],
                        {
                            "element_path": path,
                            "stock": identity(stock),
                            "declaration": element,
                        },
                    )

            construction_features(specification["structure"])
            return self.add(
                revision,
                local_id,
                {
                    "type": "wire_construction",
                    "role": "illustration",
                    "quality": "declared_dimensions",
                    "units": "mm",
                    "frame": "wire-local: axis +x; section x/y become local y/z",
                    "source": identity(stock),
                    "stock": specification,
                    "length_mm": length,
                    "limitations": [
                        "Straight stock illustration or section only; installed route unknown.",
                        "Declared construction is not measured geometry or a clearance envelope.",
                    ],
                },
            )

        if kind == "wire_stock":
            gid = stock_geometry(revision, "construction")
            if gid:
                geometry_ids.append(gid)
        elif kind == "cable":
            from specmate.cables.contracts import upgrade_content

            cable = upgrade_content(content["cable"])
            stock = self.revision(cable_stock_id(cable))
            length = ((cable.get("lengths") or {}).get("finished", {}).get("declaration", {})).get(
                "amount_mm"
            )
            gid = stock_geometry(stock, "construction", length)
            if gid:
                geometry_ids.append(gid)
            provenance.append({"role": "stock", **identity(stock)})
            for endpoint in cable["endpoints"]:
                pins = []
                if endpoint["end_assembly_revision_id"]:
                    pins.append(("end_assembly_revision_id", "endpoint_end_assembly", endpoint))
                for layer in (endpoint["stack"] or {}).get("layers", []):
                    pins += [
                        (field, role, layer)
                        for field, role in (
                            ("body_revision_id", "endpoint_body"),
                            ("pinout_revision_id", "endpoint_pinout"),
                            ("board_revision_id", "endpoint_board"),
                            ("part_revision_id", "endpoint_shell"),
                        )
                        if layer.get(field)
                    ]
                for field, role, source in pins:
                    provenance.append(
                        {
                            "role": role,
                            "endpoint_id": endpoint["local_id"],
                            **identity(self.revision(UUID(source[field]))),
                        }
                    )
                feature(
                    "endpoint:" + endpoint["local_id"], "endpoint", endpoint["local_id"], endpoint
                )
            for assignment in cable.get("assignments", []):
                feature(
                    "termination:" + assignment["endpoint_id"] + ":" + assignment["element_path"],
                    "termination",
                    f"{assignment['layer_id']}/{assignment['terminal_id']}",
                    assignment,
                )
            limitations.append("Endpoint placements and installed cable route are unknown.")
        elif kind == "harness":
            harness = content["harness"]
            for section in harness["sections"]:
                stock = self.revision(cable_stock_id(section))
                # Cut quantity describes a physical piece, not an installed route.
                gid = stock_geometry(stock, "section:" + section["local_id"])
                feature(
                    "section:" + section["local_id"],
                    "physical_section",
                    section["local_id"],
                    section,
                    gid,
                )
                provenance.append({"role": "section_stock", **identity(stock)})
            for collection, role in (
                ("segments", "segment"),
                ("endpoints", "endpoint"),
                ("joints", "joint"),
                ("breakouts", "breakout"),
            ):
                for row in harness.get(collection, []):
                    feature(role + ":" + row["local_id"], role, row["local_id"], row)
            limitations.append(
                "Harness sections retain shared physical identity; spatial routes "
                "and feature placements are unknown."
            )
        elif kind == "pcb_population":
            population = content["pcb_population"]
            interpretation = PcbInterpretation.objects.get(id=population["interpretation_id"])
            report = Report.model_validate_json(bytes(interpretation.canonical))
            source_file = SourceBundleFile.objects.select_related("blob").get(
                revision_id=population["source_revision_id"],
                path=interpretation.attempt.intake.board_path,
            )
            provenance.append(
                {
                    "role": "native_board",
                    "interpretation_id": str(interpretation.id),
                    "interpretation_sha256": interpretation.sha256,
                    "source_revision_id": population["source_revision_id"],
                    "source_manifest_sha256": population["source_manifest_sha256"],
                    "source_sha256": report.source_sha256,
                    "source_path": source_file.path,
                    "source_rights": source_file.rights,
                    "adapter": report.adapter,
                    "tool_version": report.tool_version,
                    "units": report.units,
                    "frame": report.coordinate_frame,
                }
            )
            reviewed = review_payload(self.user, revision.definition, content)
            for row in reviewed["associations"]:
                target = row["target"]
                resolved = self.revision(UUID(target["revision_id"]))
                provenance.append({"role": "association", **row, "target_pin": identity(resolved)})
            gaps = report.outline_bridged_gaps or []
            bridged_note = (
                [
                    f"{len(gaps)} outline gap(s) bridged with straight chords "
                    f"(max {max(g.size_mm for g in gaps)} mm); marked on the board."
                ]
                if gaps
                else []
            )
            gid = self.add(
                revision,
                "board-plane",
                {
                    "type": "pcb_planar",
                    "role": "illustration",
                    "quality": "native_extracted_planar",
                    "units": "mm",
                    "frame": "illustration plane: native x/y -> local x/-y; depth is not inferred",
                    "outline": [[[x, -y, 0] for x, y in polygon] for polygon in report.outline],
                    "cutouts": [[[x, -y, 0] for x, y in polygon] for polygon in report.cutouts],
                    "outline_tolerance_mm": report.outline_tolerance_mm,
                    "outline_bridged_gaps": [
                        {
                            "at": [g.at[0], -g.at[1], 0],
                            "to": [g.to[0], -g.to[1], 0],
                            "size_mm": g.size_mm,
                        }
                        for g in report.outline_bridged_gaps or []
                    ],
                    "coverage": report.coverage.model_dump(mode="json"),
                    "source": provenance[0],
                    "limitations": [
                        "Planar drawing only; thickness, component envelopes "
                        "and local datum correspondence unknown.",
                        *bridged_note,
                        *report.unsupported,
                    ],
                },
            )
            geometry_ids.append(gid)
            for row in report.components:
                feature(
                    "component:" + str(row.id),
                    "native_component",
                    row.reference,
                    {
                        **row.model_dump(mode="json"),
                        "population_options": [
                            {"option_id": option["local_id"], "status": decision["status"]}
                            for option in population["options"]
                            for decision in option["decisions"]
                            if decision["component_id"] == str(row.id)
                        ],
                        "associations": [
                            a
                            for a in population["associations"]
                            if a["component_id"] == str(row.id)
                        ],
                    },
                )
            for row in report.pads:
                feature(
                    "pad:" + str(row.id), "native_pad", row.terminal, row.model_dump(mode="json")
                )
            limitations.append(
                "Population options remain explicit; no option or 3D component "
                "placement is guessed."
            )
        elif kind == "mechanical_source":
            declaration = parse_content(content, kind)
            evaluated = evaluate(self.user, revision.definition, declaration)
            provenance.extend({"role": "source", **row} for row in evaluated["sources"])
            provenance.extend({"role": "target", **row} for row in evaluated["targets"])
            for model in evaluated["models"]:
                source_pin = next(
                    pin for pin in declaration.sources if pin.local_id == model["source_local_id"]
                )
                preview = (
                    model["path"].lower().endswith(".glb")
                    and millimeter_factor(model["units"]) is not None
                    and model["frame"] in {"right_handed_y_up", "right_handed_z_up"}
                )
                resource = {
                    "representation_id": model["representation_id"],
                    "source_bundle_revision_id": str(source_pin.source_revision_id),
                    "source_path": model["path"],
                    "sha256": model["sha256"],
                    "rights": model["rights"],
                    "rights_status": "unknown",
                    "kind": "model",
                    "label": model["label"],
                }
                gid = self.add(
                    revision,
                    "model:" + model["local_id"],
                    {
                        "type": "model_preview" if preview else "unavailable_model",
                        "role": model["purpose"],
                        "quality": "declared_preview" if preview else "declared_unextracted",
                        "units": model["units"],
                        "frame": model["frame"],
                        "millimeter_factor": millimeter_factor(model["units"]),
                        "source": model,
                        **({"representation": resource} if preview else {}),
                        "limitations": [
                            "Preview is illustrative only; target frame correspondence, fit, "
                            "clearance and manufacturing remain unverified."
                        ],
                    },
                )
                feature("model:" + model["local_id"], "model", model["label"], model, gid)
            for target in evaluated["targets"]:
                feature("target:" + target["local_id"], "target", target["name"], target)
            limitations.extend(evaluated["limitations"])
            limitations.append(
                "Manufacturing, clearance and illustration model purposes "
                "remain separate; browser previews provide no geometry qualification."
            )
        elif kind in {"connector_body", "pinout", "interface_map"}:
            interface = content["interface"]
            collection, key = {
                "connector_body": ("contacts", "contact_id"),
                "pinout": ("assignments", "contact_id"),
                "interface_map": ("passages", "local_id"),
            }[kind]
            for row in interface.get(collection, []):
                feature("interface:" + row[key], "interface", row[key], row)
            limitations.append(
                "Interface drawing coordinates do not establish a 3D body or placement."
            )
        elif kind == "firmware":
            provenance.append({"role": "firmware_declaration", **content["firmware"]})
            limitations.append(
                "Firmware has exact source/target identity and no physical geometry."
            )
        elif kind != "assembly":
            limitations.append(
                "This discipline has no supported geometry projection; exact identity is retained."
            )

        if not geometry_ids and not any(f["geometry_id"] for f in features):
            limitations.append("Geometry is unavailable; this occurrence remains inspectable.")
        result = {
            "geometry_ids": geometry_ids,
            "features": features,
            "provenance": provenance,
            "limitations": limitations,
        }
        self.by_revision[revision.id] = result
        return result


def cable_stock_id(content):
    return UUID(content["stock_revision_id"])


def read_scene(user, snapshot_id):
    user = current_actor(user)
    snapshot, closure = scene_snapshot(user, snapshot_id)
    # A captured draft is not a frozen assembly. Keep this API's semantics exact.
    root_revision = Revision.objects.filter(snapshot=snapshot).first()
    if root_revision is None:
        raise ValidationFailed("Shared scene requires a frozen assembly revision.")
    return _project_scene(user, snapshot, closure, identity(root_revision))


def preview_captured_scene(user, snapshot_id):
    """Inspect an immutable capture without promoting it to a frozen revision.

    The capture's stored draft version remains its basis even after later edits or
    freezing. This read does not establish fit, clearance or manufacturing approval.
    """
    user = current_actor(user)
    snapshot, closure = scene_snapshot(user, snapshot_id)
    result = _project_scene(
        user,
        snapshot,
        closure,
        {
            "definition_id": str(snapshot.definition_id),
            "snapshot_sha256": snapshot.sha256,
            "kind": snapshot.definition.kind,
        },
    )
    result["basis"] = {
        "kind": "captured_draft",
        "draft_id": str(snapshot.draft_id),
        "draft_version": snapshot.draft_version,
        "snapshot_id": str(snapshot.id),
        "snapshot_sha256": snapshot.sha256,
    }
    return result


def _project_scene(user, snapshot, closure, root):
    resources = Resources(user, closure)
    transforms = {(): IDENTITY}
    nodes = []
    feature_count = 0
    for path, node in closure.nodes.items():
        result = occurrence_result(snapshot, node, closure.assignments.get(path))
        local = placement_matrix(node.occurrence.placement)
        world = compose(transforms[path[:-1]], local)
        transforms[path] = world
        described = resources.describe(node.revision, node.content)
        feature_count += len(described["features"])
        if feature_count > MAX_FEATURES:
            raise ValidationFailed("Scene exceeds the supported contextual feature limit.")
        result.update(described)
        result["node_id"] = json.dumps([str(snapshot.id), list(path)], separators=(",", ":"))
        result["parent_path"] = list(path[:-1])
        result["local_transform"] = local
        result["world_transform"] = world
        result["world_status"] = "known" if world is not None else "unknown"
        result["placement_limit"] = (
            None if world is not None else "Local placement or an ancestor placement is unknown."
        )
        result["features"] = [
            {**f, "address": {**result["address"], "feature_id": f["feature_id"]}}
            for f in described["features"]
        ]
        assigned = (
            closure.assignments.get(path) or node.occurrence.assignments
        ).firmware_revision_id
        result["firmware"] = (
            {
                **identity(closure.revisions[assigned]),
                "declaration": content_of(closure.revisions[assigned])["firmware"],
            }
            if assigned
            else None
        )
        nodes.append(result)
    return {
        "schema_version": "1",
        "snapshot_id": str(snapshot.id),
        "sha256": snapshot.sha256,
        "root": {**root, "world_transform": IDENTITY},
        "units": "mm",
        "frame": "right_handed_z_up",
        "matrix_convention": "row-major; column vectors; parent-from-local",
        "nodes": nodes,
        "geometry": list(resources.resources.values()),
        "relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in closure.relationships
        ],
        "qualification": {
            "fit": "not_evaluated",
            "clearance": "not_evaluated",
            "manufacturing": "not_evaluated",
            "physical": False,
        },
    }
