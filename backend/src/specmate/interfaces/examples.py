"""Synthetic audio/video interface examples for tests and the demo seed.

Every name, pin assignment and value here is invented for illustration. The pin layouts
are deliberately not copied from any real device or connector standard, and the values
are illustrative declarations, not datasheet facts.
"""

BASIS = "Synthetic illustrative value"


def _level(nominal, unit):
    return {"status": "known", "nominal": nominal, "unit": unit, "basis": BASIS}


def _ohm(nominal):
    return {"status": "known", "nominal": nominal, "basis": BASIS}


def av_signal_set():
    """The "Workshop AV signals" set: video, sync, stereo audio, two supplies and returns."""
    video = {"level": _level(0.7, "Vpp"), "impedance": _ohm(75)}
    return {
        "kind": "signal_set",
        "description": "Synthetic analog audio/video signals for workshop cables.",
        "signals": [
            {"key": "video_red", "name": "Red video", "type": "analog_video", **video},
            {"key": "video_green", "name": "Green video", "type": "analog_video", **video},
            {"key": "video_blue", "name": "Blue video", "type": "analog_video", **video},
            # Level unknown on purpose: it stays unknown, never zero.
            {"key": "composite_sync", "name": "Composite sync", "type": "sync"},
            {"key": "audio_left", "name": "Audio left", "type": "analog_audio"},
            {"key": "audio_right", "name": "Audio right", "type": "analog_audio"},
            {"key": "blanking", "name": "RGB blanking", "type": "control"},
            {"key": "power_5v", "name": "+5 V", "type": "power", "level": _level(5, "V")},
            {"key": "power_9v", "name": "+9 V", "type": "power", "level": _level(9, "V")},
            {
                "key": "video_ground",
                "name": "Video ground",
                "type": "ground_return",
                "return_for": ["video_red", "video_green", "video_blue", "composite_sync"],
            },
            {
                "key": "audio_ground",
                "name": "Audio ground",
                "type": "ground_return",
                "return_for": ["audio_left", "audio_right"],
            },
            {"key": "chassis", "name": "Chassis", "type": "chassis"},
        ],
    }


def _contacts(count):
    return [
        *({"contact_id": str(n), "number": str(n), "label": str(n)} for n in range(1, count + 1)),
        {"contact_id": "shell", "physical_role": "shell", "label": "Shell"},
    ]


def round_din_10_socket():
    return {
        "kind": "connector_body",
        "family": "10-pin round DIN",
        "mating_role": "receptacle",
        "contacts": _contacts(10),
    }


def rgb_21_socket():
    return {
        "kind": "connector_body",
        "family": "21-pin RGB",
        "mating_role": "receptacle",
        "contacts": _contacts(21),
    }


ROLE = {
    "analog_video": "signal",
    "sync": "signal",
    "analog_audio": "signal",
    "control": "signal",
    "power": "power",
    "ground_return": "return",
    "chassis": "chassis",
}
SIGNAL_TYPES = {s["key"]: s["type"] for s in av_signal_set()["signals"]}


def _pin(set_revision_id, contact_id, key, direction):
    kind = SIGNAL_TYPES[key]
    role = ROLE[kind]
    return {
        "contact_id": contact_id,
        "electrical": {
            "signal_ref": {"signal_set_revision_id": set_revision_id, "key": key},
            "role": role,
            "direction": "passive" if role in ("return", "chassis") else direction,
        },
    }


# Synthetic 10-pin source layout shared by both console variants except contact 1.
DIN_SHARED = {
    "2": "video_blue",
    "3": "video_ground",
    "4": "video_red",
    "5": "audio_right",
    "6": "video_green",
    "7": "audio_ground",
    "8": "power_5v",
    "9": "audio_left",
    "shell": "chassis",
}
DIN_PIN_1 = {"Console A AV": "composite_sync", "Console B AV": "power_9v"}


