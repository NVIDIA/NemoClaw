// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt-cancellation package contracts:
 *
 * - #5976: `nemoclaw onboard ... < /dev/null` printed the provider menu, hit
 *   EOF on the first prompt read, and exited 0 silently instead of reporting
 *   cancellation.
 * - #7439: Ctrl+C at a hidden credential prompt printed resume guidance and
 *   then leaked the rejected prompt error as a raw Node.js stack trace.
 *
 * The tests use compiled artifacts (`dist/lib/...js`) to exercise the shipped
 * CLI path on the minimum supported Node.js runtime. They drive EOF through
 * `/dev/null` and SIGINT through both the prompt and installer TTY boundaries.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { spawnExitCode } from "../../../dist/lib/core/process-exit";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const COMMAND_PATH = path.join(REPO_ROOT, "dist", "lib", "onboard", "command.js");
const STORE_PATH = path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js");
const EXIT_HANDLER_PATH = path.join(REPO_ROOT, "dist", "lib", "onboard", "exit-step-failure.js");
const INSTALLER_PATH = path.join(REPO_ROOT, "scripts", "install.sh");

function promptInterruptDriver(fakeTty = false): string {
  return `
const { runOnboardCommand } = require(${JSON.stringify(COMMAND_PATH)});
const { prompt } = require(${JSON.stringify(STORE_PATH)});
const { registerIncompleteOnboardExitFailureHandler } = require(${JSON.stringify(EXIT_HANDLER_PATH)});
const session = { lastStepStarted: "inference" };
setInterval(() => {}, 1_000);
${fakeTty ? 'Object.defineProperty(process.stdin, "isTTY", { value: true });' : ""}
${fakeTty ? 'Object.defineProperty(process.stderr, "isTTY", { value: true });' : ""}
${fakeTty ? "process.stdin.setRawMode = () => process.stdin;" : ""}
registerIncompleteOnboardExitFailureHandler(
  {
    loadSession: () => session,
    finalizeIncompleteOnboardStep: () => session,
  },
  () => false,
  "Onboarding exited before the step completed.",
);
runOnboardCommand({
  flags: {},
  env: process.env,
  runOnboard: async () => {
    await prompt("  NVIDIA API Key: ", { secret: true });
  },
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
});
`;
}

describe("onboard prompt cancellation", () => {
  it("reports cancellation and exits non-zero when a prompt hits EOF", () => {
    const script = `
const { runOnboardCommand } = require(${JSON.stringify(COMMAND_PATH)});
const { prompt } = require(${JSON.stringify(STORE_PATH)});
runOnboardCommand({
  flags: {},
  env: process.env,
  // Stand in for the interactive provider menu: the first read hits EOF.
  runOnboard: async () => {
    await prompt("  Choose [1]: ");
  },
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
}).then(
  () => {
    console.error("UNEXPECTED_RESOLVE");
    process.exit(42);
  },
  (err) => {
    console.error("UNEXPECTED_REJECT", err && err.stack ? err.stack : String(err));
    process.exit(43);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      // stdin "ignore" maps to /dev/null, so the prompt's readline closes
      // before any answer — exactly the reporter's `< /dev/null` scenario.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Installation cancelled");
    expect(`${result.stdout}${result.stderr}`).not.toContain("UNEXPECTED_");
  });

  it.skipIf(process.platform === "win32")(
    "preserves SIGINT cancellation without a prompt stack trace (#7439)",
    async () => {
      const child = spawn(process.execPath, ["-e", promptInterruptDriver(true)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let promptReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        promptReady = resolve;
      });
      const collect = (chunk: Buffer): void => {
        output += chunk.toString();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.stderr.once("data", () => promptReady?.());

      try {
        await ready;
        child.stdin.write("\u0003");
        const [status, signal] = (await once(child, "exit")) as [
          number | null,
          NodeJS.Signals | null,
        ];

        expect(spawnExitCode({ status, signal })).toBe(130);
        expect(output).toContain("nemoclaw onboard --resume");
        expect(output).not.toContain("Error: Prompt interrupted");
        expect(output).not.toMatch(/store\.js:\d+/u);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not print a prompt stack after the installer /dev/tty handoff (#7439)",
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-prompt-sigint-"));
      const driverPath = path.join(tmpDir, "prompt-driver.cjs");
      const cliPath = path.join(tmpDir, "nemoclaw");
      fs.writeFileSync(driverPath, promptInterruptDriver(true), { mode: 0o600 });
      fs.writeFileSync(
        cliPath,
        `#!/usr/bin/env bash\nexec "$NODE_UNDER_TEST" "$DRIVER_UNDER_TEST"\n`,
        { mode: 0o755 },
      );
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
import tty

pid, fd = pty.fork()
if pid == 0:
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    command = """
source "$INSTALLER_UNDER_TEST"
_CLI_BIN="$CLI_UNDER_TEST"
_CLI_PATH="$CLI_UNDER_TEST"
show_usage_notice() { :; }
info() { printf 'INFO: %s\\n' "$*" >&2; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
error() { printf 'ERROR: %s\\n' "$*" >&2; return 1; }
command_exists() { return 1; }
run_onboard
"""
    os.execvpe("bash", ["bash", "-c", command], os.environ)

output = bytearray()
sent = False
prompt_seen_at = None
exit_code = 124
deadline = time.time() + 15
os.set_blocking(fd, False)
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except (BlockingIOError, OSError):
            chunk = b""
        if chunk:
            output.extend(chunk)
            if prompt_seen_at is None and b"NVIDIA API Key:" in output:
                prompt_seen_at = time.time()
    if not sent and prompt_seen_at is not None and time.time() - prompt_seen_at >= 0.2:
        tty.setraw(fd)
        os.write(fd, b"\\x03")
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
        os.waitpid(pid, 0)
        break

try:
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        output.extend(chunk)
except (BlockingIOError, OSError):
    pass
finally:
    os.close(fd)

sys.stdout.buffer.write(output)
if exit_code < 0:
    exit_code = 128 - exit_code
sys.exit(exit_code)
`;

      try {
        const result = spawnSync(python, ["-c", ptyRunner], {
          encoding: "utf-8",
          timeout: 20000,
          env: {
            ...process.env,
            CLI_UNDER_TEST: cliPath,
            DRIVER_UNDER_TEST: driverPath,
            FRESH: "",
            HOME: tmpDir,
            INSTALLER_UNDER_TEST: INSTALLER_PATH,
            NEMOCLAW_FRESH: "",
            NEMOCLAW_NON_INTERACTIVE: "",
            NODE_UNDER_TEST: process.execPath,
            NON_INTERACTIVE: "",
          },
        });
        const output = `${result.stdout}${result.stderr}`;

        expect(result.status, output).toBe(130);
        expect(output).toContain("attaching onboarding to /dev/tty");
        expect(output).toContain("nemoclaw onboard --resume");
        expect(output).not.toContain("Error: Prompt interrupted");
        expect(output).not.toMatch(/store\.js:\d+/u);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
