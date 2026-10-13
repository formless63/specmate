"""Firmware dependencies tied to an exact frozen board population and pin assumptions.

The board report is accepted through the shared PCB operations with simulated successful
runner output, as in the PCB tests. No compiler or flashing tool is installed or run.
"""

import copy
from uuid import uuid4

import pytest
from django.test import Client

from specmate.access.models import Membership
from specmate.design.models import Revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.sources.models import SourceBlob, SourceBundleFile

from .conftest import op
from .test_pcb import (  # noqa: F401
    attempt,
    digest,
    intake,
    recipe,
    report_payload,
    source,
    successful_output,
)
from .test_sources import register

MCU, LED, CONN, OPT = (str(uuid4()) for _ in range(4))
PADS = {name: str(uuid4()) for name in ("io2", "io4", "tx", "rx", "gnd", "hole", "led", "conn")}
MAIN = b"void setup() {}\nvoid loop() {}\n"
CONFIG = b"[env:synthetic]\nboard = synthetic_board\n"


def component(uid, ref, value, x):
    return {
        "id": uid,
        "reference": ref,
        "value": value,
        "footprint": f"Synthetic_{ref}",
        "position": [x, 5],
        "rotation_deg": 0,
        "side": "front",
        "dnp": False,
        "exclude_from_bom": False,
    }


def pad(uid, owner, ref, number, net, kind="smd"):
    return {
        "id": uid,
        "component_id": owner,
        "number": number,
        "terminal": f"{ref}.{number}",
        "position": [0, 0],
        "size": [1, 1],
        "drill": [0.8, 0.8] if kind == "npth" else [0, 0],
        "rotation_deg": 0,
        "type": kind,
        "shape": "rect",
        "net": net,
        "layers": ["F.Cu"],
    }


@pytest.fixture
def board(users, project, attempt):  # noqa: F811
    report = copy.deepcopy(report_payload())
    report["components"] = [
        component(MCU, "U1", "SYNTH-MCU", 10),
        component(LED, "D1", "LED", 20),
        component(CONN, "J1", "Conn", 30),
        component(OPT, "R9", "0R", 40),
    ]
    report["pads"] = [
        pad(PADS["io2"], MCU, "U1", "2", "LED_DRIVE"),
        pad(PADS["io4"], MCU, "U1", "4", ""),
        pad(PADS["tx"], MCU, "U1", "5", "UART_TX"),
        pad(PADS["rx"], MCU, "U1", "6", "UART_RX"),
        pad(PADS["gnd"], MCU, "U1", "7", "GND"),
        pad(PADS["hole"], MCU, "U1", "8", "", "npth"),
        pad(PADS["led"], LED, "D1", "1", "LED_DRIVE"),
        pad(PADS["conn"], CONN, "J1", "1", "UART_TX"),
    ]
    report["copper_nets"] = {
        "GND": ["U1.7"],
        "LED_DRIVE": ["D1.1", "U1.2"],
        "UART_RX": ["U1.6"],
        "UART_TX": ["J1.1", "U1.5"],
    }
    report["mounting_holes"] = [
        {
            "pad_id": PADS["hole"],
            "position": [0, 0],
            "drill": [0.8, 0.8],
            "mounting_status": "candidate-not-reviewed",
        }
    ]
    successful_output(attempt, report)
    interpretation = op(
        users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]}
    )
    created = op(
        users["editor"],
        "pcb.population_create",
        {"interpretation_id": interpretation["interpretation_id"], "name": "Controller fit"},
    )
    population = copy.deepcopy(created["content"]["pcb_population"])
    decisions = {MCU: "populate", LED: "populate", CONN: "populate", OPT: "omit"}
    population["options"][0]["decisions"] = [
        {"component_id": cid, "status": status, "basis": "Synthetic fit review"}
        for cid, status in decisions.items()
    ]
    population["options"].append(
        {
            "local_id": "no-mcu",
            "name": "Bare board",
            "decisions": [
                {"component_id": MCU, "status": "omit", "basis": "Bare board variant"},
                *({"component_id": cid, "status": None, "basis": None} for cid in (LED, CONN, OPT)),
            ],
        }
    )
    updated = op(
        users["editor"],
        "pcb.population_update",
        {"draft_id": created["draft_id"], "population": population},
        expected_state=created["state"],
    )
    frozen = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": created["draft_id"]},
        expected_state=updated["state"],
    )
    return frozen, created


