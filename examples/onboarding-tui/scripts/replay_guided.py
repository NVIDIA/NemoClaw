#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Replay the built-in or minimum-inline journey in a watchable tmux pane."""

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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new YAML path")
    parser.add_argument("--template", type=Path, help="optional desired-state template")
    parser.add_argument("--socket", type=Path, help="tmux socket path")
    parser.add_argument("--delay", type=float, default=1.5, help="seconds to show each question")
    parser.add_argument("--wait-for-viewer", action="store_true", help="wait for a read-only tmux client")
    parser.add_argument("--keep-session", action="store_true", help="leave tmux open after replay")
    args = parser.parse_args()
    minimum_inline = args.template is not None and args.template.resolve() == (
        ROOT / "crates/nemoclaw-authoring/tests/fixtures/minimum-inline.yaml"
    )
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

    def question_marker(current: str) -> str:
        return next((line.strip() for line in current.splitlines()
                     if "Required  ·" in line or "Optional  ·" in line),
                    "Review" if "Review desired state" in current else "Welcome")

    def await_text(marker: str, timeout: float = 15) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = screen()
            if marker in current:
                return current
            time.sleep(0.1)
        raise RuntimeError(f"expected {marker!r}; current screen:\n{screen()}")

    try:
        command = [str(BINARY), "--output", str(output)]
        if args.template:
            command.append(str(args.template.resolve()))
        command = shlex.join(command)
        send(command, literal=True)
        send("Enter")
        await_text("Create desired state")
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
            for number in range(1, 129):
                current = screen()
                marker = question_marker(current)
                json.dump({"step": number, "question": marker, "screen": current}, log)
                log.write("\n")
                print(f"{number:02} {marker}", flush=True)
                time.sleep(args.delay)
                answer = None
                if "/metadata/name" in current:
                    answer = NAME
                elif minimum_inline:
                    for field, value in {
                        "/spec/sandboxes/0/agent/inference/routes/0/name": "primary",
                        "/spec/sandboxes/0/name": "assistant",
                        "/spec/sandboxes/0/agent/name": "primary",
                    }.items():
                        if field in current:
                            answer = value
                            break
                    if "/spec/sandboxes/0/harness/kind" in current:
                        # The TUI shows the harness label; the saved YAML keeps its ID.
                        desired = "OpenClaw"
                        if desired not in current:
                            raise RuntimeError(f"harness choice {desired!r} is unavailable")
                        for _ in range(32):
                            if f"●  {desired}" in screen():
                                break
                            send("Down")
                            time.sleep(0.05)
                        else:
                            raise RuntimeError(f"could not select {desired!r}:\n{screen()}")
                if answer is not None:
                    send(answer, literal=True)
                    await_text(answer)
                send("Enter")
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if output.is_file() or question_marker(screen()) != marker:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError(f"question did not advance:\n{screen()}")
                if output.is_file():
                    break
            else:
                raise RuntimeError("journey exceeded 128 screens")

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
