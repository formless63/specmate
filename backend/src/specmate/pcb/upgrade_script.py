"""Trusted format-upgrade program, executed ONLY in the approved native container.

The app imports the string, never KiCad. It copies each selected input into private
scratch space, runs the pinned ``kicad-cli pcb upgrade`` / ``sch upgrade`` on the copy,
verifies the written format and that the read-only originals are unchanged, and writes
only the upgraded bytes plus a bounded JSON report. Originals are never modified.

argv: ``/outputs <board> [<schematic> ...]`` (absolute paths under /inputs).
"""

from textwrap import indent

from specmate.pcb.formats import CLASSIFIER

PROGRAM = (
    r"""
import hashlib,json,os,re,subprocess,sys
from pathlib import Path
os.environ.update(HOME="/tmp",XDG_CONFIG_HOME="/tmp/kicad-config",XDG_CACHE_HOME="/tmp/kicad-cache")
"""
    + CLASSIFIER
    + r"""
out=Path(sys.argv[1]);inputs=[Path(a) for a in sys.argv[2:]]
tool=subprocess.run(["kicad-cli","--version"],capture_output=True,text=True,timeout=60)
if tool.stdout.strip()!="10.0.6":
    raise ValueError("Required KiCad CLI version is 10.0.6")
def version_of(kind,data):
    tag="pcb" if kind=="board" else "sch"
    m=re.match(r"\s*\(kicad_"+tag+r"\s+\(version\s+(\d+)\)",data[:4096].decode("utf-8","replace"))
    return int(m[1]) if m else None
files=[];work=Path("/tmp/specmate-upgrade")
for index,source in enumerate(inputs):
    kind="board" if index==0 else "schematic"
    native,old=FORMATS[kind]
    rel=source.relative_to("/inputs").as_posix()
    data=source.read_bytes();original=hashlib.sha256(data).hexdigest()
    before=version_of(kind,data)
    target=work/str(index)/source.name
    target.parent.mkdir(parents=True)
    target.write_bytes(data)
    argv=[]
    if before in old:
        argv=["kicad-cli","pcb" if kind=="board" else "sch","upgrade",str(target)]
        run=subprocess.run(argv,capture_output=True,text=True,timeout=270,cwd=target.parent)
        if run.returncode!=0:
            detail=(run.stderr or run.stdout).strip()[-500:]
            code=run.returncode
            raise ValueError(f"{rel}: kicad-cli {kind} upgrade failed (exit {code}): {detail}")
    elif kind=="board" or before!=native:
        raise ValueError(rel+": "+format_message(kind,before))
    result=target.read_bytes();after=version_of(kind,result)
    if after!=native:
        raise ValueError(f"{rel}: KiCad did not write {kind} format {native}")
    if hashlib.sha256(source.read_bytes()).hexdigest()!=original:
        raise ValueError(rel+": native source changed during upgrade")
    dest=out/"upgraded"/rel
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_bytes(result)
    files.append(dict(path=rel,kind=kind,output_path="upgraded/"+rel,source_sha256=original,
        output_sha256=hashlib.sha256(result).hexdigest(),from_format_version=before,
        from_kicad_major=old.get(before,10),to_format_version=after,argv=argv))
report=dict(format_version=1,adapter="kicad-format-upgrade-v1",tool_version="10.0.6",files=files,
    unsupported=["project, library, rule and other companion files are preserved unchanged",
        "upgrade is a native format conversion; it is not a design review or qualification"],
    physical_qualification=False)
(out/"kicad-upgrade.json").write_text(json.dumps(report,sort_keys=True)+"\n")
"""
).strip()

SCRIPT = (
    "try:\n"
    + indent(PROGRAM, "    ")
    + """
except Exception as exc:
    import json,sys
    from pathlib import Path
    Path(sys.argv[1],"kicad-upgrade.json").write_text(
        json.dumps({"status":"failed","error":str(exc)[:2000]})+"\\n")
    raise SystemExit(1)
"""
)
