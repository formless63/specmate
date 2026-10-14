"""Display projection only: stable physical identity never follows screen order."""

from math import cos, radians, sin


def project_contacts(body, target):
    source = body.drawing_orientation
    reason = None
    if source.viewing_side == "unknown" or target.viewing_side == "unknown":
        reason = "Source or selected viewing side is unknown."
    elif source.rotation_degrees is None or target.rotation_degrees is None:
        reason = "Both orientations need explicit rotations and a shared datum."
    elif source.datum != target.datum:
        reason = "Distinct orientation datums have no declared transform."
    mirrored = source.viewing_side != target.viewing_side if reason is None else None
    rows = []
    for contact in body.contacts:
        position = contact.position_mm
        displayed = None
        if reason is None and position is not None:
            # Screen x points right, y down; positive rotation is screen-CCW.
            # Undo source rotation, mirror across vertical datum, apply target rotation.
            a = radians(source.rotation_degrees)
            x, y = position
            x, y = x * cos(a) - y * sin(a), x * sin(a) + y * cos(a)
            if mirrored:
                x = -x
            a = radians(target.rotation_degrees)
            displayed = [x * cos(a) + y * sin(a), -x * sin(a) + y * cos(a)]
        rows.append(
            {
                "contact_id": contact.contact_id,
                "number": contact.number,
                "label": contact.label,
                "physical_role": contact.physical_role,
                "source_position_mm": position,
                "display_position_mm": displayed,
                "reason": reason
                or ("Contact coordinates are unknown." if position is None else None),
            }
        )
    return {
        "source_orientation": source.model_dump(mode="json"),
        "selected_orientation": target.model_dump(mode="json"),
        "mirrored": mirrored,
        "convention": "screen_x_right_y_down_origin_at_datum_positive_rotation_counterclockwise",
        "contacts": rows,
        "limitations": [
            "Display coordinates do not change identity, numbering, "
            "polarity or mating correspondence."
        ],
    }
