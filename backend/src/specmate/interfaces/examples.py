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