@pytest.fixture
def sources(users, project):
    files = []
    for path, data in (("src/main.cpp", MAIN), ("platformio.ini", CONFIG)):
        register(users["editor"], project, data)
        files.append(
            {"path": path, "sha256": digest(data), "media_type": "text/plain", "rights": "MIT"}
        )
    return op(
        users["editor"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Synthetic firmware sources", "files": files},
    )


def declaration(sources, board, pins=None, **target):
    frozen, _ = board
    return {
        "sources": [
            {
                "local_id": "app",
                "source_revision_id": sources["revision_id"],
                "source_manifest_sha256": sources["manifest_sha256"],
                "files": [
                    {
                        "path": "src/main.cpp",
                        "sha256": digest(MAIN),
                        "rights": "MIT",
                        "role": "application",
                    },
                    {
                        "path": "platformio.ini",
                        "sha256": digest(CONFIG),
                        "rights": "MIT",
                        "role": "configuration",
                    },
                ],
            }
        ],
        "configuration": [
            {"key": "LED_BLINK_MS", "status": "known", "value": "500"},
            {"key": "WIFI_PASSWORD", "status": "secret_reference"},
        ],
        "toolchain": {
            "family": "platformio",
            "name": "PlatformIO Core",
            "version": "6.1.18",
            "board_id": "synthetic_board",
        },
        "target": {
            "population_revision_id": frozen["revision_id"],
            "option_id": "default",
            "component_id": MCU,
            "declared_part": "SYNTH-MCU",
            **target,
        },
        "pins": pins
        if pins is not None
        else [
            {
                "signal": "LED",
                "pad_id": PADS["io2"],
                "function": "gpio_out",
                "expected_net": "LED_DRIVE",
                "peer_pad_id": PADS["led"],
            },
            {
                "signal": "CONSOLE_TX",
                "pad_id": PADS["tx"],
                "function": "uart_tx",
                "peripheral": "uart0",
                "expected_net": "UART_TX",
                "peer_pad_id": PADS["conn"],
            },
        ],
    }


def create(users, project, firmware, **ctx):
    return op(
        users["editor"],
        "firmware.create",
        {"project_id": project, "name": "Synthetic controller firmware", "firmware": firmware},
        **ctx,
    )


def statuses(evaluation, code):
    return [f["status"] for f in evaluation["findings"] if f["code"] == code]


def test_exact_declarations_freeze_without_claiming_a_build(users, project, sources, board):
    draft = create(users, project, declaration(sources, board))
    read = op(users["viewer"], "firmware.read", {"draft_id": draft["draft_id"]})
    evaluation = read["evaluation"]
    assert evaluation["readiness"] == "declared"
    assert evaluation["toolchain_support"] == "declared_not_verified"
    assert (
        evaluation["compilation"] == "not_performed" and evaluation["flashing"] == "not_performed"
    )
    assert statuses(evaluation, "target_population") == ["valid"]
    assert statuses(evaluation, "pin_net") == ["valid", "valid"]
    assert statuses(evaluation, "pin_peer") == ["valid", "valid"]
    assert set(statuses(evaluation, "pin_capability")) == {"not_evaluated"}
    assert statuses(evaluation, "target_part") == ["not_evaluated"]
    assert evaluation["target"]["component"]["reference"] == "U1"
    assert evaluation["sources"][0]["manifest_sha256"] == sources["manifest_sha256"]
    secret = read["content"]["firmware"]["configuration"][1]
    assert secret == {"key": "WIFI_PASSWORD", "status": "secret_reference", "value": None}

    frozen = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        idempotency_key="freeze",
    )
    assert frozen["compilation"] == "not_performed" and frozen["readiness"] == "declared"
    revision = Revision.objects.get(id=frozen["revision_id"])
    pins = set(revision.snapshot.dependencies.values_list("revision_id", flat=True))
    assert str(board[0]["revision_id"]) in {str(p) for p in pins}
    replay = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        idempotency_key="freeze",
    )
    assert replay == frozen
    # The frozen revision keeps its exact pins independently of later draft edits.
    edited = declaration(sources, board, pins=[])
    op(
        users["editor"],
        "firmware.update",
        {"draft_id": draft["draft_id"], "firmware": edited},
        expected_state=frozen["draft"]["state"],
    )
    historic = op(users["viewer"], "firmware.read", {"revision_id": frozen["revision_id"]})
    assert len(historic["content"]["firmware"]["pins"]) == 2
    assert historic["snapshot_sha256"] == frozen["sha256"]