def console_pinout(set_revision_id, body_revision_id, variant):
    """Named 10-pin variant; "Console A AV" and "Console B AV" differ only on contact 1."""
    pins = {"1": DIN_PIN_1[variant], **DIN_SHARED}
    return {
        "kind": "pinout",
        "body_revision_id": body_revision_id,
        "variant_label": variant,
        "role": "source",
        "standard": "Synthetic console AV",
        "review": "reviewed",
        "review_basis": "Synthetic pin table written for this example",
        "assignments": [
            _pin(set_revision_id, contact, key, "output") for contact, key in pins.items()
        ],
    }


RGB_PINS = {
    "1": "audio_right",
    "3": "audio_left",
    "4": "audio_ground",
    "5": "video_ground",
    "7": "video_blue",
    "11": "video_green",
    "15": "video_red",
    "16": "blanking",
    "17": "video_ground",
    "20": "composite_sync",
    "shell": "chassis",
}


def rgb_pinout(set_revision_id, body_revision_id, role):
    """The 21-pin body as an RGB input (sink) or an RGB output (source)."""
    direction = {"sink": "input", "source": "output"}[role]
    return {
        "kind": "pinout",
        "body_revision_id": body_revision_id,
        "variant_label": {"sink": "RGB input", "source": "RGB output"}[role],
        "role": role,
        "standard": "Synthetic 21-pin RGB",
        "review": "reviewed",
        "review_basis": "Synthetic pin table written for this example",
        "assignments": [
            _pin(set_revision_id, contact, key, direction) for contact, key in RGB_PINS.items()
        ],
    }


def round_din_10_plug(socket_revision_id):
    """The cable-side plug; a reviewed same-ID mating declaration with the socket."""
    return {
        "kind": "connector_body",
        "family": "10-pin round DIN",
        "mating_role": "plug",
        "contacts": _contacts(10),
        "mates_with": [
            {
                "body_revision_id": socket_revision_id,
                "correspondence": "same_contact_id",
                "review": "reviewed",
                "basis": "Synthetic mating drawing written for this example",
            }
        ],
    }


def rgb_21_plug(socket_revision_id, review="reviewed"):
    value = {
        "kind": "connector_body",
        "family": "21-pin RGB",
        "mating_role": "plug",
        "contacts": _contacts(21),
        "mates_with": [
            {
                "body_revision_id": socket_revision_id,
                "correspondence": "same_contact_id",
                "review": review,
            }
        ],
    }
    if review == "reviewed":
        value["mates_with"][0]["basis"] = "Synthetic mating drawing written for this example"
    return value


def regional_console_pinout(set_revision_id, body_revision_id):
    """One 10-pin variant whose contact 1 depends on a named device region."""
    value = console_pinout(set_revision_id, body_revision_id, "Console A AV")
    value["variant_label"] = "Console AV (regional)"
    value["conditions"] = [
        {
            "key": "region",
            "name": "Device region",
            "choices": [{"key": "a", "name": "Region A"}, {"key": "b", "name": "Region B"}],
        }
    ]
    first = value["assignments"][0]
    first["electrical"] = {}
    first["alternatives"] = [
        {
            "condition_key": "region",
            "choice": choice,
            "signal_ref": {"signal_set_revision_id": set_revision_id, "key": key},
            "role": role,
            "basis": "Synthetic pin table written for this example",
        }
        for choice, key, role in (("a", "composite_sync", "signal"), ("b", "power_9v", "power"))
    ]
    return value


def _video_pin(contact, behavior, impedance):
    return {
        "contact_id": contact,
        "behavior": behavior,
        "level": _level(0.7, "Vpp"),
        "impedance": _ohm(impedance),
        "coupling": "dc" if behavior == "drives" else "ac",
        "termination": "source_terminated" if behavior == "drives" else "load_terminated",
        "basis": BASIS,
    }


