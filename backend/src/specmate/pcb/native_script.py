"""Trusted pack program, executed ONLY in the approved native container.

The app imports the string, never pcbnew or CAD. A fixed argv carries this exact
program to the runner; uploaded scripts are not used as the adapter implementation.
"""

import ast
from pathlib import Path
from textwrap import indent


def _embedded(path: Path) -> str:
    """Source of a pure module without docstrings or comments, to keep the argument small."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if (
            isinstance(body, list)
            and body
            and isinstance(body[0], ast.Expr)
            and isinstance(getattr(body[0], "value", None), ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body.pop(0)
            if not body:
                body.append(ast.Pass())
    return ast.unparse(tree) + "\n"


# The exact-geometry module is embedded: the container has no application code.
GEOMETRY = _embedded(Path(__file__).with_name("outline_geometry.py"))

PROGRAM = (
    GEOMETRY
    + r"""
import hashlib,json,os,re,sys
from pathlib import Path
os.environ.update(XDG_CONFIG_HOME="/tmp/kicad-config", XDG_CACHE_HOME="/tmp/kicad-cache")
import pcbnew
if pcbnew.GetBuildVersion() != "10.0.6":
    raise ValueError("Required pcbnew version is 10.0.6")
source,output=map(Path,sys.argv[1:])
original=hashlib.sha256(source.read_bytes()).hexdigest()
head=source.read_bytes()[:4096].decode("utf-8")
version=re.search(r"\(version\s+(\d+)\)",head)
if not version or int(version[1]) != 20260206:
    raise ValueError("Only KiCad board format 20260206 is supported by this adapter")
board=pcbnew.LoadBoard(str(source))
if board is None:
    raise ValueError("KiCad returned no board")
def point(p):
    return [round(pcbnew.ToMM(p.x),6),round(pcbnew.ToMM(p.y),6)]
components=[];pads=[];holes=[];nets={};passages=[];unsupported=[]
shapes={getattr(pcbnew,"PAD_SHAPE_"+n):n.lower() for n in
    ("CIRCLE","RECTANGLE","OVAL","TRAPEZOID","ROUNDRECT","CHAMFERED_RECT","CUSTOM")}
for fp in board.GetFootprints():
    reference=fp.GetReference();value=fp.GetValue();uid=fp.m_Uuid.AsString()
    components.append(dict(id=uid,reference=reference,value=value,
        footprint=str(fp.GetFPID().GetLibNickname())+":"+str(fp.GetFPID().GetLibItemName()),
        position=point(fp.GetPosition()),
        rotation_deg=fp.GetOrientationDegrees(),side="back" if fp.IsFlipped() else "front",
        dnp=bool(fp.IsDNP()),exclude_from_bom=bool(fp.IsExcludedFromBOM())))
    terminals=[]
    for pad in fp.Pads():
        ptype={pcbnew.PAD_ATTRIB_SMD:"smd",pcbnew.PAD_ATTRIB_PTH:"pth",
            pcbnew.PAD_ATTRIB_NPTH:"npth",pcbnew.PAD_ATTRIB_CONN:"connector"}.get(pad.GetAttribute(),"unknown")
        net=pad.GetNetname();number=pad.GetNumber();terminal=f"{reference}.{number}"
        drill=point(pad.GetDrillSize())
        item=dict(id=pad.m_Uuid.AsString(),component_id=uid,number=number,terminal=terminal,
            position=point(pad.GetPosition()),size=point(pad.GetSize()),drill=drill,
            rotation_deg=pad.GetOrientationDegrees(),type=ptype,
            shape=shapes.get(pad.GetShape(),"unknown"),
            net=net,layers=[board.GetLayerName(i) for i in pad.GetLayerSet().Seq()])
        pads.append(item)
        if ptype == "npth":
            holes.append(dict(pad_id=item["id"],position=item["position"],drill=drill,
                mounting_status="candidate-not-reviewed"))
        else:
            terminals.append(terminal)
            if net:
                nets.setdefault(net,[]).append(terminal)
    # Limited candidate convention retained from the synthetic fixture probe.
    # This does not merge copper nets or declare a reviewed component class.
    if re.fullmatch(r"R[1-9][0-9]*",reference):
        m=re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([RkM]?)",value)
        if m and len(terminals)==2:
            a,b=sorted(terminals)
            passages.append({"kind":"resistor","from":a,"to":b,
                "resistance_ohm":float(m[1])*{"":1,"R":1,"k":1000,"M":1000000}[m[2]]})
        else:
            unsupported.append("unresolved resistor candidate: "+uid)
outline=[];cutouts=[]
edges=[d for d in board.GetDrawings() if d.GetLayer()==pcbnew.Edge_Cuts]
edges += [d for fp in board.GetFootprints() for d in fp.GraphicalItems()
    if d.GetLayer()==pcbnew.Edge_Cuts]