@pytest.mark.parametrize(
    "target, code",
    [
        ({"option_id": "no-mcu"}, "target_population"),
        ({"component_id": LED}, "pin_pad"),
        ({"component_id": str(uuid4())}, "target_component"),
        ({"option_id": "missing"}, "target_option"),
    ],
)
def test_wrong_target_fails_before_freeze(users, project, sources, board, target, code):
    draft = create(users, project, declaration(sources, board, **target))
    evaluation = op(users["editor"], "firmware.read", {"draft_id": draft["draft_id"]})["evaluation"]
    assert "invalid" in statuses(evaluation, code)
    assert evaluation["readiness"] == "blocked"
    with pytest.raises(ValidationFailed, match="cannot be frozen") as failure:
        op(
            users["owner"],
            "firmware.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    assert any(f["code"] == code for f in failure.value.details["findings"])


@pytest.mark.parametrize(
    "pin, code",
    [
        ({"signal": "X", "pad_id": PADS["led"], "function": "gpio_out"}, "pin_pad"),
        ({"signal": "X", "pad_id": PADS["hole"], "function": "gpio_out"}, "pin_pad"),
        (
            {"signal": "X", "pad_id": PADS["rx"], "function": "uart_rx", "expected_net": "UART_TX"},
            "pin_net",
        ),
        (
            {
                "signal": "X",
                "pad_id": PADS["gnd"],
                "function": "gpio_in",
                "peer_pad_id": PADS["led"],
            },
            "pin_peer",
        ),
        ({"signal": "X", "pad_id": PADS["io2"], "function": "gpio_in"}, "pin_pad"),
        (
            {"signal": "X", "pad_id": PADS["rx"], "function": "uart_tx", "peripheral": "uart0"},
            "peripheral",
        ),
    ],
)
def test_incompatible_pin_assignment_fails_validation(users, project, sources, board, pin, code):
    pins = declaration(sources, board)["pins"] + [pin]
    draft = create(users, project, declaration(sources, board, pins=pins))
    evaluation = op(users["editor"], "firmware.read", {"draft_id": draft["draft_id"]})["evaluation"]
    assert "invalid" in [
        f["status"] for f in evaluation["findings"] if f["subject"].get("signal") == "X"
    ]
    assert any(f["code"] == code and f["status"] == "invalid" for f in evaluation["findings"])
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "firmware.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )


def test_unknowns_stay_explicit_and_labels_never_match(users, project, sources, board):
    pins = [
        {"signal": "SPARE", "pad_id": None, "function": "gpio_in"},
        {
            "signal": "SENSE",
            "pad_id": PADS["io4"],
            "function": "analog_in",
            "expected_net": "SENSE",
        },
        {"signal": "BUS_SDA", "pad_id": PADS["rx"], "function": "i2c_sda"},
    ]
    firmware = declaration(sources, board, pins=pins)
    firmware["toolchain"]["version"] = None
    firmware["configuration"].append({"key": "SENSOR_ADDR", "status": "unknown"})
    draft = create(users, project, firmware)
    evaluation = op(users["editor"], "firmware.read", {"draft_id": draft["draft_id"]})["evaluation"]
    assert evaluation["readiness"] == "declared_with_unknowns"
    by_signal = {
        (f["subject"].get("signal"), f["code"]): f["status"] for f in evaluation["findings"]
    }
    assert by_signal[("SPARE", "pin_pad")] == "unknown"
    assert by_signal[("SENSE", "pin_net")] == "unknown"  # blank reported net is not a match
    assert by_signal[("BUS_SDA", "peripheral")] == "unknown"
    assert statuses(evaluation, "toolchain_version") == ["unknown"]
    assert statuses(evaluation, "configuration") == ["unknown"]
    frozen = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    assert frozen["readiness"] == "declared_with_unknowns"


def test_exact_source_pins_and_contract_shape_are_enforced(users, project, sources, board):
    firmware = declaration(sources, board)
    firmware["sources"][0]["files"][0]["sha256"] = digest(b"other bytes")
    with pytest.raises(ValidationFailed, match="does not match its exact revision"):
        create(users, project, firmware)
    firmware = declaration(sources, board)
    firmware["configuration"][1]["value"] = "never stored"
    with pytest.raises(ValidationFailed):
        create(users, project, firmware)
    firmware = declaration(sources, board)
    firmware["sources"][0]["files"] = [{**firmware["sources"][0]["files"][1]}]
    with pytest.raises(ValidationFailed):
        create(users, project, firmware)
    # A design revision of another kind is not a board target.
    other = op(
        users["owner"], "definition.create", {"project_id": project, "kind": "board", "name": "x"}
    )
    revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": other["draft_id"]},
        expected_state=other["state"],
    )
    with pytest.raises(ValidationFailed, match="frozen PCB population"):
        create(
            users,
            project,
            declaration(sources, board, population_revision_id=revision["revision_id"]),
        )