def console_port(pinout_revision_id, device, sync_needs_resistor=True):
    """A synthetic console AV output; contact 1 differs by variant (see DIN_PIN_1)."""
    pins = [_video_pin(c, "drives", 75) for c in ("2", "4", "6")]
    pins.append({"contact_id": "8", "behavior": "drives", "level": _level(5, "V")})
    if device == "Console B AV out":
        pins.append(
            {
                "contact_id": "1",
                "behavior": "drives",
                "level": _level(9, "V"),
                "must_not_connect": True,
                "must_not_connect_reason": "Supply output; never wire to a signal input",
            }
        )
    else:
        pin = {"contact_id": "1", "behavior": "drives", "basis": BASIS}
        if sync_needs_resistor:
            pin["needs_in_cable"] = [
                {"conditioning": "series_resistor", "value": "470 ohm", "basis": BASIS}
            ]
        pins.append(pin)
    return {
        "kind": "port",
        "device_label": device,
        "pinout_revision_id": pinout_revision_id,
        "role": "source",
        "pins": pins,
        "review": "reviewed",
        "review_basis": "Synthetic device facts written for this example",
    }


def rgb_monitor_port(pinout_revision_id):
    """A synthetic RGB monitor input; audio levels stay unknown."""
    return {
        "kind": "port",
        "device_label": "RGB monitor 21-pin input",
        "pinout_revision_id": pinout_revision_id,
        "role": "sink",
        "pins": [_video_pin(c, "accepts", 75) for c in ("7", "11", "15")]
        + [{"contact_id": "20", "behavior": "accepts", "coupling": "ac"}],
    }


# Synthetic adapter board: cable-side solder pads joined to the 10-pin side contacts.
# (pad label, DIN contact, how the pad reaches it); see DIN_SHARED and DIN_PIN_1.
ADAPTER_PADS = [
    ("R", "4", "copper"),
    ("G", "6", "copper"),
    ("B", "2", "copper"),
    ("CS", "1", "resistor"),
    ("AL", "9", "copper"),
    ("AR", "5", "copper"),
    ("GND", "3", "copper"),
    ("AGND", "7", "copper"),
    # Deliberately without a declared path: its connection stays unknown.
    ("5V", None, None),
]


def av_adapter_board(plug_revision_id):
    """A bought black-box "AV adapter board" carrying the 10-pin plug.

    Cable-side pads R/G/B/CS/AL/AR/GND/AGND/5V; a series 470 ohm resistor on sync and
    straight copper for video, audio and grounds. Values are illustrative declarations.
    """
    din = [
        {
            "terminal_id": f"din-{n}",
            "label": str(n),
            "group": "Connector side",
            "kind": "connector_contact",
            "side": "both",
        }
        for n in range(1, 10)
    ]
    pads = [
        {
            "terminal_id": label.lower().replace("5v", "v5"),
            "label": label,
            "group": "Cable side",
            "kind": "solder_pad",
            "side": "top",
        }
        for label, _, _ in ADAPTER_PADS
    ]
    paths = []
    for label, contact, via in ADAPTER_PADS:
        if via is None:
            continue
        path = {
            "local_id": f"path-{label.lower()}",
            "from_terminal": label.lower(),
            "to_terminal": f"din-{contact}",
            "via": "copper" if via == "copper" else "component",
            "basis": "Synthetic board drawing written for this example",
        }
        if via == "resistor":
            path["component"] = {
                "kind": "resistor",
                "value": "470R",
                "reference": "R1",
                "resistance_ohm": "470",
            }
        paths.append(path)
    return {
        "kind": "board",
        "origin": "black_box",
        "terminals": din + pads,
        "carried_connectors": [
            {
                "local_id": "plug",
                "body_revision_id": plug_revision_id,
                "correspondence": [
                    {"terminal_id": f"din-{n}", "contact_id": str(n)} for n in range(1, 10)
                ],
                "review": "reviewed",
                "basis": "Synthetic board drawing written for this example",
            }
        ],
        "paths": paths,
        "review": "reviewed",
        "review_basis": "Synthetic board drawing written for this example",
    }


