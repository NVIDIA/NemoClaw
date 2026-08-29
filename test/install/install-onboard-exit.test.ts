// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
const ACCEPTED_NON_INTERACTIVE_ENV = {
  ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  NON_INTERACTIVE: "1",
};

function installerTestEnv(home: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...env,
  };
}

function runOnboardStub(env: Record<string, string>, stubScript: string): number | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-exit-"));
  const stubBin = path.join(tmp, "stub-cli");

  fs.writeFileSync(stubBin, stubScript, { mode: 0o755 });

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${stubBin}"
    _CLI_PATH="${stubBin}"
    info() { :; }
    warn() { :; }
    error() { exit 1; }
    command_exists() { return 1; }
    run_onboard
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: installerTestEnv(tmp, env),
  });
  return result.status;
}

function runOnboardExitStatus(env: Record<string, string>, stubExitCode: number): number | null {
  return runOnboardStub(env, `#!/usr/bin/env bash\nexit ${stubExitCode}\n`);
}

function runOnboardInterruptedStatus(env: Record<string, string>): number | null {
  return runOnboardStub(env, `#!/usr/bin/env bash\ntrap - INT\nkill -INT $$\nsleep 5\n`);
}

function runMainOnboardGate(stubExitCode: number): number | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-gate-"));
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    run_onboard() { return ${stubExitCode}; }
    run_onboard || fail_onboarding "$?"
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: installerTestEnv(tmp),
  });
  return result.status;
}

describe("install.sh run_onboard exit propagation (#5029)", () => {
  it("returns non-zero when nemoclaw onboard fails in non-interactive mode", () => {
    expect(runOnboardExitStatus(ACCEPTED_NON_INTERACTIVE_ENV, 1)).toBe(1);
  });

  it("returns zero when nemoclaw onboard succeeds in non-interactive mode", () => {
    expect(runOnboardExitStatus(ACCEPTED_NON_INTERACTIVE_ENV, 0)).toBe(0);
  });

  it("main onboarding gate exits non-zero when run_onboard fails", () => {
    expect(runMainOnboardGate(1)).toBe(1);
  });

  it("main onboarding gate continues when run_onboard succeeds", () => {
    expect(runMainOnboardGate(0)).toBe(0);
  });

  it("reports 130 when nemoclaw onboard is terminated by an interrupt (#9121)", () => {
    expect(runOnboardInterruptedStatus(ACCEPTED_NON_INTERACTIVE_ENV)).toBe(130);
  });

  it("main onboarding gate keeps the interrupt status instead of reporting a failed install (#9121)", () => {
    expect(runMainOnboardGate(130)).toBe(130);
  });

  it("main onboarding gate reports every other failure as 1 (#9121)", () => {
    expect(runMainOnboardGate(2)).toBe(1);
  });
});
