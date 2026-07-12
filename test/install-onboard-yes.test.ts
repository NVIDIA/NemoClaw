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

  fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });

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

  fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });

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

// Run run_onboard against a crafted ~/.nemoclaw/onboard-session.json so the
// session classifier path runs. Unlike the helpers above (which stub
// command_exists to false to skip classification), this keeps command_exists
// real so `command_exists node` is true and the real node classifier runs.
function runOnboardWithSession(
  env: Record<string, string>,
  session: Record<string, unknown>,
): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-session-"));
  const home = path.join(tmp, "home");
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".nemoclaw", "onboard-session.json"), JSON.stringify(session));
  fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${stubBin}"
    info() { :; }
    warn() { :; }
    error() { return 0; }
    run_onboard >/dev/null 2>&1 || true
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env, HOME: home },
  });
  expect(result.status, result.stderr).toBe(0);
  const captured = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8") : "";
  return captured.split("\n").filter((line) => line.length > 0);
}

describe("install.sh run_onboard — session classification (#5626)", () => {
  it("starts fresh (not --resume) when interrupted before sandbox creation", () => {
    // in_progress with no sandboxName and an incomplete sandbox step: nothing
    // to resume, so auto-attaching --resume would dead-end at the CLI
    // non-interactive resume guard (#2753). Classifier must pick --fresh.
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        steps: { sandbox: { status: "pending" } },
      },
    );
    expect(argv).toContain("onboard");
    expect(argv).toContain("--fresh");
    expect(argv).not.toContain("--resume");
  });

  it("still auto-resumes when a sandbox was already created", () => {
    // A sandbox exists to resume into (#2753's legitimate resume path), so the
    // classifier must keep auto-attaching --resume and never --fresh.
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: "my-assistant",
        steps: { sandbox: { status: "complete" } },
      },
    );
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--fresh");
  });

  it.each([
    {
      name: "sandbox name without completed sandbox step",
      session: {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: "phantom-box",
        steps: { sandbox: { status: "pending" } },
      },
    },
    {
      name: "completed sandbox step without sandbox name",
      session: {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        steps: { sandbox: { status: "complete" } },
      },
    },
  ])("starts fresh for $name", ({ session }) => {
    const argv = runOnboardWithSession({ NON_INTERACTIVE: "1" }, session);
    expect(argv).toContain("--fresh");
    expect(argv).not.toContain("--resume");
  });

  it("does not resume or reset a completed session", () => {
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      { version: 1, status: "complete", resumable: false, sandboxName: "my-assistant" },
    );
    expect(argv).toContain("onboard");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--fresh");
  });
});

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
