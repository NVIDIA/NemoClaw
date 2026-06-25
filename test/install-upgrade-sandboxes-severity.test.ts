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
