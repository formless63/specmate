"""Trusted slicer adapter text; executed only by an approved isolated native runner.

The program checks the exact model bytes and tool package, writes the declared settings
to a private configuration file, runs the PrusaSlicer command line with fixed arguments
and reports output hashes. Estimates come from the slicer's own G-code comments; an
estimate the slicer does not state, or states as zero, is reported unknown.
"""

ADAPTER = "print-slice-prusaslicer-v1"

SCRIPT = r"""
import hashlib, json, pathlib, re, subprocess, sys

raw_spec = sys.argv[1]
spec = json.loads(raw_spec)
assert spec["adapter"] == "print-slice-prusaslicer-v1"
out = pathlib.Path("/outputs")
model = pathlib.Path("/inputs") / spec["part"]["path"]
assert model.is_file() and not model.is_symlink()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


before = digest(model)
assert before == spec["part"]["sha256"], "Model bytes differ from the exact pin"
env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LC_ALL": "C"}
version = subprocess.run(
    ["/usr/bin/dpkg-query", "-W", "-f=${Version}", spec["tool"]["package"]],
    capture_output=True, text=True, timeout=10, check=True, env=env,
).stdout
assert version == spec["tool"]["package_version"], "Slicer package differs from pin"
config = pathlib.Path("/tmp/specmate-slice.ini")
config.write_text("".join(k + " = " + v + "\n" for k, v in sorted(spec["config"].items())))
fmt = spec["output_format"]
target = out / ("slice.gcode" if fmt == "gcode" else "prepared.3mf")
argv = [
    "/usr/bin/prusa-slicer",
    "--export-gcode" if fmt == "gcode" else "--export-3mf",
    "--load", str(config),
]
orientation = spec["orientation"]
if orientation["status"] == "rotated":
    x, y, z = orientation["rotation_deg"]
    argv += ["--rotate-x", repr(float(x)), "--rotate-y", repr(float(y))]
    argv += ["--rotate", repr(float(z))]
if spec["copies"] > 1:
    argv += ["--duplicate", str(spec["copies"])]
argv += ["--ensure-on-bed", "--output", str(target), str(model)]
log = out / "slice.log"
with log.open("wb") as stream:
    stream.write((json.dumps(argv) + "\n").encode())
    stream.flush()
    proc = subprocess.run(argv, stdout=stream, stderr=subprocess.STDOUT, env=env, timeout=840)
if proc.returncode:
    raise SystemExit(proc.returncode)
assert digest(model) == before, "Model bytes changed during slicing"
data = target.read_bytes()
assert 0 < len(data) <= 64 * 1024**2


def estimate(value):
    if value is None or value <= 0:
        return {"value": None, "status": "unknown"}
    return {"value": value, "status": "slicer_estimate"}


time_s = length = mass = None
if fmt == "gcode":
    text = data.decode("utf-8", "replace")
    match = re.search(r"^; estimated printing time \(normal mode\) = (.+)$", text, re.M)
    if match:
        units = {"d": 86400, "h": 3600, "m": 60, "s": 1}
        parts = re.findall(r"(\d+)([dhms])", match.group(1))
        time_s = float(sum(int(n) * units[u] for n, u in parts)) if parts else None
    match = re.search(r"^; filament used \[mm\] = ([0-9.]+)", text, re.M)
    length = float(match.group(1)) if match else None
    match = re.search(r"^; filament used \[g\] = ([0-9.]+)", text, re.M)
    if match and spec["mass_estimate"] == "density_declared":
        mass = float(match.group(1))
outputs = []
for path in sorted(["slice.log", target.name]):
    content = (out / path).read_bytes()
    sha = hashlib.sha256(content).hexdigest()
    outputs.append({"path": path, "sha256": sha, "size": len(content)})
report = {
    "format_version": 1,
    "adapter": "print-slice-prusaslicer-v1",
    "input_sha256": hashlib.sha256(raw_spec.encode()).hexdigest(),
    "tool": {
        "name": spec["tool"]["name"],
        "package": spec["tool"]["package"],
        "package_version": version,
    },
    "model_sha256": before,
    "source_unchanged": True,
    "slicer_exit_code": 0,
    "outputs": outputs,
    "estimates": {
        "print_time_s": estimate(time_s),
        "filament_length_mm": estimate(length),
        "filament_mass_g": estimate(mass),
    },
    "printable": "not_evaluated",
    "printer_submission": "not_performed",
    "physical_qualification": False,
}
(out / "slice.json").write_text(json.dumps(report, sort_keys=True, separators=(",", ":")))
"""
