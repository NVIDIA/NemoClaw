#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Replay the built-in partial-template onboarding flow in a watchable tmux pane."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import shlex
import struct
import subprocess
import sys
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[3]
BINARY = ROOT / "target/debug/nemoclaw-onboarding"
NAME = "onboarding-e2e-demo"
QUESTIONS = [
    ("Welcome to NemoClaw", "Enter"),
    ("Choose your agent harness", "Enter"),
    ("How should your agent reach its model?", "Enter"),
    ("Which inference API should the harness speak?", "Enter"),
    ("Where should the sandbox run?", "Enter"),
    ("Name this deployment", NAME),
    ("Choose the model", "Enter"),
    ("/agent_name", "Enter"),
    ("/cli", "Enter"),
    ("/home", "Enter"),
    ("/native_config", "Enter"),
    ("/timeout_seconds", "Enter"),
    ("/settings/api", "Enter"),
    ("/settings/model_metadata", "Enter"),
    ("/settings/reasoning_effort", "Enter"),
    ("Gateway: endpoint", "Enter"),
    ("Gateway: engine", "Enter"),
    ("Gateway: image", "Enter"),
    ("Gateway: network CIDR", "Enter"),
    ("Agent: image / ref", "Enter"),
    ("Agent: network / tier", "Enter"),
    ("Enter  author YAML", "Enter"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new YAML path")
    parser.add_argument("--socket", type=Path, help="tmux socket path")
    parser.add_argument("--delay", type=float, default=1.5, help="seconds to show each question")
    parser.add_argument("--wait-for-viewer", action="store_true", help="wait for a read-only tmux client")
    parser.add_argument("--keep-session", action="store_true", help="leave tmux open after replay")
    args = parser.parse_args()
    output = args.output or Path(tempfile.gettempdir()) / f"nemoclaw-onboarding-replay-{os.getpid()}.yaml"
    socket = args.socket or Path(tempfile.gettempdir()) / f"nemoclaw-onboarding-replay-{os.getpid()}.sock"
    transcript = output.with_suffix(".jsonl")
    if not BINARY.is_file():
        parser.error(f"build the example first: cargo build -p nemoclaw-onboarding ({BINARY})")
    if output.exists() or transcript.exists() or socket.exists():
        parser.error("output, transcript, and socket paths must be new")

    def tmux(*arguments: str) -> str:
        command = ["tmux", "-S", str(socket), *arguments]
        result = subprocess.run(command, check=True, text=True, capture_output=True)
        return result.stdout

    session = "nemoclaw-guided-replay"
    tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "32", "-c", str(ROOT))
    tmux("set-window-option", "-t", session, "window-size", "manual")
    pane = tmux("list-panes", "-t", session, "-F", "#{pane_id}").strip()

    # A writable client lets send-keys work while another client watches with -r.
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
    controller_tty = os.ttyname(slave)
    environment = {**os.environ, "TERM": "xterm-256color"}
    controller = subprocess.Popen(
        ["tmux", "-S", str(socket), "attach-session", "-t", session],
        stdin=slave, stdout=slave, stderr=slave, env=environment,
    )
    os.close(slave)

    def send(key: str, literal: bool = False) -> None:
        options = ["send-keys", "-c", controller_tty, "-t", pane]
        if literal:
            options.append("-l")
        tmux(*options, key)

    def screen() -> str:
        return tmux("capture-pane", "-p", "-t", pane)

    def await_text(marker: str, timeout: float = 15) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = screen()
            if marker in current:
                return current
            time.sleep(0.1)
        raise RuntimeError(f"expected {marker!r}; current screen:\n{screen()}")

    try:
        command = shlex.join([str(BINARY), "--output", str(output)])
        send(command, literal=True)
        send("Enter")
        await_text(QUESTIONS[0][0])
        attach = shlex.join(["tmux", "-S", str(socket), "attach-session", "-r", "-t", session])
        print(f"Watch in another terminal: {attach}", flush=True)
        if args.wait_for_viewer:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                clients = tmux("list-clients", "-F", "#{client_readonly}").splitlines()
                if "1" in clients:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("no read-only viewer attached within two minutes")

        with transcript.open("w") as log:
            for number, (marker, answer) in enumerate(QUESTIONS, 1):
                current = await_text(marker)
                if marker == "Enter  author YAML":
                    for expected in (f"Deployment: {NAME}", "Harness: nvidia.fabric.openclaw",
                                     "Runtime: Docker", "Set NVIDIA_API_KEY before applying."):
                        if expected not in current:
                            raise RuntimeError(f"review is missing {expected!r}")
                json.dump({"step": number, "expected": marker, "screen": current}, log)
                log.write("\n")
                print(f"{number:02}/{len(QUESTIONS)} {marker}", flush=True)
                time.sleep(args.delay)
                if answer == NAME:
                    send(NAME, literal=True)
                    await_text(NAME)
                send("Enter")

        # The shell may wrap a long output path across terminal rows.
        await_text("Authored desired state:")
        if not output.is_file():
            raise RuntimeError(f"onboarding reported a save but did not create {output}")
        yaml = output.read_text()
        for pattern in (
            rf"(?m)^  name: {NAME}$",
            r"(?m)^      kind: nvidia\.fabric\.openclaw$",
            r"(?m)^      provider: docker$",
            r"(?m)^    api: openai-completions$",
            r"(?m)^    endpoint: https://integrate\.api\.nvidia\.com/v1$",
            r"(?m)^    engine: unix:///var/run/docker\.sock$",
            r"(?m)^      tier: isolated$",
            r"(?m)^            model: nvidia/nemotron-3-super-120b-a12b$",
            r"(?m)^      env: NVIDIA_API_KEY$",
        ):
            if not re.search(pattern, yaml):
                raise RuntimeError(f"saved YAML is missing {pattern!r}")
        print(f"Saved and checked: {output}\nScreen transcript: {transcript}", flush=True)
        return 0
    finally:
        controller.terminate()
        controller.wait(timeout=5)
        os.close(master)
        if not args.keep_session:
            tmux("kill-session", "-t", session)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"replay failed: {error}", file=sys.stderr)
        sys.exit(1)
