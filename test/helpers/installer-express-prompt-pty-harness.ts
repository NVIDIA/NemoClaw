// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./installer-sourced-env";

export type InstallerExpressPtyFixture =
  | {
      mode: "post-exit-tail";
      pidFile: string;
      timeoutSeconds?: number;
    }
  | {
      mode: "timeout";
      timeoutSeconds?: number;
    };

const DEFAULT_INSTALLER_EXPRESS_PTY_HARNESS_MODE: "installer" = "installer";

export function runExpressPromptWithTty(
  answer: string,
  stdinMode: "pipe" | "tty",
  platform = "DGX Spark",
  extraEnv: Record<string, string> = {},
  entrypoint: "prompt" | "accepted-station-main" = "prompt",
  entrypointArgs: string[] = [],
  harnessFixture?: InstallerExpressPtyFixture,
) {
  const python =
    spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
      encoding: "utf-8",
    }).stdout.trim() || "python3";
  const ptyRunner = `
import errno
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
answer = sys.argv[2].encode()
stdin_mode = sys.argv[3]
platform = sys.argv[4]
entrypoint = sys.argv[5]
harness_mode = sys.argv[6]
timeout_seconds = float(sys.argv[7])
pid_file = sys.argv[8]
entrypoint_args = sys.argv[9:]
if entrypoint == "accepted-station-main":
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
print_banner() { :; }
ensure_docker() { :; }
ensure_openshell_build_deps() { :; }
# Stop immediately after the real Station express prompt configures its recipe,
# before setup-jetson.sh or any installation side effect can run.
classify_dgx_station_release() { printf "%s" "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
bash() {
  printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s\\n" \
    "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \
    "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \
    "\${NEMOCLAW_STATION_EXPRESS:-}"
  exit 0
}
main "$@"
'''
else:
    script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
classify_dgx_station_release() { printf "%s" "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
NON_INTERACTIVE="\${NON_INTERACTIVE:-}"
NEMOCLAW_PROVIDER="\${NEMOCLAW_PROVIDER:-}"
NEMOCLAW_NO_EXPRESS="\${NEMOCLAW_NO_EXPRESS:-}"
if [ "\${FORCE_EXPRESS_PROMPT_READ_FAILURE:-}" = "1" ]; then
  read() { return 1; }
fi
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s STATION_EXPRESS=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}" \\
  "\${NEMOCLAW_STATION_EXPRESS:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
env["EXPRESS_PLATFORM"] = platform
pid, fd = pty.fork()
if pid == 0:
    if harness_mode == "post-exit-tail":
        os.write(1, b"PTY_POST_EXIT_TAIL\\n")
        with open(pid_file, "w", encoding="utf-8") as marker:
            marker.write(str(os.getpid()))
        os._exit(0)
    if harness_mode == "timeout":
        os.write(1, b"PTY_TIMEOUT_STARTED\\n")
        while True:
            signal.pause()
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script, "nemoclaw-express-prompt", *entrypoint_args], env)

output = bytearray()
os.set_blocking(fd, False)
sent = False
exit_code = 124
deadline = time.monotonic() + timeout_seconds
pty_closed = False
# Leave unread PTY bytes after the first read so this fixture exercises the post-exit drain.
read_size = 1 if harness_mode == "post-exit-tail" else 4096

if harness_mode == "post-exit-tail":
    while not os.path.exists(pid_file):
        if time.monotonic() > deadline:
            raise TimeoutError("PTY tail fixture did not start")
        time.sleep(0.01)
    time.sleep(0.05)

def read_output():
    try:
        chunk = os.read(fd, read_size)
    except BlockingIOError:
        return False
    except OSError as error:
        if error.errno == errno.EIO:
            return True
        raise
    if not chunk:
        return True
    output.extend(chunk)
    return False

while True:
    if not pty_closed:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            pty_closed = read_output()
        if (not sent) and b"[Y/n]" in output:
            os.write(fd, answer)
            sent = True
    if pty_closed:
        waited = os.waitpid(pid, os.WNOHANG)
        if waited[0] == pid:
            exit_code = os.waitstatus_to_exitcode(waited[1])
            break
        time.sleep(0.01)
    if time.monotonic() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        drain_deadline = time.monotonic() + 1.0
        while not pty_closed and time.monotonic() < drain_deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                pty_closed = read_output()
        waited_pid, _ = os.waitpid(pid, 0)
        if waited_pid == pid:
            output.extend(b"PTY_CHILD_REAPED\\n")
        break

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
  const harnessMode: InstallerExpressPtyFixture["mode"] | "installer" =
    harnessFixture?.mode ?? DEFAULT_INSTALLER_EXPRESS_PTY_HARNESS_MODE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-prompt-"));
  try {
    const result = spawnSync(
      python,
      [
        "-c",
        ptyRunner,
        INSTALLER_PAYLOAD,
        answer,
        stdinMode,
        platform,
        entrypoint,
        harnessMode,
        String(harnessFixture?.timeoutSeconds ?? 10),
        harnessFixture?.mode === "post-exit-tail" ? harnessFixture.pidFile : "",
        ...entrypointArgs,
      ],
      {
        cwd: tmp,
        encoding: "utf-8",
        timeout: 15_000,
        killSignal: "SIGKILL",
        env: {
          HOME: tmp,
          PATH: TEST_SYSTEM_PATH,
          ...extraEnv,
        },
      },
    );
    return Object.assign(result, { temporaryDirectory: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
