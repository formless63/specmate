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


def _video_pin(contact, behaviour, impedance):
    return {
        "contact_id": contact,
        "behaviour": behaviour,
        "level": _level(0.7, "Vpp"),
        "impedance": _ohm(impedance),
        "coupling": "dc" if behaviour == "drives" else "ac",
        "termination": "source_terminated" if behaviour == "drives" else "load_terminated",
        "basis": BASIS,
    }


def console_port(pinout_revision_id, device, sync_needs_resistor=True):
    """A synthetic console AV output; contact 1 differs by variant (see DIN_PIN_1)."""
    pins = [_video_pin(c, "drives", 75) for c in ("2", "4", "6")]
    pins.append({"contact_id": "8", "behaviour": "drives", "level": _level(5, "V")})
    if device == "Console B AV out":
        pins.append(
            {
                "contact_id": "1",
                "behaviour": "drives",
                "level": _level(9, "V"),
                "must_not_connect": True,
                "must_not_connect_reason": "Supply output; never wire to a signal input",
            }
        )
    else:
        pin = {"contact_id": "1", "behaviour": "drives", "basis": BASIS}
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
        + [{"contact_id": "20", "behaviour": "accepts", "coupling": "ac"}],
    }


# Six miniature coax cores in a ring under one jacket. The core colours are display colours
# only; what each core carries is stated by a convention, never by its colour.
COAX_CORES = (
    ("red", "#c0392b", "video_red", "Red"),
    ("green", "#2e8b57", "video_green", "Green"),
    ("blue", "#2f5fb0", "video_blue", "Blue"),
    ("yellow", "#d4b21a", "composite_sync", "Yellow"),
    ("white", "#e8e8e8", "audio_left", "White"),
    ("grey", "#8a8a8a", "audio_right", "Grey"),
)


def six_coax_stock():
    """Synthetic six-coax AV stock; every core is a centre, dielectric and braid screen."""
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
    for number, (colour, hex_, _, _) in enumerate(COAX_CORES, start=1):
        cores.append(
            {
                "id": f"core-{number}",
                "label": f"Core {number} ({colour})",
                "kind": "group",
                "role": "coax",
                "children": [
                    element("center", "Centre", "conductor", 0.3, 0, color=hex_),
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
        "facts": {},
    }


def av_coax_convention(signal_set_revision_id, stock_revision_id):
    """Each coax centre carries its signal and its screen returns that same signal."""
    rules = []
    for number, (colour, _, signal, _) in enumerate(COAX_CORES, start=1):
        base = f"stock.core-{number}"
        rules.append(
            {
                "element_path": f"{base}.center",
                "use": {"kind": "signal", "signal_key": signal},
                "basis": f"Shop habit for the {colour} core",
            }
        )
        rules.append(
            {
                "element_path": f"{base}.screen",
                "use": {"kind": "return_of", "signal_key": signal},
                "basis": f"Shop habit for the {colour} core",
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


def av_colour_code(signal_set_revision_id):
    """A general colour code: matches by exact display colour, never by wire label."""
    return {
        "kind": "conductor_convention",
        "scope": "colour_code",
        "signal_set_revision_id": signal_set_revision_id,
        "description": "Synthetic AV colour habits",
        "rules": [
            {
                "colour": "Red",
                "colour_hex": "#c0392b",
                "element_kind": "conductor",
                "use": {"kind": "signal_type", "signal_type": "analog_video"},
                "preference": "allowed",
                "basis": "Synthetic habit",
            },
            {
                "colour": "Grey",
                "colour_hex": "#8a8a8a",
                "element_kind": "conductor",
                "use": {"kind": "spare"},
                "preference": "avoid",
                "basis": "Synthetic habit",
            },
        ],
    }