# Six miniature coax cores in a ring under one jacket. The core colors are display colors
# only; what each core carries is stated by a convention, never by its color.
COAX_CORES = (
    ("red", "#c0392b", "video_red", "Red"),
    ("green", "#2e8b57", "video_green", "Green"),
    ("blue", "#2f5fb0", "video_blue", "Blue"),
    ("yellow", "#d4b21a", "composite_sync", "Yellow"),
    ("white", "#e8e8e8", "audio_left", "White"),
    ("gray", "#8a8a8a", "audio_right", "Gray"),
)


def six_coax_stock():
    """Synthetic six-coax AV stock; every core is a center, dielectric and braid screen."""
    source = "Synthetic example construction"

    def element(identifier, label, kind, outer, inner, **extra):
        return {
            "id": identifier,
            "label": label,
            "kind": kind,
            "outer_diameter_mm": outer,
            "inner_diameter_mm": inner,
            "source": source,
            **extra,
        }

    cores = []
    for number, (color, hex_, _, _) in enumerate(COAX_CORES, start=1):
        cores.append(
            {
                "id": f"core-{number}",
                "label": f"Core {number} ({color})",
                "kind": "group",
                "role": "coax",
                "children": [
                    element("center", "Center", "conductor", 0.3, 0, color=hex_),
                    element("dielectric", "Dielectric", "dielectric", 1.0, 0.3),
                    element("screen", "Screen", "shield", 1.2, 1.0, construction="braid"),
                ],
            }
        )
    return {
        "construction": "bundle",
        "viewed_from": "a",
        "structure": {
            "id": "stock",
            "label": "Synthetic six-coax AV stock",
            "kind": "group",
            "role": "stock",
            "arrangement": "ring",
            "pitch_mm": 2.4,
            "children": [
                *cores,
                element("jacket", "Jacket", "jacket", 4.4, 3.6, color="#222222"),
            ],
        },
        # Every core is the same 75 ohm miniature coax (illustrative declaration).
        "facts": {
            "impedance": {
                "value": 75,
                "unit": "ohm",
                "source": "Synthetic example construction",
                "status": "documented",
            }
        },
    }


def av_coax_convention(signal_set_revision_id, stock_revision_id):
    """Each coax center carries its signal and its screen returns that same signal."""
    rules = []
    for number, (color, _, signal, _) in enumerate(COAX_CORES, start=1):
        base = f"stock.core-{number}"
        rules.append(
            {
                "element_path": f"{base}.center",
                "use": {"kind": "signal", "signal_key": signal},
                "basis": f"Shop habit for the {color} core",
            }
        )
        rules.append(
            {
                "element_path": f"{base}.screen",
                "use": {"kind": "return_of", "signal_key": signal},
                "basis": f"Shop habit for the {color} core",
            }
        )
    return {
        "kind": "conductor_convention",
        "scope": "stock",
        "stock_revision_id": stock_revision_id,
        "signal_set_revision_id": signal_set_revision_id,
        "description": "Synthetic habit for the six-coax AV stock",
        "rules": rules,
        "review": "reviewed",
        "review_basis": "Synthetic convention written for this example",
    }


def av_color_code(signal_set_revision_id):
    """A general color code: matches by exact display color, never by wire label."""
    return {
        "kind": "conductor_convention",
        "scope": "color_code",
        "signal_set_revision_id": signal_set_revision_id,
        "description": "Synthetic AV color habits",
        "rules": [
            {
                "color": "Red",
                "color_hex": "#c0392b",
                "element_kind": "conductor",
                "use": {"kind": "signal_type", "signal_type": "analog_video"},
                "preference": "allowed",
                "basis": "Synthetic habit",
            },
            {
                "color": "Gray",
                "color_hex": "#8a8a8a",
                "element_kind": "conductor",
                "use": {"kind": "spare"},
                "preference": "avoid",
                "basis": "Synthetic habit",
            },
        ],
    }


