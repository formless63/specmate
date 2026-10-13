#!/usr/bin/env python3
"""Author the original synthetic PCB using the pinned image's pcbnew bindings.

The construction dimensions are deliberate inputs, independent of the acceptance
expectation JSON. Run this inside the pinned native tool image, never the backend.
"""

import argparse
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pcbnew


def point(x_mm, y_mm):
    return pcbnew.VECTOR2I(pcbnew.FromMM(x_mm), pcbnew.FromMM(y_mm))


def identify(item, name):
    item.SetUuid(
        pcbnew.KIID(str(uuid5(NAMESPACE_URL, f"specmate:synthetic-pcb-v1:{name}")))
    )
    return item


def layers(*layer_ids):
    result = pcbnew.LSET()
    for layer_id in layer_ids:
        result.AddLayer(layer_id)
    return result


def line(parent, name, start, end, layer, width):
    shape = identify(pcbnew.PCB_SHAPE(parent), name)
    shape.SetShape(pcbnew.SHAPE_T_SEGMENT)
    shape.SetStart(point(*start))
    shape.SetEnd(point(*end))
    shape.SetLayer(layer)
    shape.SetWidth(pcbnew.FromMM(width))
    parent.Add(shape)


def footprint(board, reference, value, position, attributes, courtyard):
    item = identify(pcbnew.FOOTPRINT(board), reference)
    item.SetReference(reference)
    item.SetValue(value)
    item.SetPosition(point(*position))
    item.SetAttributes(attributes)
    # No stock footprint, model or external library is used by this fixture.
    item.SetFPID(pcbnew.LIB_ID("", f"Synthetic_{reference}"))
    for field in item.GetFields():
        identify(field, f"{reference}:field:{field.GetName()}")
        field.SetVisible(False)
        field.SetLayer(pcbnew.F_Fab)
        field.SetPosition(point(*position))
    board.Add(item)
    x0, y0, x1, y1 = courtyard
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for i, start in enumerate(corners):
        line(
            item,
            f"{reference}:courtyard:{i}",
            start,
            corners[(i + 1) % 4],
            pcbnew.F_CrtYd,
            0.05,
        )
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if pcbnew.GetBuildVersion() != "10.0.6":
        parser.error("fixture generation requires pcbnew 10.0.6 from manifest.json")

    board = pcbnew.BOARD()
    board.GetDesignSettings().SetBoardThickness(pcbnew.FromMM(1.6))
    board.SetCopperLayerCount(2)
    corners = [(0, 0), (40, 0), (40, 25), (0, 25)]
    for i, start in enumerate(corners):
        line(board, f"outline:{i}", start, corners[(i + 1) % 4], pcbnew.Edge_Cuts, 0.05)

    nets = {}
    for name in ("N1", "N2"):
        nets[name] = pcbnew.NETINFO_ITEM(board, name)
        board.Add(nets[name])

    for reference, value, x in (("J1", "CONN_2", 10), ("R1", "1k", 25)):
        item = footprint(
            board,
            reference,
            value,
            (x, 10),
            pcbnew.FP_SMD,
            (x - 1.5, 8.5, x + 1.5, 16.5),
        )
        for number, y, net in (("1", 10, "N1"), ("2", 15, "N2")):
            pad = identify(pcbnew.PAD(item), f"{reference}:pad:{number}")
            pad.SetNumber(number)
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetShape(pcbnew.PAD_SHAPE_RECTANGLE)
            pad.SetSize(point(2, 2))
            pad.SetPosition(point(x, y))
            pad.SetLayerSet(layers(pcbnew.F_Cu, pcbnew.F_Paste, pcbnew.F_Mask))
            pad.SetNet(nets[net])
            item.Add(pad)

    for i, (x, y) in enumerate(((3, 3), (37, 3), (3, 22), (37, 22)), start=1):
        reference = f"H{i}"
        item = footprint(
            board,
            reference,
            "MountingHole_2mm",
            (x, y),
            pcbnew.FP_BOARD_ONLY
            | pcbnew.FP_EXCLUDE_FROM_BOM
            | pcbnew.FP_EXCLUDE_FROM_POS_FILES,
            (x - 1.25, y - 1.25, x + 1.25, y + 1.25),
        )
        pad = identify(pcbnew.PAD(item), f"{reference}:hole")
        pad.SetNumber("")
        pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
        pad.SetPosition(point(x, y))
        pad.SetSize(point(2, 2))
        pad.SetDrillSize(point(2, 2))
        pad.SetLayerSet(layers(pcbnew.F_Cu, pcbnew.B_Cu, pcbnew.F_Mask, pcbnew.B_Mask))
        item.Add(pad)

    for name, y in (("N1", 10), ("N2", 15)):
        track = identify(pcbnew.PCB_TRACK(board), f"track:{name}")
        track.SetStart(point(10, y))
        track.SetEnd(point(25, y))
        track.SetLayer(pcbnew.F_Cu)
        track.SetWidth(pcbnew.FromMM(0.5))
        track.SetNet(nets[name])
        board.Add(track)

    if not pcbnew.SaveBoard(str(args.output), board):
        raise RuntimeError("KiCad could not save the synthetic board")


if __name__ == "__main__":
    main()
