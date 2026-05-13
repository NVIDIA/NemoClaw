// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

type StubAssignments = {
  cliBin?: string;
  cliPath?: string;
};

function runOnboardWithMockCli(
  env: Record<string, string>,
  assignments: StubAssignments = {},
): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-yes-"));
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");

  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  const cliBin = assignments.cliBin ?? stubBin;
  // Quote each assignment so an empty string survives the heredoc — `_CLI_PATH=`
  // with nothing after it is a valid bash assignment to empty, but reads more
  // ambiguously than the explicit `_CLI_PATH=""` form.
  const cliPathAssignment =
    assignments.cliPath !== undefined ? `_CLI_PATH="${assignments.cliPath}"` : "";

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${cliBin}"
    ${cliPathAssignment}
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

function runOnboardWithStubAtPath(
  env: Record<string, string>,
  cliBinName: string,
): { argv: string[]; argvLog: string; stubBin: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-clipath-"));
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
    _CLI_BIN="${cliBinName}"
    _CLI_PATH="${stubBin}"
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
  return {
    argv: captured.split("\n").filter((line) => line.length > 0),
    argvLog,
    stubBin,
  };
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

describe("install.sh run_onboard — _CLI_PATH precedence (#3276)", () => {
  it("invokes via _CLI_PATH (absolute path) when set, ignoring _CLI_BIN", () => {
    // Repro: stale PATH cache. _CLI_BIN does not resolve by name, but
    // _CLI_PATH points at the real binary on disk. The fallback
    // `"${_CLI_PATH:-$_CLI_BIN}"` must pick _CLI_PATH so auto-onboarding
    // doesn't silently skip.
    const { argv, argvLog } = runOnboardWithStubAtPath(
      { NON_INTERACTIVE: "1" },
      "nemoclaw-not-on-path",
    );
    expect(fs.existsSync(argvLog)).toBe(true);
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });

  it("falls back to _CLI_BIN when _CLI_PATH is empty (pin the fallback)", () => {
    // Explicit empty _CLI_PATH must route through _CLI_BIN so a future
    // refactor cannot silently drop the `"${_CLI_PATH:-$_CLI_BIN}"` form.
    const argv = runOnboardWithMockCli({ NON_INTERACTIVE: "1" }, { cliPath: "" });
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });
});