def test_draft_concurrency_and_authority_precede_retained_outcomes(users, project, sources, board):
    draft = create(users, project, declaration(sources, board), idempotency_key="create")
    assert create(users, project, declaration(sources, board), idempotency_key="create") == draft
    update = {"draft_id": draft["draft_id"], "firmware": declaration(sources, board, pins=[])}
    first = op(
        users["editor"],
        "firmware.update",
        update,
        expected_state=draft["state"],
        idempotency_key="update",
    )
    with pytest.raises(Conflict):
        op(users["owner"], "firmware.update", update, expected_state=draft["state"])
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "firmware.update",
            {**update, "firmware": declaration(sources, board)},
            expected_state=draft["state"],
            idempotency_key="update",
        )
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "firmware.update", update, expected_state=first["state"])
    with pytest.raises(NotFound):
        op(users["outsider"], "firmware.read", {"draft_id": draft["draft_id"]})
    Membership.objects.filter(project_id=project, user=users["editor"]).update(role="viewer")
    for firmware in (declaration(sources, board, pins=[]), declaration(sources, board)):
        with pytest.raises(PermissionDenied):
            op(
                users["editor"],
                "firmware.update",
                {**update, "firmware": firmware},
                expected_state=draft["state"],
                idempotency_key="update",
            )
    Membership.objects.filter(project_id=project, user=users["editor"]).update(role="editor")
    # A foreign blob in a pinned source's closure hides the firmware before diagnostics.
    other = op(users["outsider"], "project.create", {"name": "Foreign"})["project_id"]
    register(users["outsider"], other, b"foreign")
    SourceBundleFile.objects.create(
        revision_id=sources["revision_id"],
        path="foreign.bin",
        media_type="x",
        rights="private",
        blob=SourceBlob.objects.get(project_id=other),
    )
    with pytest.raises(NotFound):
        op(users["editor"], "firmware.read", {"draft_id": draft["draft_id"]})
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "firmware.update",
            update,
            expected_state=first["state"],
            idempotency_key="update",
        )


def test_assembly_assignment_review_detects_wrong_target(users, project, sources, board):
    frozen_board, created = board
    draft = create(users, project, declaration(sources, board))
    firmware = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    # A second population revision of the same board is a different exact target.
    second = op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": created["draft_id"]},
        expected_state=Revision.objects.get(id=frozen_board["revision_id"])
        .definition.drafts.get()
        .state_token,
    )
    placeholder = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "firmware", "name": "TBD"},
    )
    placeholder = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": placeholder["draft_id"]},
        expected_state=placeholder["state"],
    )

    def occurrence(local_id, revision_id, firmware_id):
        return {
            "local_id": local_id,
            "revision_id": revision_id,
            "display_ref": "A1",
            "assignments": {"firmware_revision_id": firmware_id},
        }

    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "project_id": project,
            "name": "Synthetic controller pair",
            "assembly": {
                "occurrences": [
                    occurrence("matched", frozen_board["revision_id"], firmware["revision_id"]),
                    occurrence("other", second["revision_id"], firmware["revision_id"]),
                    occurrence("pending", frozen_board["revision_id"], placeholder["revision_id"]),
                ],
                "relationships": [],
            },
        },
    )
    snapshot = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    review = op(
        users["viewer"],
        "firmware.assignment_review",
        {"assembly_snapshot_id": snapshot["snapshot_id"]},
    )
    assert {tuple(r["path"]): r["status"] for r in review["assignments"]} == {
        ("matched",): "valid",
        ("other",): "invalid",
        ("pending",): "invalid",
    }
    assert review["compilation"] == "not_performed"
    client = Client()
    client.force_login(users["viewer"])
    http = client.get(f"/api/v0/pcb/assemblies/{snapshot['snapshot_id']}/firmware-review")
    assert http.status_code == 200 and len(http.json()["assignments"]) == 3
    listed = client.get(f"/api/v0/pcb/projects/{project}/firmware")
    assert {row["name"] for row in listed.json()["firmware"]} >= {"Synthetic controller firmware"}
    targets = client.get(f"/api/v0/pcb/projects/{project}/firmware-targets").json()["targets"]
    assert {t["revision_id"] for t in targets} == {
        frozen_board["revision_id"],
        second["revision_id"],
    }
    detail = client.get(f"/api/v0/pcb/firmware-revisions/{firmware['revision_id']}")
    assert detail.status_code == 200 and detail.json()["evaluation"]["readiness"] == "declared"


