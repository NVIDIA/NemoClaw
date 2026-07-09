// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

describe("installer express install prompt (sourced)", () => {
  function runExpressPromptWithTty(
    answer: string,
    stdinMode: "pipe" | "tty",
    platform = "DGX Spark",
    extraEnv: Record<string, string> = {},
  ) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-prompt-"));
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
answer = sys.argv[2].encode()
stdin_mode = sys.argv[3]
platform = sys.argv[4]
script = r'''
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "$EXPRESS_PLATFORM"; }
NON_INTERACTIVE=""
NEMOCLAW_PROVIDER=""
NEMOCLAW_NO_EXPRESS=""
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
'''
env = dict(os.environ)
env["INSTALLER_UNDER_TEST"] = installer
env["EXPRESS_PLATFORM"] = platform
pid, fd = pty.fork()
if pid == 0:
    if stdin_mode == "pipe":
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.close(devnull)
    os.execvpe("bash", ["bash", "-c", script], env)

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
            os.write(fd, answer)
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
    return spawnSync(python, ["-c", ptyRunner, INSTALLER_PAYLOAD, answer, stdinMode, platform], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      env: {
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
        ...extraEnv,
      },
    });
  }

  it("offers express install when curl-piped stdin still has a controlling TTY", () => {
    const result = runExpressPromptWithTty("y\n", "pipe");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(
      /Express install will configure managed local vLLM using the DGX Spark profile default model/,
    );
    expect(output).toMatch(
      /Managed vLLM pulls the configured vLLM image\/model and runs a local vLLM inference container/,
    );
    expect(output).toMatch(/Sandbox name: my-assistant/);
    expect(output).toMatch(/Sandbox policy: suggested mode, tier 'balanced'/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for DGX Spark/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("preserves a preset Spark vLLM model in the prompt and exported env", () => {
    const result = runExpressPromptWithTty("y\n", "pipe", "DGX Spark", {
      NEMOCLAW_VLLM_MODEL: "custom-qwen3.6",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(
      /Express install will configure managed local vLLM with model custom-qwen3\.6/,
    );
    expect(output).toMatch(
      /Managed vLLM pulls the configured vLLM image\/model and runs a local vLLM inference container/,
    );
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL=custom-qwen3\.6 POLICY=suggested YES=1 SANDBOX=my-assistant/,
    );
  });

  it("preserves an explicit NEMOCLAW_SANDBOX_NAME over the DGX Spark default (#6525)", () => {
    const result = runExpressPromptWithTty("y\n", "pipe", "DGX Spark", {
      NEMOCLAW_SANDBOX_NAME: "custom-spark",
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected DGX Spark/);
    expect(output).toMatch(/Sandbox name: custom-spark/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=custom-spark/,
    );
  });

  it("detects Windows WSL as an express install platform", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform
`,
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-wsl-detect-")),
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          WSL_DISTRO_NAME: "Ubuntu",
        },
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("Windows WSL");
  });

  it("maps Windows WSL express install to Windows-host Ollama", () => {
    const result = runExpressPromptWithTty("\n", "pipe", "Windows WSL");
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected Windows WSL/);
    expect(output).toMatch(
      /Express install will configure Windows-host Ollama through host\.docker\.internal/,
    );
    expect(output).toMatch(/Sandbox policy: suggested mode, tier 'balanced'/);
    expect(output).toMatch(/Run express install/);
    expect(output).toMatch(/Using express install for Windows WSL/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-windows-ollama MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=/,
    );
  });

  it.skipIf(process.platform === "darwin")(
    "skips express install without a controlling TTY",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-no-tty-"));
      const result = spawnSync(
        "setsid",
        [
          "bash",
          "-c",
          `
source "$INSTALLER_UNDER_TEST" >/dev/null
detect_express_platform() { printf "DGX Spark"; }
NON_INTERACTIVE=""
NEMOCLAW_PROVIDER=""
NEMOCLAW_NO_EXPRESS=""
maybe_offer_express_install
printf "RESULT NON_INTERACTIVE=%s SUDO_MODE=%s PROVIDER=%s MODEL=%s VLLM_MODEL=%s POLICY=%s YES=%s SANDBOX=%s\\n" \\
  "\${NON_INTERACTIVE:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}" \\
  "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" "\${NEMOCLAW_YES:-}" "\${NEMOCLAW_SANDBOX_NAME:-}"
`,
        ],
        {
          cwd: tmp,
          encoding: "utf-8",
          input: "",
          env: {
            HOME: tmp,
            PATH: TEST_SYSTEM_PATH,
            INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toMatch(/Detected DGX Spark/);
      expect(output).toMatch(/Skipping express prompt \(no TTY\)/);
      expect(output).not.toMatch(/Run express install/);
      expect(output).toMatch(
        /RESULT NON_INTERACTIVE= SUDO_MODE= PROVIDER= MODEL= VLLM_MODEL= POLICY= YES= SANDBOX=/,
      );
    },
  );
});
