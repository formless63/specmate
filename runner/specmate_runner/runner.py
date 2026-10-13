"""Single-stage loop with durable, fenced process receipts and restart reconciliation."""

import fcntl
import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

from .docker import RuntimeFailure, ToolUnavailable
from .protocol import Rejected, Unavailable
from .validation import (
    Invalid,
    hash_file,
    inspect_outputs,
    validate_identity,
    validate_manifest,
)


class Runner:
    def __init__(self, client, docker, state_dir, host_state_dir, *, poll_seconds=2):
        self.client, self.docker = client, docker
        self.root = Path(state_dir).absolute()
        self.host_root = Path(host_state_dir)
        if not self.host_root.is_absolute() or "," in str(self.host_root):
            raise ValueError(
                "Host state directory must be an absolute Docker bind path"
            )
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ValueError("Runner state must not be a symlink")
        self.root.chmod(0o700)
        self.poll_seconds = poll_seconds
        self.stopping = False

    @contextmanager
    def lock(self):
        """One controller may use this durable state directory at a time."""
        with (self.root / "runner.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def save(self, receipt):
        directory = self.root / receipt["identity"]
        directory.mkdir(mode=0o700, exist_ok=True)
        temporary = directory / "receipt.tmp"
        with temporary.open("w") as output:
            json.dump(receipt, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        temporary.replace(directory / "receipt.json")
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def prepare(self, lease):
        validate_identity(lease)
        identity = hashlib.sha256(
            json.dumps([lease["stage_id"], lease["fencing_token"]]).encode()
        ).hexdigest()
        receipt = {
            "identity": identity,
            "name": "specmate-stage-" + identity[:40],
            "lease": lease,
            "phase": "prepared",
            "started_at": None,
            "result": None,
        }
        if (self.root / identity / "receipt.json").exists():
            raise Invalid("Lease already has a local execution receipt")
        self.save(receipt)
        return receipt

    def stage_inputs(self, receipt):
        directory = self.root / receipt["identity"]
        inputs, outputs = directory / "inputs", directory / "outputs"
        inputs.mkdir(mode=0o755, exist_ok=True)
        outputs.mkdir(mode=0o700, exist_ok=True)
        uid, gid = (int(value) for value in self.docker.user.split(":"))
        if os.getuid() == 0:
            os.chown(outputs, uid, gid)
        elif uid != os.getuid() or gid != os.getgid():
            raise Invalid("Tool UID/GID must own the private output directory")
        for item in receipt["lease"]["inputs"]:
            target = inputs / item["path"]
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            if target.exists():
                if target.is_symlink() or target.stat().st_size != item["bytes"]:
                    raise Invalid("Existing staged input is invalid")
            else:
                self.client.download(receipt["lease"], item, target)
            if hash_file(target) != item["sha256"]:
                raise Invalid("Input digest mismatch")
            target.chmod(0o444)

    def result(self, receipt, outcome, exit_code, message, outputs=None):
        receipt["result"] = {
            "outcome": outcome,
            "exit_code": exit_code,
            "outputs": outputs or [],
            "message": message,
        }
        receipt["phase"] = "stopped"
        self.save(receipt)

    def stop(self, receipt):
        return self.docker.stop(receipt["name"], receipt["identity"])

    def finish(self, receipt):
        """The exact persisted completion request is replayed after a lost acknowledgment."""
        result = receipt["result"]
        if result["outcome"] == "succeeded" and receipt["phase"] != "uploaded":
            for item in receipt["artifacts"]:
                self.client.upload(
                    receipt["lease"],
                    item,
                    self.root / receipt["identity"] / "outputs" / item["path"],
                )
            receipt["phase"] = "uploaded"
            self.save(receipt)
        self.client.complete(receipt["lease"], result)
        receipt["phase"] = "accepted"
        self.save(receipt)
        self.docker.remove(receipt["name"], receipt["identity"])

    def run_receipt(self, receipt, *, recovered):
        lease, identity, name = receipt["lease"], receipt["identity"], receipt["name"]
        try:
            validate_manifest(lease)
            container = self.docker.inspect(name, identity)
            orphaned = receipt.get("orphaned", False) or (
                container is not None
                and receipt["started_at"] is None
                and (not recovered or container["State"].get("Status") != "created")
            )
            if orphaned or receipt["result"]:
                container = self.stop(receipt)
            if recovered or orphaned:
                observed = (
                    "absent"
                    if container is None
                    else ("running" if container["State"]["Running"] else "stopped")
                )
                control = self.client.reconcile(
                    lease, container["Id"] if container else name, observed
                )
            else:
                control = self.client.heartbeat(lease)
            if (
                receipt["result"]
                and control["cancellation_requested"]
                and control.get("state") not in {"succeeded", "failed", "cancelled"}
            ):
                self.result(
                    receipt,
                    "cancelled",
                    None,
                    "Container termination confirmed",
                    outputs=control.get("verified_outputs", []),
                )
            if receipt["result"]:
                # Renew the unchanged token before accepting a result persisted before
                # a crash. An already terminal stage permits identical receipt replay.
                if control.get("state") in {"succeeded", "failed", "cancelled"}:
                    receipt["phase"] = "uploaded"
                    self.save(receipt)
                self.finish(receipt)
                return
            if orphaned and not control["cancellation_requested"]:
                self.result(
                    receipt,
                    "failed",
                    None,
                    "Prior execution receipt missing; replacement execution refused",
                    outputs=control.get("verified_outputs", []),
                )
                self.finish(receipt)
                return
            if control["cancellation_requested"]:
                self.stop(receipt)
                self.result(
                    receipt,
                    "cancelled",
                    None,
                    "Container termination confirmed",
                    outputs=control.get("verified_outputs", []),
                )
                self.finish(receipt)
                return
            if container is None and receipt["started_at"] is not None:
                self.result(
                    receipt, "failed", None, "Previously started container is absent"
                )
                self.finish(receipt)
                return
            if container is None:
                self.stage_inputs(receipt)
                host_directory = self.host_root / identity
                self.docker.create(
                    name,
                    identity,
                    lease["recipe"],
                    host_directory / "inputs",
                    host_directory / "outputs",
                )
                container = self.docker.inspect(name, identity)
            if container["State"]["Status"] == "created":
                if receipt["started_at"] is not None:
                    self.result(
                        receipt, "failed", None, "Container start was interrupted"
                    )
                    self.finish(receipt)
                    return
                # Persist intent before start. Recovery never restarts exited work.
                receipt["started_at"] = time.time()
                receipt["phase"] = "running"
                self.save(receipt)
                self.docker.start(name)
            self.supervise(receipt)
            self.finish(receipt)
        except Rejected:
            self.stop(receipt)
            receipt["phase"] = "fenced"
            self.save(receipt)
            # No result registration is attempted using refused authority.
        except ToolUnavailable:
            self.stop(receipt)
            self.result(
                receipt, "failed", None, "Approved image is unavailable on this runner"
            )
            self.finish(receipt)
        except (Unavailable, RuntimeFailure, OSError):
            # Loss of control cannot leave an unbounded process. Preserve the receipt
            # for reconciliation; a failed stop also remains unresolved, never cancelled.
            self.stop(receipt)
            raise
        except Invalid:
            self.stop(receipt)
            self.result(
                receipt,
                "failed",
                None,
                "Manifest, staged bytes or output validation failed",
            )
            self.finish(receipt)
        except Exception:
            # Unexpected adapter failures must not abandon a live native process.
            # Preserve the receipt and let the supervisor restart this controller.
            self.stop(receipt)
            raise

    def supervise(self, receipt):
        lease = receipt["lease"]
        recipe = lease["recipe"]
        output_root = self.root / receipt["identity"] / "outputs"
        while True:
            control = self.client.heartbeat(lease)
            if self.stopping or control["cancellation_requested"]:
                self.stop(receipt)
                outcome = "cancelled" if control["cancellation_requested"] else "failed"
                self.result(receipt, outcome, None, "Container termination confirmed")
                return
            if (
                time.time() - receipt["started_at"]
                >= recipe["limits"]["timeout_seconds"]
            ):
                self.stop(receipt)
                self.result(
                    receipt,
                    "failed",
                    None,
                    "Stage exceeded timeout; termination confirmed",
                )
                return
            container = self.docker.inspect(receipt["name"], receipt["identity"])
            if container is None:
                self.result(receipt, "failed", None, "Started container disappeared")
                return
            running = container["State"]["Running"]
            inspect_outputs(
                output_root,
                recipe["outputs"],
                recipe["limits"]["max_output_bytes"],
                complete=False,
            )
            if not running:
                code = container["State"]["ExitCode"]
                if code == 0:
                    artifacts = inspect_outputs(
                        output_root,
                        recipe["outputs"],
                        recipe["limits"]["max_output_bytes"],
                        complete=True,
                    )
                    receipt["artifacts"] = artifacts
                    self.result(
                        receipt,
                        "succeeded",
                        0,
                        "Tool execution completed; not engineering qualification",
                        [
                            {"path": item["path"], "sha256": item["sha256"]}
                            for item in artifacts
                        ],
                    )
                else:
                    self.result(receipt, "failed", code, "Tool exited unsuccessfully")
                return
            time.sleep(self.poll_seconds)

    def tick(self):
        pending = []
        for path in sorted(self.root.glob("*/receipt.json")):
            if path.is_symlink() or path.parent.is_symlink():
                raise Invalid("Unsafe durable receipt path")
            receipt = json.loads(path.read_text())
            if path.parent.name != receipt["identity"]:
                raise Invalid("Receipt identity mismatch")
            if receipt["phase"] not in {"accepted", "fenced"}:
                pending.append(receipt)
        if pending:
            # Recover before claiming anything new. One heavy stage at a time.
            self.run_receipt(pending[0], recovered=True)
            return True
        if self.stopping:
            return False
        lease = self.client.claim()
        if lease is None:
            return False
        receipt = self.prepare(lease)
        receipt["orphaned"] = bool(lease.get("reconciliation_required"))
        self.save(receipt)
        self.run_receipt(receipt, recovered=receipt["orphaned"])
        return True
