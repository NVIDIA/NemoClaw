// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

// Exercise print_done() directly with a controlled environment. The post-onboard
// auto-upgrade of pre-existing sandboxes is destructive (it deletes a sandbox
// before recreating it), so a failed auto-upgrade must not be reported as a
// clean install (#5735).
function runPrintDone(upgradeFailed: boolean): string {
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    # Minimal stubs so print_done runs in isolation.
    info() { printf 'INFO:%s\\n' "$*"; }
    warn() { printf 'WARN:%s\\n' "$*"; }
    needs_shell_reload() { return 1; }
    resolve_onboarded_agent() { printf 'openclaw'; }
    warn_default_agent_fallback() { :; }
    print_cli_path_refresh_actions() { :; }
    _INSTALL_START=0
    SECONDS=0
    _CLI_DISPLAY="NemoClaw"
    _CLI_BIN="nemoclaw"
    ONBOARD_RAN=true
    NEMOCLAW_READY_NOW=true
    _UPGRADE_SANDBOXES_FAILED=${upgradeFailed ? "true" : "false"}
    print_done
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    // Neutralize ambient shell hooks (BASH_ENV/ENV) so an outer profile cannot
    // run before the snippet and make this deterministic test flaky.
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// Exercise finalize_install() — print_done() plus the fatal-exit propagation —
// so a failed post-onboard auto-upgrade surfaces a non-zero installer result,
// not a warning-styled success (#5735 PRA-5/PRA-T1).
function runFinalizeInstall(upgradeFailed: boolean): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    info() { printf 'INFO:%s\\n' "$*"; }
    warn() { printf 'WARN:%s\\n' "$*"; }
    needs_shell_reload() { return 1; }
    resolve_onboarded_agent() { printf 'openclaw'; }
    warn_default_agent_fallback() { :; }
    print_cli_path_refresh_actions() { :; }
    _INSTALL_START=0
    SECONDS=0
    _CLI_DISPLAY="NemoClaw"
    _CLI_BIN="nemoclaw"
    ONBOARD_RAN=true
    NEMOCLAW_READY_NOW=true
    _UPGRADE_SANDBOXES_FAILED=${upgradeFailed ? "true" : "false"}
    finalize_install
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("install.sh print_done — auto-upgrade severity (#5735)", () => {
  it("prints a clean completion banner when no sandbox upgrade failed", () => {
    const out = runPrintDone(false);
    expect(out).toContain("=== Installation complete ===");
    expect(out).not.toContain("Installation completed with warnings");
    expect(out).not.toContain("Existing sandbox upgrade did not finish");
  });

  it("downgrades the banner and surfaces recovery guidance when an upgrade failed", () => {
    const out = runPrintDone(true);
    // No plain "Installation complete" success banner.
    expect(out).not.toContain("=== Installation complete ===");
    expect(out).toContain("Installation completed with warnings");
    // Explicit incomplete status with recovery guidance for the operator.
    expect(out).toContain("Existing sandbox upgrade did not finish");
    expect(out).toContain("onboard --resume");
    expect(out).toContain("rebuild");
  });
});

describe("install.sh finalize_install fatal exit on failed auto-upgrade for PRA-5 (#5735)", () => {
  it("exits zero and prints the clean banner when no upgrade failed", () => {
    const result = runFinalizeInstall(false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("=== Installation complete ===");
  });

  it("exits non-zero while still printing the recovery guidance when an upgrade failed", () => {
    const result = runFinalizeInstall(true);
    // Fatal: automation/operators must not treat this as a successful install.
    expect(result.status).not.toBe(0);
    // Recovery guidance from print_done is still shown before the fatal exit.
    expect(result.stdout).toContain("Installation completed with warnings");
    expect(result.stdout).toContain("Existing sandbox upgrade did not finish");
    // The fatal error line is surfaced (error() writes to stderr).
    expect(result.stderr).toContain("Installation incomplete");
  });
});
