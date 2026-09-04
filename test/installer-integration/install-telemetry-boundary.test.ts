// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

function runInstallerBody(body: string, extraEnv: Record<string, string> = {}) {
  const run = runInstallerSourcedBody(body, {
    homePrefix: "nemoclaw-install-telemetry-",
    extraEnv,
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
install_nemoclaw_before_onboarding() { record_order install; }
command_exists() { return 0; }
registered_sandbox_count() { printf '0\\n'; }
should_defer_hermes_onboarding() { return 1; }
run_installer_host_preflight() { return 0; }
recover_preexisting_sandboxes_before_onboard() { return 0; }
run_onboard() { record_order onboard; return "$ONBOARD_STATUS"; }
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { record_order finalize; }
clear_station_resume_after_completed_onboarding() { record_order cleanup; }
main --non-interactive --yes-i-accept-third-party-software
`,
    { ONBOARD_STATUS: String(onboardStatus), ...extraEnv },
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
    ["a direct install", {}, "install"],
    ["an update invocation", { NEMOCLAW_UPDATE_INVOKED: "1" }, "update"],
    ["an unrecognized marker", { NEMOCLAW_UPDATE_INVOKED: "unexpected" }, "install"],
  ])(
    "passes only the closed operation after successful cleanup for %s (#10440)",
    (_scenario, env, operation) => {
      const run = runMainHarness(0, env);

      expect(run.result.status, run.output).toBe(0);
      expect(run.order).toBe("install\nonboard\nfinalize\ncleanup\ntelemetry\n");
      expect(run.calls).toBe(`${operation}\n`);
    },
  );

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
});
