"""Small HTTP client for the application's authenticated runner operations."""

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .validation import Invalid


class Rejected(Exception):
    """The application refused this runner's authority or request."""


class Unavailable(Exception):
    """The application did not acknowledge an operation."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Rejected("Runner API redirects are not allowed")


class Client:
    def __init__(self, base_url, token, timeout=15):
        url = urllib.parse.urlsplit(base_url)
        if (
            url.scheme not in {"http", "https"}
            or not url.netloc
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Invalid application URL")
        if not token or any(c.isspace() for c in token):
            raise ValueError("A runner bearer credential is required")
        self.base = base_url.rstrip("/") + "/api/v0/runner"
        self.token = token
        self.timeout = timeout
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )

    def _open(self, path, *, data=None, content_type="application/json"):
        req = urllib.request.Request(
            self.base + path,
            data=data,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": content_type,
            },
        )
        try:
            return self.opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                raise Rejected(f"Runner operation rejected ({exc.code})") from None
            raise Unavailable("Runner operation unavailable") from None
        except (OSError, urllib.error.URLError) as exc:
            raise Unavailable("Runner application unreachable") from exc

    @staticmethod
    def read(response, amount):
        try:
            return response.read(amount)
        except (OSError, http.client.HTTPException) as exc:
            raise Unavailable("Runner response interrupted") from exc

    def post(self, path, payload):
        body = {"request_id": str(uuid.uuid4()), **payload}
        with self._open(path, data=json.dumps(body).encode()) as response:
            raw = self.read(response, 1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise Rejected("Oversized runner response")
        return self.decode(raw)

    @staticmethod
    def decode(raw):
        try:
            result = json.loads(raw)["result"]
            if not isinstance(result, dict):
                raise TypeError("Result must be an object")
            return result
        except (ValueError, KeyError, TypeError) as exc:
            raise Rejected("Invalid runner response") from exc

    @staticmethod
    def control(result):
        if not isinstance(result.get("cancellation_requested"), bool):
            raise Rejected("Invalid runner control response")
        return result

    @staticmethod
    def stage_path(lease):
        return "/stages/" + urllib.parse.quote(lease["stage_id"], safe="")

    def claim(self):
        result = self.post("/leases", {})
        if "lease" not in result:
            raise Rejected("Invalid lease response")
        return result["lease"]

    def heartbeat(self, lease):
        return self.control(
            self.post(
                self.stage_path(lease) + "/heartbeat",
                {
                    "fencing_token": lease["fencing_token"],
                },
            )
        )

    def reconcile(self, lease, container_id, observed):
        return self.control(
            self.post(
                self.stage_path(lease) + "/reconcile",
                {
                    "fencing_token": lease["fencing_token"],
                    "container_id": container_id,
                    "observed": observed,
                },
            )
        )

    def download(self, lease, item, target):
        query = urllib.parse.urlencode({"fencing_token": lease["fencing_token"]})
        path = self.stage_path(lease) + "/inputs/" + item["sha256"] + "?" + query
        with self._open(path) as response, target.open("xb") as output:
            remaining = item["bytes"]
            while remaining:
                chunk = self.read(response, min(remaining, 1024 * 1024))
                if not chunk:
                    raise Invalid("Truncated input")
                output.write(chunk)
                remaining -= len(chunk)
            if self.read(response, 1):
                raise Invalid("Oversized input")

    def upload(self, lease, item, target):
        boundary = "specmate-" + uuid.uuid4().hex
        fields = {
            "request_id": str(uuid.uuid4()),
            "fencing_token": lease["fencing_token"],
            "path": item["path"],
            "sha256": item["sha256"],
            "size": item["bytes"],
            "media_type": item["media_type"],
            "rights": item["rights"],
            "source_revision_id": lease["source_revision_id"],
        }
        chunks = []
        for name, value in fields.items():
            chunks.append(
                (
                    f"--{boundary}\r\nContent-Disposition: form-data; "
                    f'name="{name}"\r\n\r\n{value}\r\n'
                ).encode()
            )
        chunks.append(
            (
                f"--{boundary}\r\nContent-Disposition: form-data; "
                'name="content"; filename="artifact"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        chunks.extend([target.read_bytes(), f"\r\n--{boundary}--\r\n".encode()])
        with self._open(
            self.stage_path(lease) + "/outputs",
            data=b"".join(chunks),
            content_type=f"multipart/form-data; boundary={boundary}",
        ) as response:
            raw = self.read(response, 1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise Rejected("Oversized output receipt")
        return self.decode(raw)

    def complete(self, lease, result):
        return self.post(
            self.stage_path(lease) + "/complete",
            {
                "fencing_token": lease["fencing_token"],
                **result,
            },
        )
