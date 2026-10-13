"""Trusted extraction program; only the approved isolated runner executes it."""

from pathlib import Path
from textwrap import indent

PARSER = Path(__file__).with_name("xml_extract.py").read_text()
PROGRAM = r"""
import os,re,subprocess,sys
from pathlib import Path
os.environ.update(XDG_CONFIG_HOME="/tmp/config", XDG_CACHE_HOME="/tmp/cache",
                  XDG_DATA_HOME="/tmp/data")
mode,source_path,output_path,xml_path=sys.argv[1:]
source,output,xml_output=map(Path,(source_path,output_path,xml_path))
raw=source.read_bytes()
if not raw or len(raw)>MAX_XML_BYTES:
    raise ValueError("Source byte bound exceeded")
source_sha256=hashlib.sha256(raw).hexdigest()
version=subprocess.run(["kicad-cli","--version"],capture_output=True,text=True,
                       timeout=10,check=True).stdout.strip()
if version!="10.0.6":
    raise ValueError("Required KiCad CLI version is 10.0.6")
if mode=="schematic":
    text=raw.decode("utf-8",errors="strict")
    version_match=re.search(r"\(version\s+(\d+)\)",text[:4096])
    if (not text.lstrip().startswith("(kicad_sch") or not version_match
            or version_match[1]!="20250114"):
        raise ValueError("Only the qualified schematic format 20250114 is supported")
    if re.search(r"\(sheet\s",text):
        raise ValueError("Hierarchical sheet extraction is unsupported")
    result=subprocess.run(["kicad-cli","sch","export","netlist","--format","kicadxml",
                           "--output",str(xml_output),str(source)],
                          capture_output=True,text=True,timeout=90)
    if result.returncode or not xml_output.is_file():
        raise ValueError("KiCad schematic export failed with exit "+str(result.returncode))
    method="native_schematic_export"
    native_format="20250114"
elif mode=="netlist":
    xml_output.write_bytes(raw)
    method="preserved_netlist_parser"
    native_format="E"
else:
    raise ValueError("Unsupported source role")
normalized=normalize_xml(xml_output.read_bytes(),source_sha256)
report=dict(format_version=1,adapter=ADAPTER,tool_version=version,
            source_role=mode,method=method,source_sha256=source_sha256,
            native_format_version=native_format,physical_qualification=False,**normalized)
if hashlib.sha256(source.read_bytes()).hexdigest()!=source_sha256:
    raise ValueError("Preserved source changed during extraction")
encoded=json.dumps(report,sort_keys=True,separators=(",",":"),allow_nan=False)+"\n"
if len(encoded.encode())>MAX_XML_BYTES:
    raise ValueError("Report byte bound exceeded")
output.write_text(encoded)
""".strip()

SCRIPT = (
    PARSER
    + "\ntry:\n"
    + indent(PROGRAM, "    ")
    + """
except Exception as exc:
    import json,sys
    from pathlib import Path
    Path(sys.argv[3]).write_text(json.dumps({"status":"failed","error":str(exc)})+"\\n")
    raise SystemExit(1)
"""
)