def test_all_source_authority_precedes_pin_diagnostics(users, project, sources, board):
    other = op(users["outsider"], "project.create", {"name": "Foreign"})["project_id"]
    register(users["outsider"], other, MAIN)
    hidden = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "project_id": other,
            "name": "Hidden sources",
            "files": [
                {
                    "path": "src/main.cpp",
                    "sha256": digest(MAIN),
                    "media_type": "text/plain",
                    "rights": "MIT",
                }
            ],
        },
    )
    firmware = declaration(sources, board)
    firmware["sources"][0]["source_manifest_sha256"] = "0" * 64
    firmware["sources"].append(
        {
            **firmware["sources"][0],
            "local_id": "hidden",
            "source_revision_id": hidden["revision_id"],
        }
    )
    with pytest.raises(NotFound):
        create(users, project, firmware)


def test_frozen_firmware_read_rechecks_retained_snapshot_dependencies(
    users, project, sources, board
):
    from specmate.design.models import SnapshotDependency

    draft = create(users, project, declaration(sources, board))
    frozen = op(
        users["owner"],
        "firmware.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    other = op(users["outsider"], "project.create", {"name": "Private origin"})["project_id"]
    origin = op(
        users["outsider"],
        "definition.create",
        {
            "project_id": other,
            "kind": "board",
            "name": "Retained origin",
        },
    )
    revision = op(
        users["outsider"],
        "draft.freeze",
        {"draft_id": origin["draft_id"]},
        expected_state=origin["state"],
    )
    # Retained provenance pins must be authorized even when not part of the target.
    SnapshotDependency.objects.create(
        snapshot=Revision.objects.get(id=frozen["revision_id"]).snapshot,
        revision_id=revision["revision_id"],
    )
    with pytest.raises(NotFound):
        op(users["viewer"], "firmware.read", {"revision_id": frozen["revision_id"]})


def test_replay_authorizes_old_result_after_draft_moves_to_new_sources(
    users, project, sources, board
):
    draft = create(users, project, declaration(sources, board), idempotency_key="retained")
    replacement = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Replacement source",
            "files": [
                {
                    "path": "src/main.cpp",
                    "sha256": digest(MAIN),
                    "media_type": "text/plain",
                    "rights": "MIT",
                },
                {
                    "path": "platformio.ini",
                    "sha256": digest(CONFIG),
                    "media_type": "text/plain",
                    "rights": "MIT",
                },
            ],
        },
    )
    new = declaration(replacement, board)
    op(
        users["editor"],
        "firmware.update",
        {"draft_id": draft["draft_id"], "firmware": new},
        expected_state=draft["state"],
    )
    other = op(users["outsider"], "project.create", {"name": "Private source origin"})["project_id"]
    register(users["outsider"], other, b"private source")
    SourceBundleFile.objects.create(
        revision_id=sources["revision_id"],
        path="unavailable.bin",
        media_type="x",
        rights="private",
        blob=SourceBlob.objects.get(project_id=other),
    )
    # The current draft and changed request are readable, but the key's retained
    # source closure is not. Denial must precede the otherwise applicable mismatch.
    assert op(users["editor"], "firmware.read", {"draft_id": draft["draft_id"]})
    with pytest.raises(NotFound):
        create(users, project, new, idempotency_key="retained")
