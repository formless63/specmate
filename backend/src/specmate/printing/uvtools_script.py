"""Trusted UVtools adapter text: read-only inspection of one sliced resin file.

The program checks the exact file bytes and the pinned UVtools release, runs
``UVtoolsCmd print-properties`` on the file and reports the facts the file states (layer
count, exposure, resolution, machine name, stored print time and material) separately
from the values UVtools computes from the layer images (volume, computed print time,
display on-time). A missing value stays unknown. Nothing is modified, converted or sent
to a printer; ChiTuBox ``.chitubox`` project files are never parsed.
"""

import inspect
import re

ADAPTER = "print-resin-inspect-uvtools-v1"
# Primary: ChiTuBox CTB (plain v2-v5 and the encrypted v4/v5 variants ChiTuBox writes).
# Secondary: Elegoo GOO.
SUFFIXES = (".ctb", ".goo")
FORMATS = {"ChituboxFile": "ctb", "CTBEncryptedFile": "ctb_encrypted", "GooFile": "goo"}


def properties_facts(text: str) -> dict:
    """Facts from ``UVtoolsCmd print-properties`` output; unstated values stay unknown.

    Runs inside the tool image and in application tests alike.
    """
    values = {}
    for line in text.splitlines():
        match = re.match(r"^([A-Za-z][A-Za-z0-9]*): (.*)$", line)
        if match and match.group(1) not in values:
            values[match.group(1)] = match.group(2).strip()
    classes = re.findall(r"UVtools\.Core\.FileFormats\.([A-Za-z0-9]+)\+", text)

    def number(key):
        try:
            value = float(values[key])
        except (KeyError, ValueError):
            return None
        return value if value == value and value not in (float("inf"), float("-inf")) else None

    def stated(key, positive=True):
        value = number(key)
        if value is None or (positive and value <= 0) or value < 0:
            return {"value": None, "status": "unknown"}
        return {"value": value, "status": "file_stated"}

    def computed(key):
        value = number(key)
        if value is None or value <= 0:
            return {"value": None, "status": "unknown"}
        return {"value": value, "status": "tool_computed"}

    def text_value(key):
        value = values.get(key)
        return (
            {"value": value, "status": "file_stated"}
            if value
            else {
                "value": None,
                "status": "unknown",
            }
        )

    format_class = classes[0] if classes else None
    version = number("Version")
    return {
        "format_class": format_class,
        "format": FORMATS.get(format_class),
        "format_version": int(version) if version is not None else None,
        "facts": {
            "machine_name": text_value("MachineName"),
            "resolution_x_px": stated("ResolutionX"),
            "resolution_y_px": stated("ResolutionY"),
            "display_width_mm": stated("DisplayWidth"),
            "display_height_mm": stated("DisplayHeight"),
            "pixel_width_um": stated("PixelWidthMicrons"),
            "pixel_height_um": stated("PixelHeightMicrons"),
            "layer_height_mm": stated("LayerHeight"),
            "layer_count": stated("LayerCount"),
            "bottom_layer_count": stated("BottomLayerCount", positive=False),
            "exposure_time_s": stated("ExposureTime"),
            "bottom_exposure_time_s": stated("BottomExposureTime"),
            "print_height_mm": stated("PrintHeight"),
            "print_time_s": stated("PrintTime"),
            "material_ml": stated("MaterialMilliliters"),
            "material_g": stated("MaterialGrams"),
            "material_name": text_value("MaterialName"),
            "volume_mm3": computed("Volume"),
            "computed_print_time_s": computed("PrintTimeComputed"),
            "display_on_time_s": computed("DisplayTotalOnTime"),
        },
    }


_MAIN = r"""
import hashlib, json, pathlib, re, subprocess, sys

FORMATS = {formats!r}

{facts}

raw_spec = sys.argv[1]
spec = json.loads(raw_spec)
assert spec["adapter"] == "print-resin-inspect-uvtools-v1"
out = pathlib.Path("/outputs")
target = pathlib.Path("/inputs") / spec["file"]["path"]
log = []


def fail(message):
    (out / "inspect.log").write_text("\n".join(log + ["error: " + message]) + "\n")
    print(message, file=sys.stderr)
    raise SystemExit(2)


if not target.is_file() or target.is_symlink():
    fail("Resin file is missing")
before = hashlib.sha256(target.read_bytes()).hexdigest()
if before != spec["file"]["sha256"]:
    fail("Resin file bytes differ from the exact pin")
tool = spec["tool"]
release = pathlib.Path("/opt/specmate/uvtools-release.txt").read_text().split("\n")
pinned = [tool["name"] + " " + tool["package_version"], tool["package"], tool["release_sha256"]]
if release[:3] != pinned:
    fail("Installed UVtools release differs from the pin")
argv = ["/opt/uvtools/UVtoolsCmd", "--no-progress", "print-properties", str(target)]
env = {
    "PATH": "/usr/bin:/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LC_ALL": "C",
    "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
}
log.append(json.dumps(argv))
proc = subprocess.run(argv, capture_output=True, env=env, cwd="/tmp", timeout=570)
text = proc.stdout.decode("utf-8", "replace")
log.append(proc.stderr.decode("utf-8", "replace").strip())
log.append("exit " + str(proc.returncode))
if proc.returncode:
    fail("UVtools could not read the file (exit " + str(proc.returncode) + ")")
if hashlib.sha256(target.read_bytes()).hexdigest() != before:
    fail("Resin file bytes changed during inspection")
parsed = properties_facts(text)
if parsed["format"] is None:
    fail("UVtools read the file as an unsupported format: " + str(parsed["format_class"]))
(out / "properties.txt").write_text(text)
(out / "inspect.log").write_text("\n".join(log) + "\n")
outputs = []
for path in ("inspect.log", "properties.txt"):
    content = (out / path).read_bytes()
    sha = hashlib.sha256(content).hexdigest()
    outputs.append({"path": path, "sha256": sha, "size": len(content)})
report = {
    "format_version": 1,
    "adapter": "print-resin-inspect-uvtools-v1",
    "input_sha256": hashlib.sha256(raw_spec.encode()).hexdigest(),
    "tool": {k: tool[k] for k in ("name", "package", "package_version", "release_sha256")},
    "file_sha256": before,
    "source_unchanged": True,
    "tool_exit_code": 0,
    "outputs": outputs,
    "file_format": parsed["format"],
    "format_class": parsed["format_class"],
    "file_format_version": parsed["format_version"],
    "facts": parsed["facts"],
    "printable": "not_evaluated",
    "printer_submission": "not_performed",
    "physical_qualification": False,
}
(out / "inspect.json").write_text(json.dumps(report, sort_keys=True, separators=(",", ":")))
"""

SCRIPT = _MAIN.replace("{formats!r}", repr(FORMATS)).replace(
    "{facts}", inspect.getsource(properties_facts)
)
