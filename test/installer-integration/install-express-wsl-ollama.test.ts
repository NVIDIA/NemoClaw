// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

describe("installer Windows WSL express inference delegation", () => {
  const runInstallerSourced = (body: string) => {
    const run = runInstallerSourcedBody(body, {
      homePrefix: "nemoclaw-express-wsl-sourced-",
    });
    onTestFinished(run.remove);
    return run;
  };

  function runWslExpressPrompt() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-wsl-prompt-"));
    const python =
      spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v python3"], {
        encoding: "utf-8",
      }).stdout.trim() || "python3";
    const ptyRunner = `
import os
import pty
import select
import signal
import sys
import time

installer = sys.argv[1]
script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "Windows WSL"; }
NON_INTERACTIVE="\${NON_INTERACTIVE:-}"
NEMOCLAW_PROVIDER="\${NEMOCLAW_PROVIDER:-}"
NEMOCLAW_NO_EXPRESS="\${NEMOCLAW_NO_EXPRESS:-}"
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
pid, fd = pty.fork()
if pid == 0:
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script, "nemoclaw-express-wsl-prompt"], env)

output = bytearray()
os.set_blocking(fd, False)
sent = False
exit_code = 124
deadline = time.time() + 10
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            chunk = b""
        except OSError:
            chunk = b""
        if chunk:
            output.extend(chunk)
        if (not sent) and b"[Y/n]" in output:
            os.write(fd, b"\\n")
            sent = True
    waited = os.waitpid(pid, os.WNOHANG)
    if waited[0] == pid:
        exit_code = os.waitstatus_to_exitcode(waited[1])
        break
    if time.time() > deadline:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        break

try:
    os.close(fd)
except OSError:
    pass
sys.stdout.buffer.write(output)
sys.exit(exit_code)
`;
    return spawnSync(python, ["-c", ptyRunner, INSTALLER_PAYLOAD], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: {
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
      },
    });
  }

  it("leaves Windows WSL Express inference selection to onboarding (#10962)", () => {
    const result = runWslExpressPrompt();
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected Windows WSL/);
    expect(output).toMatch(/automatic local inference for the detected WSL hardware/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for Windows WSL/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER= MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=/,
    );
  });

  it("does not set a Windows WSL provider or recipe in the installer (#10962)", () => {
    const { result, output } = runInstallerSourced(
      `activate_express_install "Windows WSL"\n` +
        `printf 'PROVIDER=%s RECIPE=%s\\n' "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_LLAMACPP_RECIPE:-}"\n`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("PROVIDER= RECIPE=");
  });
});
