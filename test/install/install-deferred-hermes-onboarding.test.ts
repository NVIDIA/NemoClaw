// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";

type MainOptions = {
  agent?: string;
  deferEnv?: boolean;
  deferFlag?: boolean;
  inferenceKey?: string;
  nvidiaApiKey?: string;
  onboardStatus?: number;
  provider?: string;
  providerKey?: string;
  registeredSandboxCount?: number;
};

function runMain(options: MainOptions = {}) {
  const registeredSandboxCount = options.registeredSandboxCount ?? 0;
  const result = runInstallerSourcedBody(
    `
set -e
record() { printf '%s\n' "$1" >>"$HOME/calls.log"; }
load_station_vllm_conflict_helpers() { :; }
consume_station_local_vllm_resume() { return 1; }
resolve_nemoclaw_gateway_port() { printf '8080'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { record prepare-installer-host; }
bash() { :; }
step() { record "step-$1-$2"; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
resolve_pending_express_wsl_provider() { :; }
ensure_station_express_pair() { :; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() { :; }
install_nemoclaw() { record install-nemoclaw; }
verify_nemoclaw() {
  _CLI_PATH="/usr/bin/true"
  NEMOCLAW_READY_NOW=true
}
require_reportable_openshell_version() { :; }
registered_sandbox_count() { printf '%s\n' "$REGISTERED_SANDBOX_COUNT"; }
run_installer_host_preflight() { record host-preflight; return 0; }
recover_preexisting_sandboxes_before_onboard() {
  record recover-preexisting
  if [[ "$REGISTERED_SANDBOX_COUNT" != "0" ]]; then
    _PREEXISTING_SANDBOX_RECOVERY_RAN=true
  fi
  return 0
}
run_onboard() {
  record onboard
  printf '%s\n' 'onboard' >"$HOME/onboard-args.log"
  if [[ "$ONBOARD_STATUS" == "0" ]]; then
    touch "$HOME/provider-created" "$HOME/sandbox-created" "$HOME/onboarding-complete"
  fi
  return "$ONBOARD_STATUS"
}
restore_onboard_forward_after_post_checks() { record restore-forward; return 0; }
needs_shell_reload() { return 1; }
detect_shell_profile() { printf '%s' "$HOME/.profile"; }
clear_station_resume_after_completed_onboarding() { :; }
main --non-interactive --yes-i-accept-third-party-software ${options.deferFlag ? "--defer-onboarding" : ""}
`,
    {
      extraEnv: {
        NEMOCLAW_AGENT: options.agent ?? "hermes",
        NEMOCLAW_DEFER_ONBOARDING: options.deferEnv ? "1" : "",
        NVIDIA_INFERENCE_API_KEY: options.inferenceKey ?? "",
        NVIDIA_API_KEY: options.nvidiaApiKey ?? "",
        NEMOCLAW_PROVIDER: options.provider ?? "",
        NEMOCLAW_PROVIDER_KEY: options.providerKey ?? "",
        ONBOARD_STATUS: String(options.onboardStatus ?? 0),
        REGISTERED_SANDBOX_COUNT: String(registeredSandboxCount),
      },
      includeNodeOnPath: true,
      timeoutMs: 15_000,
    },
  );
  onTestFinished(result.remove);

  const callsPath = path.join(result.home, "calls.log");
  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return {
    ...result,
    calls,
    onboardingComplete: fs.existsSync(path.join(result.home, "onboarding-complete")),
    providerCreated: fs.existsSync(path.join(result.home, "provider-created")),
    sandboxCreated: fs.existsSync(path.join(result.home, "sandbox-created")),
  };
}

describe("Hermes deferred onboarding", () => {
  it("lists the installer option and environment setting (#10288)", () => {
    const result = runInstallerSourcedBody("usage", {
      extraEnv: { NEMOCLAW_AGENT: "hermes" },
    });
    onTestFinished(result.remove);

    expect(result.result.status, result.output).toBe(0);
    expect(result.output).toContain("--defer-onboarding");
    expect(result.output).toContain("NEMOCLAW_DEFER_ONBOARDING=1");
  });

  it.each([
    ["installer option", { deferFlag: true }],
    ["environment setting", { deferEnv: true }],
  ])(
    "installs without onboarding when credentials are absent through the %s (#10288)",
    (_name, input) => {
      const result = runMain(input);

      expect(result.result.status, result.output).toBe(0);
      expect(result.calls).toContain("install-nemoclaw");
      expect(result.calls).not.toContain("host-preflight");
      expect(result.calls).not.toContain("onboard");
      expect(result.output).toContain("NVIDIA inference credentials are absent");
      expect(result.output).toContain("Onboarding did not run");
      expect(result.output).toContain("nemohermes onboard");
      expect(result.providerCreated).toBe(false);
      expect(result.sandboxCreated).toBe(false);
      expect(result.onboardingComplete).toBe(false);
    },
  );

  it.each([
    ["NVIDIA_INFERENCE_API_KEY", { inferenceKey: "nvapi-primary-runtime-test" }],
    ["NVIDIA_API_KEY", { nvidiaApiKey: "nvapi-alias-runtime-test" }],
    ["NEMOCLAW_PROVIDER_KEY", { providerKey: "nvapi-bridge-runtime-test" }],
  ])("runs normal onboarding when %s supplies a credential (#10288)", (_name, input) => {
    const credential = Object.values(input)[0];
    const result = runMain({ deferFlag: true, ...input });

    expect(result.result.status, result.output).toBe(0);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("onboard");
    expect(result.calls).toContain("restore-forward");
    expect(result.providerCreated).toBe(true);
    expect(result.sandboxCreated).toBe(true);
    expect(result.onboardingComplete).toBe(true);
    expect(result.output).not.toContain(credential);
    expect(fs.readFileSync(path.join(result.home, "onboard-args.log"), "utf-8")).not.toContain(
      credential,
    );
  });

  it("propagates the onboarding failure when a credential is provided (#10288)", () => {
    const invalidKey = "invalid-runtime-test-value";
    const result = runMain({ deferFlag: true, inferenceKey: invalidKey, onboardStatus: 1 });

    expect(result.result.status).toBe(1);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("onboard");
    expect(result.output).toContain("Onboarding did not complete successfully");
    expect(result.output).not.toContain(invalidKey);
  });

  it("keeps the missing-credential failure when deferred onboarding is not enabled (#10288)", () => {
    const result = runMain({ onboardStatus: 1 });

    expect(result.result.status).toBe(1);
    expect(result.calls).toContain("onboard");
    expect(result.output).toContain("Onboarding did not complete successfully");
  });

  it("keeps existing sandbox recovery on the normal installer path (#10288)", () => {
    const result = runMain({ deferFlag: true, registeredSandboxCount: 1 });

    expect(result.result.status, result.output).toBe(0);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("recover-preexisting");
    expect(result.calls).not.toContain("onboard");
  });

  it.each([
    ["OpenClaw", { agent: "openclaw" }, "NEMOCLAW_AGENT=hermes"],
    ["a non-NVIDIA provider", { provider: "openai" }, "NVIDIA hosted inference only"],
  ])(
    "rejects deferred Hermes onboarding for %s before installation (#10288)",
    (_name, input, expected) => {
      const result = runMain({ deferFlag: true, ...input });

      expect(result.result.status).toBe(1);
      expect(result.output).toContain(expected);
      expect(result.calls).not.toContain("prepare-installer-host");
      expect(result.calls).not.toContain("install-nemoclaw");
      expect(result.calls).not.toContain("onboard");
    },
  );
});
