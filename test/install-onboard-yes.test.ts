// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

function runOnboardWithMockCli(env: Record<string, string>): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-yes-"));
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");

  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${stubBin}"
    info() { :; }
    warn() { :; }
    error() { return 0; }
    command_exists() { return 1; }
    run_onboard >/dev/null 2>&1 || true
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`shell exit ${result.status}: ${result.stderr}`);
  }

  const captured = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8") : "";
  return captured.split("\n").filter((line) => line.length > 0);
}

describe("install.sh run_onboard", () => {
  it("forwards --yes to nemoclaw onboard in non-interactive mode", () => {
    const argv = runOnboardWithMockCli({ NON_INTERACTIVE: "1" });
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });

  it("forwards --yes-i-accept-third-party-software when the env opt-in is set", () => {
    const argv = runOnboardWithMockCli({
      NON_INTERACTIVE: "1",
      ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    });
    expect(argv).toContain("--yes-i-accept-third-party-software");
    expect(argv).toContain("--yes");
  });
});