polygons=pcbnew.SHAPE_POLY_SET()
exact=None
curved=any(isinstance(d,pcbnew.PCB_SHAPE) and d.GetShape() in
    (pcbnew.SHAPE_T_ARC,pcbnew.SHAPE_T_CIRCLE,pcbnew.SHAPE_T_BEZIER) for d in edges)
if curved:
    def mm(p):
        return (round(pcbnew.ToMM(p.x),6),round(pcbnew.ToMM(p.y),6))
    primitives=[]
    for d in edges:
        kind=d.GetShape() if isinstance(d,pcbnew.PCB_SHAPE) else None
        if kind==pcbnew.SHAPE_T_SEGMENT:
            primitives.append(line(mm(d.GetStart()),mm(d.GetEnd())))
        elif kind==pcbnew.SHAPE_T_ARC:
            primitives.append(arc(mm(d.GetStart()),mm(d.GetArcMid()),mm(d.GetEnd())))
        elif kind==pcbnew.SHAPE_T_BEZIER:
            primitives.append(bezier(mm(d.GetStart()),mm(d.GetBezierC1()),
                mm(d.GetBezierC2()),mm(d.GetEnd())))
        elif kind==pcbnew.SHAPE_T_CIRCLE:
            primitives.append(circle(mm(d.GetCenter()),round(pcbnew.ToMM(d.GetRadius()),6)))
        else:
            primitives=None
            break
    if primitives:
        kept=[e for e in primitives if not is_degenerate(e)]
        if len(kept)!=len(primitives):
            unsupported.append(f"{len(primitives)-len(kept)} zero-length Edge.Cuts item(s) ignored")
        exact=build(kept)
        if not exact:
            open_count=chain(kept)[1]
            if open_count:
                unsupported.append(f"{open_count} Edge.Cuts item(s) do not close into loops "
                    f"within the {BRIDGE_MM} mm chaining tolerance; larger gaps are never bridged")
line_edges=edges and all(isinstance(d,pcbnew.PCB_SHAPE)
    and d.GetShape()==pcbnew.SHAPE_T_SEGMENT for d in edges)
if exact:
    outline=exact["outline"];cutouts=exact["cutouts"]
elif not curved and line_edges and board.GetBoardPolygonOutlines(polygons,False):
    for i in range(polygons.OutlineCount()):
        p=polygons.Outline(i)
        outline.append([point(p.CPoint(k)) for k in range(p.PointCount())])
        for j in range(polygons.HoleCount(i)):
            p=polygons.Hole(i,j)
            cutouts.append([point(p.CPoint(k)) for k in range(p.PointCount())])
else:
    unsupported.append("outline absent, open, or contains unsupported geometry "
        "(only lines, arcs, circles and Bezier curves are supported)")
if len({c["reference"] for c in components})!=len(components):
    unsupported.append("duplicate references: terminal labels are ambiguous; use pad UUIDs")
unsupported += ["schematic parity and electrical intent not extracted",
    "models, interfaces, reviewed part matching and population variants not extracted",
    "copper geometry, zones, vias, pad polygons and manufacturing rules not extracted",
    "component passages are unreviewed reference/value candidates; "
    "native sources remain authoritative"]
report=dict(format_version=1,adapter="kicad-intake-v1",tool_version="10.0.6",
    native_format_version=20260206,source_sha256=original,units="mm",
    coordinate_frame="KiCad absolute: x right, y down; angles native degrees",
    components=sorted(components,key=lambda c:c["id"]),pads=sorted(pads,key=lambda p:p["id"]),
    copper_nets={n:sorted(t) for n,t in sorted(nets.items())},
    outline=outline,cutouts=cutouts,mounting_holes=holes,component_passages=passages,
    coverage={"components":"identity-reference-value-footprint-and-flags",
        "pads":"identity-and-basic-geometry",
        "nets":"pad-membership-not-connectivity-proof",
        "outline":("closed-polygons-bridged" if exact and exact["bridged_gaps"] else
            "closed-polygons-with-arcs" if exact else "closed-line-polygons")
            if outline else "unsupported",
        "holes":"nonplated-pad-drills-not-reviewed-mounts","placements":"native-absolute"},
    unsupported=unsupported,physical_qualification=False)
if exact:
    report.update(outline_exact=exact["outline_exact"],cutouts_exact=exact["cutouts_exact"],
        outline_tolerance_mm=exact["tolerance_mm"],
        outline_bridged_gaps=exact["bridged_gaps"],
        chaining_tolerance_mm=exact["chaining_tolerance_mm"])
if hashlib.sha256(source.read_bytes()).hexdigest()!=original:
    raise ValueError("Native source changed during extraction")
output.write_text(json.dumps(report,sort_keys=True,allow_nan=False)+"\n")
""".strip()
)

SCRIPT = (
    "try:\n"
    + indent(PROGRAM, "    ")
    + """
except Exception as exc:
    import json,sys
    from pathlib import Path
    Path(sys.argv[2]).write_text(json.dumps({"status":"failed", "error":str(exc)})+"\\n")
    raise SystemExit(1)
"""
)
