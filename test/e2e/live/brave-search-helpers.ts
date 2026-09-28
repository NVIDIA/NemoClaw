// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Launch the real agent and inspect its owned child after the wrapper execs
// Node. Cross-tree gateway environ reads are blocked by Yama; the original
// #7425 regression observes this agent child and a fresh login shell.
export const BRAVE_AGENT_BOUNDARY = String.raw`
import os, pathlib, signal, subprocess, sys, time

def inspect(process):
    try:
        argv = process.joinpath("cmdline").read_bytes().split(b"\0")
        executable = pathlib.Path(argv[0].decode(errors="replace")).name
        agent = executable in ("node", "openclaw", "openclaw.real") and (
            any(b"openclaw" in arg for arg in argv) and b"agent" in argv)
        if not agent:
            return 97
        entries = process.joinpath("environ").read_bytes().split(b"\0")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return 97
    values = [entry.split(b"=", 1)[1] for entry in entries if entry.startswith(b"BRAVE_API_KEY=")]
    return 98 if any(value and not value.startswith(b"openshell:resolve:env:") for value in values) else 0

if len(sys.argv) > 1 and sys.argv[1] == "--inspect-process":
    status = inspect(pathlib.Path(sys.argv[2]))
else:
    command = sys.argv[1:] or ["sh", "-lc", "exec openclaw agent --agent main --json --session-id e2e-brave-isolation -m 'Reply with READY. Do not use tools.'"]
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    status = 97
    try:
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            status = inspect(pathlib.Path("/proc") / str(child.pid))
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
sys.exit(status)
`;

export const BRAVE_SHELL_BOUNDARY = String.raw`
value="$(printenv BRAVE_API_KEY 2>/dev/null || true)"
case "$value" in
  ''|openshell:resolve:env:*) exit 0 ;;
  *) exit 98 ;;
esac
`;
