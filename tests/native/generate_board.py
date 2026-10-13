"""Keep KiCad's incidental project/settings files in disposable container storage."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    generator, output = map(Path, sys.argv[1:])
    os.environ.update(
        HOME="/tmp/kicad-home",
        XDG_CONFIG_HOME="/tmp/kicad-home/config",
        XDG_CACHE_HOME="/tmp/kicad-home/cache",
    )
    Path(os.environ["HOME"]).mkdir(exist_ok=True)
    evidence = {"status": "failed"}
    try:
        with tempfile.TemporaryDirectory() as temporary:
            board = Path(temporary) / "generated.kicad_pcb"
            result = subprocess.run(
                ["/usr/bin/python3", str(generator), str(board)],
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
            evidence.update(
                exit_code=result.returncode,
                stdout=result.stdout[-16384:],
                stderr=result.stderr[-16384:],
            )
            if result.returncode:
                raise ValueError("Native board authoring failed")
            shutil.copyfile(board, output / "generated.kicad_pcb")
            evidence["status"] = "succeeded"
    except Exception as exc:  # noqa: BLE001
        # Keep native/runtime diagnostics as failed evidence, then exit nonzero.
        evidence["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        (output / "generation.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return 0 if evidence["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
