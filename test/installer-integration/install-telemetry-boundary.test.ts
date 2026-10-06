// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

type PriorManagedInstall = "none" | "recognized" | "malformed";

function runInstallerBody(body: string, extraEnv: Record<string, string> = {}) {
  const run = runInstallerSourcedBody(body, {
    homePrefix: "nemoclaw-install-telemetry-",
    extraEnv: {
      NEMOCLAW_TELEMETRY_ENV: "uat",
      NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1",
      ...extraEnv,
    },
    includeNodeOnPath: true,
    timeoutMs: 15_000,
  });
  onTestFinished(run.remove);
  return run;
}

function runMainHarness(
  onboardStatus: 0 | 1,
  extraEnv: Record<string, string> = {},
  telemetryExitStatus = 0,
  priorManagedInstall: PriorManagedInstall = "none",
) {
  const run = runInstallerBody(
    `
ORDER_TRACE="$HOME/order.trace"
TELEMETRY_CALLS="$HOME/telemetry.calls"
TELEMETRY_EXIT_STATUS="${telemetryExitStatus}"
export ORDER_TRACE TELEMETRY_CALLS TELEMETRY_EXIT_STATUS
NEMOCLAW_SOURCE_ROOT="$HOME/source"
TELEMETRY_ENTRY="$NEMOCLAW_SOURCE_ROOT/dist/lib/cli/installer-telemetry-entry.js"
mkdir -p "$(dirname "$TELEMETRY_ENTRY")"
cat >"$TELEMETRY_ENTRY" <<'STUB'
const fs = require("node:fs");
fs.appendFileSync(process.env.TELEMETRY_CALLS, process.argv.slice(2).join(" ") + "\\n");
fs.appendFileSync(process.env.ORDER_TRACE, "telemetry\\n");
fs.writeFileSync(process.env.TELEMETRY_CALLS + ".label", process.env.NEMOCLAW_TELEMETRY_TEST_LABEL ?? "");
process.exit(Number(process.env.TELEMETRY_EXIT_STATUS));
STUB
_CLI_PATH="$HOME/nemoclaw"
cat >"$_CLI_PATH" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$_CLI_PATH"
record_order() { printf '%s\\n' "$1" >>"$ORDER_TRACE"; }
resolve_nemoclaw_gateway_port() { printf '18789'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { :; }
validate_deferred_hermes_onboarding_request() { :; }
is_recognized_managed_nemoclaw_install() {
  [[ "$PRIOR_MANAGED_INSTALL" == "recognized" ]]
}
install_nemoclaw_before_onboarding() {
  capture_prior_managed_install_for_telemetry
  record_order install
  rm -rf "$HOME/.nemoclaw/source"
}
command_exists() { return 0; }
registered_sandbox_count() { printf '0\\n'; }
should_defer_hermes_onboarding() { return 1; }
run_installer_host_preflight() { return 0; }
recover_preexisting_sandboxes_before_onboard() { return 0; }
run_onboard() { record_order onboard; return "$ONBOARD_STATUS"; }
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { record_order finalize; }
clear_station_resume_after_completed_onboarding() {
  record_order cleanup
  return "$CLEANUP_STATUS"
}
main --non-interactive --yes-i-accept-third-party-software
`,
    {
      ONBOARD_STATUS: String(onboardStatus),
      CLEANUP_STATUS: "0",
      PRIOR_MANAGED_INSTALL: priorManagedInstall,
      ...extraEnv,
    },
  );
  const callsPath = path.join(run.home, "telemetry.calls");
  const orderPath = path.join(run.home, "order.trace");
  return {
    ...run,
    calls: fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "",
    order: fs.existsSync(orderPath) ? fs.readFileSync(orderPath, "utf8") : "",
  };
}

function runBootstrapHelp() {
  return spawnSync("bash", ["-s", "--", "--help"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    input: fs.readFileSync(path.join(REPO_ROOT, "install.sh"), "utf8"),
  });
}

