// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Inspect the gateway or an explicitly launched agent after its wrapper execs
// Node. Return only a status, and reap the owned agent process group afterward.
export const BRAVE_PROCESS_BOUNDARY = String.raw`
import os, pathlib, signal, subprocess, sys, time

def inspect(root, role, pid=None):
    processes = [root / str(pid)] if pid else root.glob("[0-9]*")
    observed = 0
    for process in processes:
        try:
            argv = process.joinpath("cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            continue
        executable = pathlib.Path(argv[0].decode(errors="replace")).name
        openclaw = (role == "gateway" and executable.startswith("openclaw-gateway")) or (
            executable in ("node", "openclaw", "openclaw.real") and
            any(b"openclaw" in arg for arg in argv) and role.encode() in argv)
        if not openclaw:
            continue
        observed += 1
        entries = process.joinpath("environ").read_bytes().split(b"\0")
        values = [entry.split(b"=", 1)[1] for entry in entries if entry.startswith(b"BRAVE_API_KEY=")]
        if any(value and not value.startswith(b"openshell:resolve:env:") for value in values):
            return 98
    return 0 if observed else 97

if len(sys.argv) > 1 and sys.argv[1] == "--launch-agent":
    command = sys.argv[2:] or ["sh", "-lc", "exec openclaw agent --agent main --json --session-id e2e-brave-isolation -m 'Reply with READY. Do not use tools.'"]
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    status = 97
    try:
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            status = inspect(pathlib.Path("/proc"), "agent", child.pid)
            if status != 97:
                break
            time.sleep(0.05)
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
else:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/proc")
    role = sys.argv[2] if len(sys.argv) > 2 else "gateway"
    pid = sys.argv[3] if len(sys.argv) > 3 else None
    status = inspect(root, role, pid)
sys.exit(status)
`;

export const BRAVE_SHELL_BOUNDARY = String.raw`
value="$(printenv BRAVE_API_KEY 2>/dev/null || true)"
case "$value" in
  ''|openshell:resolve:env:*) exit 0 ;;
  *) exit 98 ;;
esac
`;
