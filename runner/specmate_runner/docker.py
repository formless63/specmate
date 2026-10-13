"""Docker CLI calls use fixed options and argument vectors, never host shell evaluation."""

import json
import subprocess


class RuntimeFailure(Exception):
    pass


class ToolUnavailable(RuntimeFailure):
    pass


class Docker:
    def __init__(self, user="65532:65532", executable="docker"):
        ids = user.split(":")
        if len(ids) != 2 or not all(
            value.isdecimal() and int(value) > 0 for value in ids
        ):
            raise ValueError("Tool UID and GID must be nonroot numeric IDs")
        self.user = user
        self.executable = executable

    def command(self, args, *, absent_ok=False):
        try:
            result = subprocess.run(
                [self.executable, *args],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeFailure("Container runtime unavailable") from exc
        if result.returncode:
            if "No such image:" in result.stderr:
                raise ToolUnavailable("Approved image is not cached on this runner")
            if absent_ok and (
                "No such object:" in result.stderr
                or "No such container:" in result.stderr
            ):
                return None
            raise RuntimeFailure("Container runtime operation failed")
        return result.stdout

    @staticmethod
    def labels(identity):
        return {"org.specmate.runner": "native-v1", "org.specmate.execution": identity}

    def inspect(self, name, identity):
        raw = self.command(["inspect", "--type", "container", name], absent_ok=True)
        if raw is None:
            return None
        result = json.loads(raw)[0]
        labels = result["Config"].get("Labels") or {}
        if any(
            labels.get(key) != value for key, value in self.labels(identity).items()
        ):
            raise RuntimeFailure(
                "Container identity does not match the durable receipt"
            )
        return result

    def create(self, name, identity, recipe, inputs, outputs):
        limits = recipe["limits"]
        args = [
            "create",
            "--name",
            name,
            "--pull=never",
            "--restart=no",
            "--init",
            "--read-only",
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--user",
            self.user,
            "--cpus",
            str(limits["cpus"]),
            "--memory",
            str(limits["memory_bytes"]),
            "--memory-swap",
            str(limits["memory_bytes"]),
            "--pids-limit",
            str(limits["pids"]),
            "--log-driver=none",
            "--ulimit",
            f"fsize={limits['max_output_bytes']}:{limits['max_output_bytes']}",
            "--ulimit",
            "nofile=256:256",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=67108864",
            "--workdir",
            "/outputs",
            "--mount",
            f"type=bind,src={inputs},dst=/inputs,readonly",
            "--mount",
            f"type=bind,src={outputs},dst=/outputs",
            "--entrypoint",
            recipe["argv"][0],
        ]
        for key, value in self.labels(identity).items():
            args.extend(["--label", f"{key}={value}"])
        args.extend([recipe["image"], *recipe["argv"][1:]])
        return self.command(args).strip()

    def start(self, name):
        self.command(["start", name])

    def stop(self, name, identity):
        container = self.inspect(name, identity)
        if container is None:
            return None
        if container["State"]["Running"]:
            self.command(["stop", "--time", "2", name])
        container = self.inspect(name, identity)
        if container and container["State"]["Running"]:
            self.command(["kill", name])
            container = self.inspect(name, identity)
        if container and container["State"]["Running"]:
            raise RuntimeFailure("Container termination was not confirmed")
        return container

    def remove(self, name, identity):
        container = self.inspect(name, identity)
        if container and container["State"]["Running"]:
            raise RuntimeFailure("Refusing to remove a running container")
        if container:
            self.command(["rm", name])
