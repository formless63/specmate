"""Boundary tests; Docker integration is explicitly enabled with a cached digest image."""

import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from specmate_runner.docker import Docker
from specmate_runner.protocol import Client, Rejected, Unavailable
from specmate_runner.runner import Runner
from specmate_runner.validation import (
    Invalid,
    inspect_outputs,
    safe_path,
    validate_manifest,
)


def manifest(image=None, argv=None):
    return {
        "stage_id": "00000000-0000-4000-8000-000000000001",
        "build_id": "00000000-0000-4000-8000-000000000002",
        "fencing_token": "lease-1",
        "source_revision_id": "00000000-0000-4000-8000-000000000003",
        "lease_expires_at": "2099-01-01T00:00:00Z",
        "recipe": {
            "id": "synthetic-execution-v1",
            "image": image or "sha256:" + "a" * 64,
            "argv": argv or ["/bin/true"],
            "input_mount": "/inputs",
            "output_mount": "/outputs",
            "network": "none",
            "outputs": [],
            "limits": {
                "cpus": 1,
                "memory_bytes": 64 * 1024 * 1024,
                "timeout_seconds": 30,
                "pids": 32,
                "max_output_bytes": 1024 * 1024,
            },
        },
        "inputs": [],
    }


class ValidationTests(unittest.TestCase):
    def test_paths_and_resource_policy(self):
        for path in (
            "../secret",
            "/secret",
            "a/../b",
            "a//b",
            "a\\b",
            "a:\\b",
            "a/",
            "a\x00b",
        ):
            with self.subTest(path=path), self.assertRaises(Invalid):
                safe_path(path)
        validate_manifest(manifest())
        for field, value in (
            ("network", "host"),
            ("image", "tool:latest"),
            ("image", "sha256:" + "0" * 64),
            ("argv", "echo hello"),
            ("argv", ["relative-command"]),
        ):
            item = manifest()
            item["recipe"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(Invalid):
                validate_manifest(item)
        item = manifest()
        item["recipe"]["limits"]["cpus"] = float("nan")
        with self.assertRaises(Invalid):
            validate_manifest(item)

    def test_file_declarations_cannot_shadow_directories(self):
        item = manifest()
        item["recipe"]["outputs"] = [
            {"path": value, "media_type": "text/plain", "rights": "CC0-1.0"}
            for value in ("a", "a/b")
        ]
        with self.assertRaises(Invalid):
            validate_manifest(item)

    def test_output_hash_size_declared_paths_and_symlinks(self):
        declared = [
            {"path": "result.txt", "media_type": "text/plain", "rights": "CC0-1.0"}
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "result.txt"
            target.write_bytes(b"synthetic\n")
            result = inspect_outputs(root, declared, 20, complete=True)
            self.assertEqual(
                result[0]["sha256"], hashlib.sha256(b"synthetic\n").hexdigest()
            )
            with self.assertRaises(Invalid):
                inspect_outputs(root, declared, 1, complete=True)
            (root / "extra").write_text("unapproved")
            with self.assertRaises(Invalid):
                inspect_outputs(root, declared, 100, complete=True)
            (root / "extra").unlink()
            target.unlink()
            target.symlink_to("/etc/passwd")
            with self.assertRaises(Invalid):
                inspect_outputs(root, declared, 100, complete=True)

    def test_deep_output_directories_are_bounded_before_recursion_exhaustion(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / Path(*(["a"] * 34))).mkdir(parents=True)
            with self.assertRaises(Invalid):
                inspect_outputs(root, [], 100, complete=False)

    def test_docker_argument_boundary(self):
        docker = Docker()
        docker.command = Mock(return_value="container-id\n")
        recipe = manifest()["recipe"]
        recipe["argv"] = ["/bin/tool", "$(touch /untrusted)"]
        docker.create("owned", "receipt", recipe, "/private/inputs", "/private/outputs")
        args = docker.command.call_args.args[0]
        for option in (
            "--network=none",
            "--cap-drop=ALL",
            "--read-only",
            "--pull=never",
            "--security-opt=no-new-privileges:true",
        ):
            self.assertIn(option, args)
        self.assertIn("65532:65532", args)
        self.assertEqual(args[-1], "$(touch /untrusted)")
        self.assertNotIn("--privileged", args)
        self.assertEqual(sum("type=bind" in arg for arg in args), 2)

    def test_client_never_accepts_url_credentials(self):
        with self.assertRaises(ValueError):
            Client("http://credential@example.test", "token")


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = Mock()
        self.client.heartbeat.return_value = {"cancellation_requested": False}
        self.client.reconcile.return_value = {"cancellation_requested": False}
        self.docker = Mock(user=f"{os.getuid()}:{os.getgid()}")
        self.docker.stop.return_value = None
        self.runner = Runner(
            self.client, self.docker, self.temp.name, self.temp.name, poll_seconds=0.01
        )
        self.receipt = self.runner.prepare(manifest())

    def persisted(self):
        return json.loads(
            (
                Path(self.temp.name) / self.receipt["identity"] / "receipt.json"
            ).read_text()
        )

    def test_cancellation_ack_follows_actual_stop(self):
        self.receipt["started_at"] = 1
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True},
        }
        self.client.reconcile.return_value = {"cancellation_requested": True}
        events = []
        self.docker.stop.side_effect = lambda *args: events.append("stopped")
        self.client.complete.side_effect = lambda *args: events.append("accepted")
        self.runner.run_receipt(self.receipt, recovered=True)
        self.assertEqual(events, ["stopped", "accepted"])
        self.assertEqual(self.persisted()["result"]["outcome"], "cancelled")

    def test_stale_lease_is_stopped_and_never_submitted(self):
        self.receipt["started_at"] = 1
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True},
        }
        self.client.reconcile.side_effect = Rejected("stale")
        events = []
        self.docker.stop.side_effect = lambda *args: events.append("stopped")
        self.docker.remove.side_effect = lambda *args: events.append("removed")
        self.runner.run_receipt(self.receipt, recovered=True)
        self.docker.stop.assert_called_once()
        self.client.complete.assert_not_called()
        self.assertEqual(self.persisted()["phase"], "fenced")
        # The stopped container is removed after the fenced receipt is persisted.
        self.assertEqual(events, ["stopped", "removed"])
        self.docker.remove.assert_called_once_with(
            self.receipt["name"], self.receipt["identity"]
        )

    def test_revoked_authority_during_supervision_stops_and_removes_container(self):
        self.receipt["started_at"] = 1
        self.receipt["phase"] = "running"
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        # The first heartbeat succeeds; the credential is revoked before the next one.
        self.client.heartbeat.side_effect = [
            {"cancellation_requested": False},
            Rejected("Runner operation rejected (401)"),
        ]
        events = []
        self.docker.stop.side_effect = lambda *args: events.append("stopped")
        self.docker.remove.side_effect = lambda *args: events.append("removed")
        self.runner.run_receipt(self.receipt, recovered=False)
        self.client.complete.assert_not_called()
        self.assertEqual(self.persisted()["phase"], "fenced")
        self.assertEqual(events[-2:], ["stopped", "removed"])

    def test_lost_completion_ack_replays_without_restarting(self):
        self.docker.inspect.return_value = None
        self.runner.result(self.receipt, "failed", 1, "Synthetic failure")
        self.client.complete.side_effect = [Unavailable("lost acknowledgment"), {}]
        with self.assertRaises(Unavailable):
            self.runner.run_receipt(self.receipt, recovered=True)
        recovered = self.persisted()
        self.runner.run_receipt(recovered, recovered=True)
        self.assertEqual(self.client.complete.call_count, 2)
        self.assertEqual(
            self.client.complete.call_args_list[0],
            self.client.complete.call_args_list[1],
        )
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()

    def test_lost_success_ack_does_not_reupload_after_terminal(self):
        self.docker.inspect.return_value = None
        self.receipt["artifacts"] = [{"path": "result.txt"}]
        self.runner.result(self.receipt, "succeeded", 0, "Synthetic")
        self.client.complete.side_effect = [Unavailable("lost acknowledgment"), {}]
        with self.assertRaises(Unavailable):
            self.runner.run_receipt(self.receipt, recovered=True)
        self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(self.client.upload.call_count, 1)
        self.assertEqual(self.client.complete.call_count, 2)

    def failed_tool_with_report(self):
        self.receipt["lease"]["recipe"]["outputs"] = [
            {"path": "report.json", "media_type": "application/json", "rights": "r"},
            {"path": "result.txt", "media_type": "text/plain", "rights": "r"},
        ]
        outputs = Path(self.temp.name) / self.receipt["identity"] / "outputs"
        outputs.mkdir(parents=True, exist_ok=True)
        (outputs / "report.json").write_bytes(b'{"check": "synthetic"}')
        self.receipt["started_at"] = time.time()
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": False, "ExitCode": 12},
        }
        self.runner.supervise(self.receipt)
        return hashlib.sha256(b'{"check": "synthetic"}').hexdigest()

    def test_failed_tool_registers_declared_partial_outputs(self):
        digest = self.failed_tool_with_report()
        self.runner.finish(self.receipt)
        self.assertEqual(self.client.upload.call_count, 1)
        self.assertEqual(self.client.upload.call_args.args[1]["path"], "report.json")
        sent = self.client.complete.call_args.args[1]
        self.assertEqual((sent["outcome"], sent["exit_code"]), ("failed", 12))
        self.assertEqual(sent["outputs"], [{"path": "report.json", "sha256": digest}])

    def test_exited_container_reports_its_resolved_image_id(self):
        self.receipt["started_at"] = time.time()
        image = "sha256:" + "b" * 64
        self.docker.inspect.return_value = {
            "Id": "container",
            "Image": image,
            "State": {"Running": False, "ExitCode": 0},
        }
        self.runner.supervise(self.receipt)
        self.runner.finish(self.receipt)
        sent = self.client.complete.call_args.args[1]
        self.assertEqual((sent["outcome"], sent["image_id"]), ("succeeded", image))
        self.assertEqual(self.persisted()["result"]["image_id"], image)

    def test_unrecognized_image_identity_is_not_reported(self):
        self.receipt["started_at"] = time.time()
        self.docker.inspect.return_value = {
            "Id": "container",
            "Image": "not-an-image-id",
            "State": {"Running": False, "ExitCode": 3},
        }
        self.runner.supervise(self.receipt)
        self.runner.finish(self.receipt)
        self.assertNotIn("image_id", self.client.complete.call_args.args[1])

    def test_refused_failure_report_upload_keeps_the_failure(self):
        self.failed_tool_with_report()
        self.client.upload.side_effect = Rejected("execution no longer authorized")
        self.runner.finish(self.receipt)
        sent = self.client.complete.call_args.args[1]
        self.assertEqual(
            (sent["outcome"], sent["exit_code"], sent["outputs"]), ("failed", 12, [])
        )
        self.assertEqual(self.persisted()["result"]["outputs"], [])

    def test_persisted_result_renews_expired_authority_before_acceptance(self):
        self.docker.inspect.return_value = None
        self.runner.result(self.receipt, "failed", 1, "Synthetic failure")
        events = []
        self.client.reconcile.side_effect = lambda *args: (
            events.append("reconciled")
            or {"state": "running", "cancellation_requested": False}
        )
        self.client.complete.side_effect = lambda *args: events.append("accepted")
        self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(events, ["reconciled", "accepted"])
        self.docker.start.assert_not_called()

    def test_missing_local_receipt_never_reexecutes_uncertain_lease(self):
        self.docker.inspect.return_value = None
        lease = manifest()
        lease["reconciliation_required"] = True
        self.client.claim.return_value = lease
        directory = str(Path(self.temp.name) / "new-controller")
        runner = Runner(self.client, self.docker, directory, directory)
        runner.tick()
        self.client.reconcile.assert_called_once()
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()
        result = self.client.complete.call_args.args[1]
        self.assertEqual(result["outcome"], "failed")
        self.assertIn("receipt missing", result["message"])

    def test_unexpected_existing_container_without_receipt_is_stopped(self):
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        self.runner.run_receipt(self.receipt, recovered=False)
        self.docker.stop.assert_called_once()
        self.client.reconcile.assert_called_once()
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()
        self.assertEqual(self.persisted()["result"]["outcome"], "failed")

    def test_cancel_arriving_before_persisted_success_acceptance_is_honored(self):
        self.docker.inspect.return_value = None
        self.receipt["artifacts"] = []
        self.runner.result(self.receipt, "succeeded", 0, "Synthetic success")
        self.client.reconcile.return_value = {
            "state": "cancellation-requested",
            "cancellation_requested": True,
        }
        self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(self.client.complete.call_args.args[1]["outcome"], "cancelled")
        self.client.upload.assert_not_called()

    def test_cancel_after_partial_upload_crash_reports_exact_verified_subset(self):
        self.docker.inspect.return_value = None
        outputs = [
            {"path": "first.txt", "sha256": hashlib.sha256(b"first").hexdigest()},
            {"path": "second.txt", "sha256": hashlib.sha256(b"second").hexdigest()},
        ]
        self.receipt["artifacts"] = outputs
        self.runner.result(self.receipt, "succeeded", 0, "Synthetic success", outputs)
        verified = []
        successful_artifacts = []

        def upload(lease, item, target):
            if verified:
                raise Unavailable("Crash during second upload")
            verified.append({"path": item["path"], "sha256": item["sha256"]})

        def complete(lease, result):
            if result["outputs"] != verified:
                raise Rejected("Completion must match the exact verified upload set")
            if result["outcome"] == "succeeded":
                successful_artifacts.extend(verified)
            return {"state": result["outcome"]}

        self.client.upload.side_effect = upload
        self.client.complete.side_effect = complete
        with self.assertRaises(Unavailable):
            self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(verified, outputs[:1])
        self.client.complete.assert_not_called()
        self.client.reconcile.return_value = {
            "state": "cancellation-requested",
            "cancellation_requested": True,
            "verified_outputs": verified,
        }
        self.runner.run_receipt(self.persisted(), recovered=True)
        result = self.persisted()
        self.assertEqual(result["phase"], "accepted")
        self.assertEqual(result["result"]["outcome"], "cancelled")
        self.assertEqual(result["result"]["outputs"], outputs[:1])
        self.assertEqual(self.client.upload.call_count, 2)
        self.assertEqual(successful_artifacts, [])
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()

    def test_cancel_after_all_uploads_and_failed_completion_keeps_verified_receipts(
        self,
    ):
        self.docker.inspect.return_value = None
        verified = [
            {"path": "result.txt", "sha256": hashlib.sha256(b"result").hexdigest()}
        ]
        self.receipt["artifacts"] = verified
        self.runner.result(self.receipt, "succeeded", 0, "Synthetic success", verified)
        self.client.complete.side_effect = Unavailable(
            "Crash before completion committed"
        )
        with self.assertRaises(Unavailable):
            self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(self.persisted()["phase"], "uploaded")
        self.client.reconcile.return_value = {
            "state": "cancellation-requested",
            "cancellation_requested": True,
            "verified_outputs": verified,
        }

        def complete(lease, result):
            if result["outputs"] != verified or result["outcome"] != "cancelled":
                raise Rejected("Expected cancelled completion with verified receipts")
            return {"state": "cancelled"}

        self.client.complete.side_effect = complete
        self.runner.run_receipt(self.persisted(), recovered=True)
        self.assertEqual(self.persisted()["phase"], "accepted")
        self.assertEqual(self.persisted()["result"]["outcome"], "cancelled")
        self.assertEqual(self.client.upload.call_count, 1)

    def test_orphaned_failure_includes_existing_verified_uploads(self):
        self.docker.inspect.return_value = None
        self.receipt["orphaned"] = True
        verified = [
            {"path": "partial.txt", "sha256": hashlib.sha256(b"partial").hexdigest()}
        ]
        self.client.reconcile.return_value = {
            "state": "running",
            "cancellation_requested": False,
            "verified_outputs": verified,
        }
        self.runner.run_receipt(self.receipt, recovered=True)
        result = self.client.complete.call_args.args[1]
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(result["outputs"], verified)
        self.docker.create.assert_not_called()
        self.client.upload.assert_not_called()

    def test_unsupported_policy_completes_failed_without_execution(self):
        lease = manifest()
        lease["recipe"]["limits"]["max_output_bytes"] = 64 * 1024 * 1024 + 1
        lease["fencing_token"] = "unsupported-policy"
        receipt = self.runner.prepare(lease)
        self.runner.run_receipt(receipt, recovered=False)
        self.assertEqual(self.client.complete.call_args.args[1]["outcome"], "failed")
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()

    def test_unexpected_adapter_failure_stops_actual_work_before_propagation(self):
        self.receipt["started_at"] = 1
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        self.client.heartbeat.side_effect = TypeError("Unexpected protocol shape")
        with self.assertRaises(TypeError):
            self.runner.run_receipt(self.receipt, recovered=False)
        self.docker.stop.assert_called_once()
        self.client.complete.assert_not_called()

    def test_absent_started_container_is_not_reexecuted(self):
        self.docker.inspect.return_value = None
        self.receipt["started_at"] = 1
        self.runner.save(self.receipt)
        self.runner.run_receipt(self.receipt, recovered=True)
        self.docker.create.assert_not_called()
        self.assertEqual(self.persisted()["result"]["outcome"], "failed")

    def test_persisted_tool_failure_is_replayed_not_rewritten_as_cancelled(self):
        self.docker.inspect.return_value = None
        self.runner.result(self.receipt, "failed", 7, "Tool exited unsuccessfully")
        self.client.reconcile.return_value = {
            "state": "cancellation_requested",
            "cancellation_requested": True,
        }
        self.runner.run_receipt(self.persisted(), recovered=True)
        sent = self.client.complete.call_args.args[1]
        self.assertEqual(
            (sent["outcome"], sent["exit_code"], sent["message"]),
            ("failed", 7, "Tool exited unsuccessfully"),
        )
        self.docker.create.assert_not_called()
        self.docker.start.assert_not_called()

    def test_cancel_before_success_acceptance_keeps_observed_exit_code(self):
        self.docker.inspect.return_value = None
        self.receipt["artifacts"] = []
        self.runner.result(self.receipt, "succeeded", 0, "Synthetic success")
        self.client.reconcile.return_value = {
            "state": "cancellation_requested",
            "cancellation_requested": True,
        }
        self.runner.run_receipt(self.persisted(), recovered=True)
        sent = self.client.complete.call_args.args[1]
        self.assertEqual((sent["outcome"], sent["exit_code"]), ("cancelled", 0))
        self.assertIn("Cancellation was requested", sent["message"])

    def test_runner_shutdown_is_failure_not_cancellation(self):
        self.receipt["started_at"] = time.time()
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        events = []
        self.docker.stop.side_effect = lambda *args: events.append("stopped")
        self.client.complete.side_effect = lambda *args: events.append("reported")
        self.runner.stopping = True
        self.runner.supervise(self.receipt)
        self.runner.finish(self.receipt)
        sent = self.client.complete.call_args.args[1]
        self.assertEqual(events, ["stopped", "reported"])
        self.assertEqual(sent["outcome"], "failed")
        self.assertIn("Runner shutdown", sent["message"])

    def test_requested_cancellation_stops_before_cancelled_is_reported(self):
        self.receipt["started_at"] = time.time()
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        self.client.heartbeat.return_value = {"cancellation_requested": True}
        events = []
        self.docker.stop.side_effect = lambda *args: events.append("stopped")
        self.client.complete.side_effect = lambda *args: events.append("reported")
        self.runner.supervise(self.receipt)
        self.runner.finish(self.receipt)
        self.assertEqual(events, ["stopped", "reported"])
        self.assertEqual(self.client.complete.call_args.args[1]["outcome"], "cancelled")

    def test_unconfirmed_stop_never_reports_cancellation(self):
        from specmate_runner.docker import RuntimeFailure

        self.receipt["started_at"] = time.time()
        self.docker.inspect.return_value = {
            "Id": "container",
            "State": {"Running": True, "Status": "running"},
        }
        self.client.heartbeat.return_value = {"cancellation_requested": True}
        self.docker.stop.side_effect = RuntimeFailure(
            "Container termination was not confirmed"
        )
        with self.assertRaises(RuntimeFailure):
            self.runner.run_receipt(self.receipt, recovered=False)
        self.client.complete.assert_not_called()
        self.assertIsNone(self.persisted()["result"])


