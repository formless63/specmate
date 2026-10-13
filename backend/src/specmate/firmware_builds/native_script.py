"""Trusted adapter text; executed only by an approved isolated native runner."""

SCRIPT = r"""
import hashlib, json, pathlib, subprocess, sys

spec = json.loads(sys.argv[1])
out = pathlib.Path("/outputs")
root = pathlib.Path("/inputs")
assert spec["adapter"] == "firmware-avr-gcc-v1"
assert spec["toolchain"] == {
    "family": "other",
    "name": "avr-gcc",
    "version": "5.4.0",
    "framework": "baremetal",
    "board_id": "atmega328p",
}
files = spec["sources"][0]["files"]


def hashes():
    result = {}
    for f in files:
        path = root / f["path"]
        assert path.is_file() and not path.is_symlink()
        result[f["path"]] = hashlib.sha256(path.read_bytes()).hexdigest()
        assert result[f["path"]] == f["sha256"]
    return result


before = hashes()
packages = {
    "gcc-avr": "1:5.4.0+Atmel3.6.2-3",
    "binutils-avr": "2.26.20160125+Atmel3.6.2-4",
    "avr-libc": "1:2.0.0+Atmel3.6.2-3",
}
for name, version in packages.items():
    actual = subprocess.run(
        ["/usr/bin/dpkg-query", "-W", "-f=${Version}", name],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    ).stdout
    assert actual == version, "Tool package differs from pin"
log = out / "compile.log"
env = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/tmp",
    "TMPDIR": "/tmp",
    "LC_ALL": "C",
    "SOURCE_DATE_EPOCH": "0",
}


def run(argv):
    with log.open("ab") as stream:
        stream.write((json.dumps(argv) + "\n").encode())
        proc = subprocess.run(
            argv,
            stdout=stream,
            stderr=subprocess.STDOUT,
            env=env,
            timeout=90,
            check=False,
        )
    if proc.returncode:
        raise RuntimeError("Compiler command failed, exit " + str(proc.returncode))


version = subprocess.run(
    ["/usr/bin/avr-gcc", "-dumpversion"],
    capture_output=True,
    text=True,
    env=env,
    timeout=5,
    check=True,
).stdout.strip()
assert version == "5.4.0", "Compiler version differs from pin"
entries = [f for f in files if f["role"] in ("application", "library")]
assert entries and all(f["path"].endswith(".c") for f in entries)
flags = []
for entry in spec["configuration"]:
    assert entry["status"] == "known"
    key, value = entry["key"], entry["value"]
    assert key.replace("_", "").isalnum() and not key[0].isdigit()
    assert value.isdecimal() and len(value) <= 10
    flags.append("-D" + key + "=" + value)
argv = [
    "/usr/bin/avr-gcc",
    "-mmcu=atmega328p",
    "-std=c11",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I/inputs",
    *flags,
    *[str(root / f["path"]) for f in entries],
    "-o",
    "/outputs/firmware.elf",
]
run(argv)
run(
    [
        "/usr/bin/avr-objcopy",
        "-O",
        "ihex",
        "-R",
        ".eeprom",
        "/outputs/firmware.elf",
        "/outputs/firmware.hex",
    ]
)
run(["/usr/bin/avr-size", "/outputs/firmware.elf"])
assert hashes() == before
(out / "handoff.json").write_text(
    json.dumps(
        {
            "format_version": 1,
            "inputs": spec,
            "flashing": "not_performed",
            "device_operation": "not_observed",
            "hardware_compatibility": "not_evaluated",
            "physical_qualification": False,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
)
outputs = []
for path in ("compile.log", "firmware.elf", "firmware.hex", "handoff.json"):
    raw = (out / path).read_bytes()
    assert 0 < len(raw) <= 16 * 1024**2
    outputs.append(
        {"path": path, "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}
    )
report = {
    "format_version": 1,
    "adapter": "firmware-avr-gcc-v1",
    "input_sha256": hashlib.sha256(sys.argv[1].encode()).hexdigest(),
    "compiler_version": version,
    "tool_packages": packages,
    "compiler_exit_code": 0,
    "source_unchanged": True,
    "outputs": outputs,
    "hardware_compatibility": "not_evaluated",
    "flashing": "not_performed",
    "device_operation": "not_observed",
    "physical_qualification": False,
}
(out / "compile.json").write_text(
    json.dumps(report, sort_keys=True, separators=(",", ":"))
)
"""
