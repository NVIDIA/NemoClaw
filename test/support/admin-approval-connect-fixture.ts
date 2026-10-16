// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, rmSync } from "node:fs";

export function removeStagedAdminScript(receipt: string): void {
  if (!existsSync(receipt)) return;
  const script = readFileSync(receipt, "utf8");
  if (/^\/tmp\/nemoclaw-admin-approval-[a-zA-Z0-9_]+[.]sh$/.test(script)) {
    rmSync(script, { force: true });
  }
}

export const ADMIN_APPROVAL_TEST_CLI_SH = `#!/bin/sh
set -eu
case "$2" in
  exec)
    shift 2
    if [ "$1" = --stdin ]; then shift; fi
    [ "$1" = -- ]
    shift
    exec "$@"
    ;;
  connect)
    if [ -n "\${ADMIN_CONNECT_TERMINAL_PROBE:-}" ]; then
      exec python3 "$ADMIN_CONNECT_TERMINAL_PROBE"
    fi
    exec /bin/bash -c 'openclaw() { command openclaw "$@"; }; if [ -n "\${ADMIN_CONNECT_RC:-}" ]; then . "$ADMIN_CONNECT_RC"; fi; . /dev/stdin'
    ;;
  *) exit 93 ;;
esac
`;

export const ADMIN_APPROVAL_TEST_OPENSHELL_SH = `#!/bin/sh
set -eu
if [ -n "\${FAKE_OPENSHELL_ARGV_LOG:-}" ]; then
  : >"$FAKE_OPENSHELL_ARGV_LOG"
  for arg in "$@"; do printf '%s\\n' "$arg" >>"$FAKE_OPENSHELL_ARGV_LOG"; done
fi
[ "$1" = sandbox ]
[ "$2" = exec ]
shift 2
while [ "$1" != -- ]; do shift; done
shift
[ "$1" = /bin/bash ]
[ "$2" = -i ]
approval_program="$(cat)"
case "$approval_program" in
  *'
'*) echo "ADMIN_CONNECT_INPUT_NOT_SINGLE_LINE" >&2; exit 96 ;;
esac
if [ -n "\${ADMIN_CONNECT_TERMINAL_PROBE:-}" ]; then
  printf '%s\n' "$approval_program" | python3 "$ADMIN_CONNECT_TERMINAL_PROBE"
  exit $?
fi
printf '%s\n' "$approval_program" | /bin/bash -c 'openclaw() { command openclaw "$@"; }; if [ -n "\${ADMIN_CONNECT_RC:-}" ]; then . "$ADMIN_CONNECT_RC"; fi; . /dev/stdin'
`;

export const ADMIN_APPROVAL_TEST_PTY_PY = `
"""Run the fixture's connect input through a real interactive shell terminal."""

import os
import pty
import re
import select
import sys
import time
from pathlib import Path

payload = sys.stdin.buffer.read()
if os.environ.get("ADMIN_TAMPER_SCRIPT") == "1":
    script = re.search(rb"/tmp/nemoclaw-admin-approval-[a-zA-Z0-9_]+[.]sh", payload)
    if script is None:
        raise SystemExit("staged script path missing")
    Path(os.fsdecode(script.group())).write_text("echo ADMIN_TAMPER_EXECUTED", encoding="utf-8")
pid, master = pty.fork()
if pid == 0:
    os.execve(
        "/bin/bash",
        ["bash", "--noprofile", "--rcfile", os.environ["ADMIN_CONNECT_RC"], "-i"],
        {**os.environ, "PS1": "", "PS2": ""},
    )
os.set_blocking(master, False)
offset = 0
deadline = time.monotonic() + 10
try:
    while time.monotonic() < deadline:
        readable, writable, _ = select.select(
            [master], [master] if offset < len(payload) else [], [], 0.05
        )
        if writable:
            try:
                offset += os.write(master, payload[offset : offset + 256])
            except BlockingIOError:
                pass
            except OSError:
                offset = len(payload)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
finally:
    ended, status = os.waitpid(pid, os.WNOHANG)
    if not ended:
        os.kill(pid, 9)
        _, status = os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
`;