def din_adapter_end(board_revision_id, plug_revision_id, plug_pinout_revision_id, shell=None):
    """End assembly, board form: wire -> AV adapter board -> 10-pin plug -> shell.

    The board layer names its carried plug, so the board's reviewed pad/contact
    correspondence joins the board to the connector layer; nothing is joined by label.
    """
    return {
        "kind": "end_assembly",
        "description": "Synthetic console end: adapter board on a 10-pin plug in a shell",
        "stack": {
            "layers": [
                {
                    "kind": "board",
                    "layer_id": "board",
                    "board_revision_id": board_revision_id,
                    "carried_connector_id": "plug",
                },
                {
                    "kind": "connector",
                    "layer_id": "connector",
                    "body_revision_id": plug_revision_id,
                    "pinout_revision_id": plug_pinout_revision_id,
                },
                {"kind": "shell", "layer_id": "shell", "part_revision_id": shell},
            ],
            "joins": [],
        },
        "review": "reviewed",
        "review_basis": "Synthetic end drawing written for this example",
    }


# The inline form's hand-soldered part: a blanking resistor between a conductor and pin 16.
BLANKING_CONTACT = "16"


def rgb_inline_end(plug_revision_id, plug_pinout_revision_id, hood=None):
    """End assembly, inline form: wire -> blanking resistor -> 21-pin plug -> hood.

    The resistor's lead 2 is soldered to the blanking contact; lead 1 is where a conductor
    lands. The plug's shell contact is bonded to the hood by a declared bond.
    """
    return {
        "kind": "end_assembly",
        "description": "Synthetic monitor end: 21-pin plug with an inline blanking resistor",
        "stack": {
            "layers": [
                {
                    "kind": "inline",
                    "layer_id": "inline",
                    "parts": [
                        {
                            "local_id": "r1",
                            "label": "Blanking resistor",
                            "component": {
                                "kind": "resistor",
                                "value": "220R",
                                "reference": "R1",
                                "resistance_ohm": "220",
                            },
                        }
                    ],
                },
                {
                    "kind": "connector",
                    "layer_id": "connector",
                    "body_revision_id": plug_revision_id,
                    "pinout_revision_id": plug_pinout_revision_id,
                },
                {"kind": "shell", "layer_id": "hood", "part_revision_id": hood},
            ],
            "joins": [
                {
                    "local_id": "r1-to-blanking",
                    "a": {"layer_id": "inline", "terminal_id": "r1.2"},
                    "b": {"layer_id": "connector", "terminal_id": BLANKING_CONTACT},
                    "kind": "solder",
                    "basis": "Synthetic end drawing written for this example",
                },
                {
                    "local_id": "shell-bond",
                    "a": {"layer_id": "connector", "terminal_id": "shell"},
                    "b": {"layer_id": "hood", "terminal_id": "body"},
                    "kind": "bond",
                    "basis": "Synthetic end drawing written for this example",
                },
            ],
        },
        "review": "reviewed",
        "review_basis": "Synthetic end drawing written for this example",
    }


# (core number, adapter board pad at end A, 21-pin contact at end B) for each coax center.
DEMO_CENTERS = [
    (1, "r", "15"),
    (2, "g", "11"),
    (3, "b", "7"),
    (4, "cs", "20"),
    (5, "al", "3"),
    (6, "ar", "1"),
]
# Each screen returns its own signal: video screens to video ground, audio to audio ground.
DEMO_SCREENS = [
    (1, "gnd", "5"),
    (2, "gnd", "5"),
    (3, "gnd", "17"),
    (4, "gnd", "17"),
    (5, "agnd", "4"),
    (6, "agnd", "4"),
]


def _land(endpoint_id, element_path, layer_id, terminal_id):
    return {
        "endpoint_id": endpoint_id,
        "element_path": element_path,
        "layer_id": layer_id,
        "terminal_id": terminal_id,
    }


