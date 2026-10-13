import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from specmate_runner.protocol import Client, NoRedirect, Rejected, Unavailable
from specmate_runner.validation import Invalid


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.client = Client("http://app.example", "scoped-test-token")
        self.client.opener = Mock()
        self.lease = {"stage_id": "stage-1", "fencing_token": "fence-1"}

    def test_claim_scope_and_envelope(self):
        self.client.opener.open.return_value = Response(b'{"result":{"lease":null}}')
        self.assertIsNone(self.client.claim())
        request = self.client.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://app.example/api/v0/runner/leases")
        self.assertEqual(request.headers["Authorization"], "Bearer scoped-test-token")
        self.assertEqual(set(json.loads(request.data)), {"request_id"})

    def test_redirects_never_forward_runner_credential(self):
        with self.assertRaises(Rejected):
            NoRedirect().redirect_request(
                None, None, 302, "redirect", {}, "https://other.example"
            )

    def test_input_size_is_exact_and_fenced(self):
        for content in (b"short", b"excess-bytes"):
            with (
                self.subTest(content=content),
                tempfile.TemporaryDirectory() as directory,
            ):
                self.client.opener.open.return_value = Response(content)
                with self.assertRaises(Invalid):
                    self.client.download(
                        self.lease,
                        {"bytes": 8, "sha256": hashlib.sha256(content).hexdigest()},
                        Path(directory) / "input",
                    )
                request = self.client.opener.open.call_args.args[0]
                self.assertIn("fencing_token=fence-1", request.full_url)
                self.assertIn("/stages/stage-1/inputs/", request.full_url)

    def test_malformed_control_is_refused_instead_of_guessing_liveness(self):
        for content in (
            b'{"result":null}',
            b'{"result":{}}',
            b'{"result":{"cancellation_requested":"false"}}',
        ):
            with self.subTest(content=content):
                self.client.opener.open.return_value = Response(content)
                with self.assertRaises(Rejected):
                    self.client.heartbeat(self.lease)

    def test_interrupted_response_becomes_recoverable_unavailability(self):
        response = Mock()
        response.read.side_effect = TimeoutError()
        with self.assertRaises(Unavailable):
            self.client.read(response, 1024)