function runPayloadHelp() {
  return spawnSync("bash", [path.join(REPO_ROOT, "scripts/install.sh"), "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("installer telemetry boundary", () => {
  it.each([
    { surface: "bootstrap", run: runBootstrapHelp },
    { surface: "payload", run: runPayloadHelp },
  ])("documents the opt-out in $surface help (#10440)", ({ run }) => {
    const result = run();
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("NEMOCLAW_DISABLE_TELEMETRY=1");
    expect(output).toContain("Disable installer telemetry");
  });

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["CI", "1"],
    ["GITHUB_ACTIONS", "true"],
    ["VITEST", "true"],
    ["NEMOCLAW_RUN_LIVE_E2E", "1"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", " \t0123456789abcdef0123456789abcdef01234567 \t"],
    ["NODE_ENV", "test"],
    ["NEMOCLAW_TELEMETRY_TEST_LABEL", ""],
    ["NEMOCLAW_TELEMETRY_TEST_LABEL", "private@example.com"],
    ["NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-a:b:attempt-1\n"],
  ] as const)("skips telemetry state and command checks for %s=%s (#10440)", (name, value) => {
    const run = runInstallerBody(
      `
TELEMETRY_WORK="$HOME/telemetry-work.calls"
_NEMOCLAW_PRIOR_MANAGED_INSTALL=true
nemoclaw_state_root() {
  printf 'state-root\\n' >>"$TELEMETRY_WORK"
  printf '%s\\n' "$HOME/.nemoclaw"
}
is_recognized_managed_nemoclaw_install() {
  printf 'prior-install\\n' >>"$TELEMETRY_WORK"
  return 0
}
command_exists() {
  printf 'command-check\\n' >>"$TELEMETRY_WORK"
  return 1
}
_CLI_PATH="$BASH"
NEMOCLAW_SOURCE_ROOT="$HOME/source"
capture_prior_managed_install_for_telemetry
send_install_telemetry
printf '%s\\n' "$_NEMOCLAW_PRIOR_MANAGED_INSTALL"
`,
      { [name]: value },
    );

    expect(run.result.status, run.output).toBe(0);
    expect(run.result.stdout.trim()).toBe("false");
    expect(fs.existsSync(path.join(run.home, "telemetry-work.calls"))).toBe(false);
  });

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "true"],
    ["CI", "false"],
    ["GITHUB_ACTIONS", "1"],
    ["VITEST", "1"],
    ["NEMOCLAW_RUN_LIVE_E2E", "true"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", " \t "],
    ["NEMOCLAW_E2E_EXPECTED_SHA", ""],
    ["NODE_ENV", "testing"],
    ["NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-campaign:case:attempt-1"],
  ] as const)("does not suppress telemetry for %s=%s (#10440)", (name, value) => {
    const run = runMainHarness(0, { [name]: value });

    expect(run.result.status, run.output).toBe(0);
    expect(run.calls).toBe("install\n");
  });

  it.each(["absent", "", "production", "UAT", "unknown"])(
    "does not probe prior installer state or tools for inactive mode %j",
    (mode) => {
      const run = runInstallerBody(
        `
${mode === "absent" ? "unset NEMOCLAW_TELEMETRY_ENV" : ""}
nemoclaw_state_root() { printf 'unexpected-state-probe' >"$HOME/unexpected"; return 1; }
is_recognized_managed_nemoclaw_install() { printf 'unexpected-install-probe' >"$HOME/unexpected"; return 1; }
command_exists() { printf 'unexpected-command-probe' >"$HOME/unexpected"; return 1; }
capture_prior_managed_install_for_telemetry
send_install_telemetry
`,
        { NEMOCLAW_TELEMETRY_ENV: mode },
      );
      expect(run.result.status, run.output).toBe(0);
      expect(fs.existsSync(path.join(run.home, "unexpected"))).toBe(false);
    },
  );

  it("does not probe state or tools for UAT without a label", () => {
    const run = runInstallerBody(`
unset NEMOCLAW_TELEMETRY_TEST_LABEL
nemoclaw_state_root() { printf 'unexpected-state-probe' >"$HOME/unexpected"; return 1; }
command_exists() { printf 'unexpected-command-probe' >"$HOME/unexpected"; return 1; }
capture_prior_managed_install_for_telemetry
send_install_telemetry
`);
    expect(run.result.status, run.output).toBe(0);
    expect(fs.existsSync(path.join(run.home, "unexpected"))).toBe(false);
  });

  it.each([
    "qa-café:case:attempt-1",
    "qa-campaign:cåse:attempt-1",
    "qa-campaign:用例:attempt-1",
    "qa-campaign:case:attempt-١",
  ])("does not probe state or tools for a non-ASCII QA label %j", (testLabel) => {
    const run = runInstallerBody(
      `
nemoclaw_state_root() { printf 'unexpected-state-probe' >"$HOME/unexpected"; return 1; }
command_exists() { printf 'unexpected-command-probe' >"$HOME/unexpected"; return 1; }
capture_prior_managed_install_for_telemetry
send_install_telemetry
`,
      { NEMOCLAW_TELEMETRY_TEST_LABEL: testLabel, LC_ALL: "C.utf8" },
    );
    expect(run.result.status, run.output).toBe(0);
    expect(fs.existsSync(path.join(run.home, "unexpected"))).toBe(false);
  });

  it("preserves the caller's UTF-8 locale after checking an ASCII QA label", () => {
    const run = runInstallerBody(
      `
if should_suppress_install_telemetry; then exit 97; fi
printf '%s' "$LC_ALL"
`,
      { LC_ALL: "C.utf8" },
    );
    expect(run.result.status, run.output).toBe(0);
    expect(run.result.stdout).toBe("C.utf8");
  });

  it.each([
    ["a direct install", {}, "none", "install"],
    ["an update invocation", { NEMOCLAW_UPDATE_INVOKED: "1" }, "none", "update"],
    ["a manual rerun over an older managed install", {}, "recognized", "update"],
    ["a malformed prior install", {}, "malformed", "install"],
    [
      "an update invocation with malformed prior state",
      { NEMOCLAW_UPDATE_INVOKED: "1" },
      "malformed",
      "update",
    ],
    ["an unrecognized marker", { NEMOCLAW_UPDATE_INVOKED: "unexpected" }, "none", "install"],
  ])(
    "passes only the closed operation after successful cleanup for %s (#10440)",
    (_scenario, env, priorManagedInstall, operation) => {
      const run = runMainHarness(0, env, 0, priorManagedInstall as PriorManagedInstall);

      expect(run.result.status, run.output).toBe(0);
      expect(run.order).toBe("install\nonboard\nfinalize\ncleanup\ntelemetry\n");
      expect(run.calls).toBe(`${operation}\n`);
    },
  );

  it("inherits the approved QA label into the normal installer child", () => {
    const testLabel = "qa-campaign:case:attempt-1";
    const run = runMainHarness(0, {
      NEMOCLAW_TELEMETRY_ENV: "uat",
      NEMOCLAW_TELEMETRY_TEST_LABEL: testLabel,
    });
    expect(run.result.status, run.output).toBe(0);
    expect(run.calls).toBe("install\n");
    expect(fs.readFileSync(path.join(run.home, "telemetry.calls.label"), "utf8")).toBe(testLabel);
  });

  it("preserves installer success when the single telemetry call fails (#10440)", () => {
    const run = runMainHarness(0, { NEMOCLAW_UPDATE_INVOKED: "1" }, 73);

    expect(run.result.status, run.output).toBe(0);
    expect(run.order).toBe("install\nonboard\nfinalize\ncleanup\ntelemetry\n");
    expect(run.calls).toBe("update\n");
  });

  it("does not attempt telemetry after an installer failure (#10440)", () => {
    const run = runMainHarness(1);

    expect(run.result.status, run.output).not.toBe(0);
    expect(run.order).toBe("install\nonboard\n");
    expect(run.calls).toBe("");
  });

  it("does not attempt telemetry when post-onboarding cleanup fails (#10440)", () => {
    const run = runMainHarness(0, { CLEANUP_STATUS: "1" });

    expect(run.result.status, run.output).not.toBe(0);
    expect(run.order).toBe("install\nonboard\nfinalize\ncleanup\n");
    expect(run.calls).toBe("");
  });
});