PROBE_SCRIPT = r"""
import errno, json, os, socket
def connect(host, port):
    s = socket.socket()
    s.settimeout(2)
    try:
        s.connect((host, port))
        return "connected"
    except OSError as exc:
        return errno.errorcode.get(exc.errno, type(exc).__name__)
    finally:
        s.close()
def status(key):
    for line in open("/proc/self/status"):
        if line.startswith(key + ":"):
            return line.split()[1]
gateways = []
try:
    for line in open("/proc/net/route").read().splitlines()[1:]:
        gateways.append(line.split()[0])
except OSError:
    pass
try:
    open("/rootfs-write-probe", "w").close()
    root_write = "written"
except OSError as exc:
    root_write = errno.errorcode.get(exc.errno, "error")
out = {
    "interfaces": sorted(os.listdir("/sys/class/net")),
    "routes": gateways,
    "external": connect("1.1.1.1", 53),
    "gateway_db_port": connect("172.17.0.1", 5432),
    "socket_present": [p for p in ("/var/run/docker.sock", "/run/docker.sock")
                       if os.path.exists(p)],
    "root_write": root_write,
    "cap_eff": status("CapEff"),
    "cap_bnd": status("CapBnd"),
    "no_new_privs": status("NoNewPrivs"),
    "uid": os.getuid(),
    "gid": os.getgid(),
}
json.dump(out, open("/outputs/probe.json", "w"))
"""