def av_demo_cable(stock_revision_id, end_a_revision_id, end_b_revision_id):
    """Six-coax console-to-monitor cable: board end at stock end A, inline end at B.

    The blanking resistor's cable-side lead stays unterminated: this stock has no
    conductor for it, and the cable says so rather than inventing one.
    """
    basis = "Synthetic wiring table written for this example"
    assignments = []
    for core, pad, contact in DEMO_CENTERS:
        path = f"stock.core-{core}.center"
        assignments.append(_land("a", path, "board", pad))
        assignments.append(_land("b", path, "connector", contact))
    for core, pad, contact in DEMO_SCREENS:
        path = f"stock.core-{core}.screen"
        assignments.append(_land("a", path, "board", pad))
        assignments.append(_land("b", path, "connector", contact))
    return {
        "schema_version": "0.2",
        "stock_revision_id": stock_revision_id,
        "endpoints": [
            {
                "local_id": "a",
                "label": "Console end",
                "stock_end": "a",
                "end_assembly_revision_id": end_a_revision_id,
            },
            {
                "local_id": "b",
                "label": "Monitor end",
                "stock_end": "b",
                "end_assembly_revision_id": end_b_revision_id,
            },
        ],
        "assignments": [{**a, "basis": basis} for a in assignments],
        "review": "reviewed",
        "review_basis": basis,
    }


def console_to_monitor_intent(from_revision_id, to_revision_id, proposed_rows):
    """The demo intent: proposed rows with each question answered by every offered contact.

    For the Console A port and the RGB monitor input the only question is video ground,
    declared on two monitor contacts; a synthetic reviewer keeps both.
    """
    rows = []
    for row in proposed_rows:
        row = dict(row)
        if row["question"]:
            row["to_contact_ids"] = [o["contact_id"] for o in row["question"]["options"]]
            row["question"] = None
            row["pairing"] = "answered"
            row["basis"] = "Synthetic reviewer answer written for this example"
        if row["signal_ref"] and row["signal_ref"]["key"] == "chassis":
            # The stock has no overall braid: shell-to-shell chassis is not carried.
            row["requirement"] = "optional"
            row["basis"] = "Synthetic: this stock carries no overall braid for chassis"
        rows.append(row)
    return {
        "kind": "cable_intent",
        "from_revision_id": from_revision_id,
        "to_revision_id": to_revision_id,
        "description": "Synthetic console RGB output to a monitor's RGB input",
        "rows": rows,
        "isolation": "no_unlisted_connections",
        "shield": {"policy": "bond_from", "basis": "Synthetic shop habit for this example"},
        "review": "reviewed",
        "review_basis": "Synthetic review written for this example",
    }


def _retarget(cable, endpoint_id, element_path, terminal_id, layer_id=None):
    for assignment in cable["assignments"]:
        if (assignment["endpoint_id"], assignment["element_path"]) == (endpoint_id, element_path):
            assignment["terminal_id"] = terminal_id
            if layer_id:
                assignment["layer_id"] = layer_id
            assignment["basis"] = "Synthetic deliberate fault for checking"
    return cable


def av_swapped_cable(stock_revision_id, end_a_revision_id, end_b_revision_id):
    """Red and blue centers swapped on the adapter board's pads at the console end."""
    cable = av_demo_cable(stock_revision_id, end_a_revision_id, end_b_revision_id)
    _retarget(cable, "a", "stock.core-1.center", "b")
    return _retarget(cable, "a", "stock.core-3.center", "r")


def av_missing_resistor_cable(stock_revision_id, end_a_revision_id, end_b_revision_id):
    """Sync center soldered to the board's connector-side pad, bypassing the 470 ohm part."""
    cable = av_demo_cable(stock_revision_id, end_a_revision_id, end_b_revision_id)
    return _retarget(cable, "a", "stock.core-4.center", "din-1")


def av_power_to_sync_cable(stock_revision_id, end_a_revision_id, end_b_revision_id):
    """Sync center landed on the +5 V contact pad: supply into the monitor's sync input."""
    cable = av_demo_cable(stock_revision_id, end_a_revision_id, end_b_revision_id)
    return _retarget(cable, "a", "stock.core-4.center", "din-8")
