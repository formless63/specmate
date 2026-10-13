import json
import os
import signal
import time
from pathlib import Path

from .docker import Docker, RuntimeFailure
from .protocol import Client, Rejected, Unavailable
from .runner import Runner
from .validation import Invalid


def main():
    token_file = os.environ.get("SPECMATE_RUNNER_TOKEN_FILE")
    token = (
        Path(token_file).read_text().strip()
        if token_file
        else os.environ.get("SPECMATE_RUNNER_TOKEN", "")
    )
    runner = Runner(
        Client(os.environ["SPECMATE_APP_URL"], token),
        Docker(user=os.environ.get("SPECMATE_TOOL_USER", "65532:65532")),
        os.environ.get("SPECMATE_RUNNER_STATE_DIR", "/runner-state"),
        os.environ["SPECMATE_RUNNER_HOST_STATE_DIR"],
    )

    def stop(signum, frame):
        runner.stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with runner.lock():
        while not runner.stopping:
            try:
                if not runner.tick():
                    time.sleep(2)
            except (Unavailable, RuntimeFailure, Rejected, Invalid, OSError) as exc:
                # Neither bearer credentials nor source bytes appear in diagnostics.
                print(
                    json.dumps(
                        {"event": "runner.unavailable", "reason": type(exc).__name__}
                    ),
                    flush=True,
                )
                time.sleep(2)


if __name__ == "__main__":
    main()