@unittest.skipUnless(
    os.environ.get("SPECMATE_RUNNER_TEST_IMAGE"),
    "Requires an explicitly supplied cached digest image",
)
class DockerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = Mock()
        self.client.heartbeat.return_value = {"cancellation_requested": False}
        self.client.reconcile.return_value = {"cancellation_requested": False}
        self.docker = Docker(user=f"{os.getuid()}:{os.getgid()}")
        self.runner = Runner(
            self.client, self.docker, self.temp.name, self.temp.name, poll_seconds=0.05
        )
        self.image = os.environ["SPECMATE_RUNNER_TEST_IMAGE"]
        self.owned = []
        self.addCleanup(self.cleanup_containers)

    def cleanup_containers(self):
        for receipt in self.owned:
            self.docker.stop(receipt["name"], receipt["identity"])
            self.docker.remove(receipt["name"], receipt["identity"])

    def prepare(self, argv):
        lease = manifest(self.image, argv)
        lease["stage_id"] = str(uuid.uuid4())
        receipt = self.runner.prepare(lease)
        self.owned.append(receipt)
        return receipt

    def test_actual_container_success_and_verified_output(self):
        receipt = self.prepare(
            ["/bin/sh", "-c", "printf synthetic > /outputs/result.txt"]
        )
        receipt["lease"]["recipe"]["outputs"] = [
            {"path": "result.txt", "media_type": "text/plain", "rights": "CC0-1.0"}
        ]
        self.runner.run_receipt(receipt, recovered=False)
        self.assertEqual(receipt["result"]["outcome"], "succeeded")
        self.assertEqual(
            receipt["artifacts"][0]["sha256"], hashlib.sha256(b"synthetic").hexdigest()
        )
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))

    def test_tool_stage_isolation_observed_from_inside_container(self):
        # Needs python3 in the supplied image (the cached KiCad image has it).
        receipt = self.prepare(["/usr/bin/python3", "-I", "-c", PROBE_SCRIPT])
        receipt["lease"]["recipe"]["outputs"] = [
            {
                "path": "probe.json",
                "media_type": "application/json",
                "rights": "CC0-1.0",
            }
        ]
        self.runner.run_receipt(receipt, recovered=False)
        self.assertEqual(receipt["result"]["outcome"], "succeeded")
        out = json.loads(
            (
                Path(self.temp.name) / receipt["identity"] / "outputs" / "probe.json"
            ).read_text()
        )
        self.assertEqual(out["interfaces"], ["lo"])
        self.assertEqual(out["routes"], [])
        self.assertNotEqual(out["external"], "connected")
        self.assertNotEqual(out["gateway_db_port"], "connected")
        self.assertEqual(out["socket_present"], [])
        self.assertEqual(out["root_write"], "EROFS")
        self.assertEqual(int(out["cap_eff"], 16), 0)
        self.assertEqual(int(out["cap_bnd"], 16), 0)
        self.assertEqual(out["no_new_privs"], "1")
        self.assertEqual((out["uid"], out["gid"]), (os.getuid(), os.getgid()))
        self.assertNotEqual(out["uid"], 0)

    def test_cancel_running_container_with_descendant(self):
        receipt = self.prepare(["/bin/sh", "-c", "sleep 60 & wait"])
        self.client.heartbeat.side_effect = [
            {"cancellation_requested": False},
            {"cancellation_requested": True},
        ]
        self.runner.run_receipt(receipt, recovered=False)
        self.assertEqual(receipt["result"]["outcome"], "cancelled")
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))

    def test_timeout_stops_actual_container(self):
        receipt = self.prepare(["/bin/sleep", "60"])
        receipt["lease"]["recipe"]["limits"]["timeout_seconds"] = 1
        self.runner.run_receipt(receipt, recovered=False)
        self.assertEqual(receipt["result"]["outcome"], "failed")
        self.assertIn("timeout", receipt["result"]["message"])
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))

    def test_restart_reconciles_existing_container_and_stops_stale_work(self):
        receipt = self.prepare(["/bin/sleep", "60"])
        self.runner.stage_inputs(receipt)
        directory = Path(self.temp.name) / receipt["identity"]
        self.docker.create(
            receipt["name"],
            receipt["identity"],
            receipt["lease"]["recipe"],
            directory / "inputs",
            directory / "outputs",
        )
        self.docker.start(receipt["name"])
        self.client.reconcile.side_effect = Rejected("fenced")
        restarted = Runner(self.client, self.docker, self.temp.name, self.temp.name)
        restarted.tick()
        # Stopped, then removed like after an accepted receipt; nothing is submitted.
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))
        self.client.complete.assert_not_called()

    def test_lost_success_ack_replays_receipt_after_one_actual_execution(self):
        receipt = self.prepare(
            ["/bin/sh", "-c", "printf synthetic > /outputs/result.txt"]
        )
        receipt["lease"]["recipe"]["outputs"] = [
            {"path": "result.txt", "media_type": "text/plain", "rights": "CC0-1.0"}
        ]
        self.docker.create = Mock(wraps=self.docker.create)
        self.docker.start = Mock(wraps=self.docker.start)
        # The control-plane acknowledgment is deliberately lost after the real
        # container has exited and the controller persisted its output receipt.
        self.client.complete.side_effect = [Unavailable("lost acknowledgment"), {}]
        with self.assertRaises(Unavailable):
            self.runner.run_receipt(receipt, recovered=False)
        self.assertFalse(
            self.docker.inspect(receipt["name"], receipt["identity"])["State"][
                "Running"
            ]
        )
        self.client.reconcile.return_value = {
            "state": "succeeded",
            "cancellation_requested": False,
        }
        restarted = Runner(self.client, self.docker, self.temp.name, self.temp.name)
        self.assertTrue(restarted.tick())
        self.docker.create.assert_called_once()
        self.docker.start.assert_called_once()
        self.client.upload.assert_called_once()
        self.assertEqual(self.client.complete.call_count, 2)
        self.assertEqual(
            self.client.complete.call_args_list[0],
            self.client.complete.call_args_list[1],
        )
        self.assertEqual(
            self.client.complete.call_args.args[1]["outputs"][0]["sha256"],
            hashlib.sha256(b"synthetic").hexdigest(),
        )
        persisted = json.loads(
            (Path(self.temp.name) / receipt["identity"] / "receipt.json").read_text()
        )
        self.assertEqual(persisted["phase"], "accepted")
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))

    def test_restart_resumes_running_container_without_another_execution(self):
        receipt = self.prepare(["/bin/sleep", "2"])
        self.runner.stage_inputs(receipt)
        directory = Path(self.temp.name) / receipt["identity"]
        self.docker.create = Mock(wraps=self.docker.create)
        self.docker.start = Mock(wraps=self.docker.start)
        self.docker.create(
            receipt["name"],
            receipt["identity"],
            receipt["lease"]["recipe"],
            directory / "inputs",
            directory / "outputs",
        )
        receipt["started_at"] = time.time()
        receipt["phase"] = "running"
        self.runner.save(receipt)
        self.docker.start(receipt["name"])
        self.assertTrue(
            self.docker.inspect(receipt["name"], receipt["identity"])["State"][
                "Running"
            ]
        )
        restarted = Runner(
            self.client, self.docker, self.temp.name, self.temp.name, poll_seconds=0.05
        )
        self.assertTrue(restarted.tick())
        self.client.reconcile.assert_called_once()
        self.docker.create.assert_called_once()
        self.docker.start.assert_called_once()
        self.assertEqual(self.client.complete.call_args.args[1]["outcome"], "succeeded")
        self.assertIsNone(self.docker.inspect(receipt["name"], receipt["identity"]))


if __name__ == "__main__":
    unittest.main()
