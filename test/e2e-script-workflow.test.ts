// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadE2eWorkflowContract, reusableNightlyJobs } from "./helpers/e2e-workflow-contract";

// Direct legacy bash E2Es are being migrated toward Vitest coverage. Keep the
// top-level shell suite frozen so new coverage starts in the newer E2E surface
// unless maintainers intentionally update this allowlist.
const LEGACY_E2E_SHELL_ALLOWLIST = [
  "test/e2e/test-agent-turn-latency-e2e.sh",
  "test/e2e/test-bedrock-runtime-compatible-anthropic.sh",
  "test/e2e/test-brave-search-e2e.sh",
  "test/e2e/test-channels-add-remove.sh",
  "test/e2e/test-channels-stop-start.sh",
  "test/e2e/test-cloud-inference-e2e.sh",
  "test/e2e/test-cloud-onboard-e2e.sh",
  "test/e2e/test-common-egress-agent-e2e.sh",
  "test/e2e/test-concurrent-gateway-ports.sh",
  "test/e2e/test-credential-migration.sh",
  "test/e2e/test-credential-sanitization.sh",
  "test/e2e/test-cron-preflight-inference-local-e2e.sh",
  "test/e2e/test-dashboard-remote-bind.sh",
  "test/e2e/test-device-auth-health.sh",
  "test/e2e/test-diagnostics.sh",
  "test/e2e/test-docs-validation.sh",
  "test/e2e/test-double-onboard.sh",
  "test/e2e/test-full-e2e.sh",
  "test/e2e/test-gateway-drift-preflight.sh",
  "test/e2e/test-gateway-health-honest.sh",
  "test/e2e/test-gpu-double-onboard.sh",
  "test/e2e/test-gpu-e2e.sh",
  "test/e2e/test-hermes-discord-e2e.sh",
  "test/e2e/test-hermes-e2e.sh",
  "test/e2e/test-hermes-inference-switch.sh",
  "test/e2e/test-hermes-root-entrypoint-smoke.sh",
  "test/e2e/test-hermes-sandbox-secret-boundary.sh",
  "test/e2e/test-hermes-slack-e2e.sh",
  "test/e2e/test-inference-routing.sh",
  "test/e2e/test-issue-2478-crash-loop-recovery.sh",
  "test/e2e/test-issue-4434-tui-unreachable-inference.sh",
  "test/e2e/test-issue-4462-scope-upgrade-approval.sh",
  "test/e2e/test-jetson-nvmap-gpu.sh",
  "test/e2e/test-kimi-inference-compat.sh",
  "test/e2e/test-launchable-smoke.sh",
  "test/e2e/test-messaging-compatible-endpoint.sh",
  "test/e2e/test-messaging-providers.sh",
  "test/e2e/test-model-router-provider-routed-inference.sh",
  "test/e2e/test-network-policy.sh",
  "test/e2e/test-ollama-auth-proxy-e2e.sh",
  "test/e2e/test-onboard-negative-paths.sh",
  "test/e2e/test-onboard-repair.sh",
  "test/e2e/test-onboard-resume.sh",
  "test/e2e/test-openclaw-discord-pairing.sh",
  "test/e2e/test-openclaw-inference-switch.sh",
  "test/e2e/test-openclaw-plugin-runtime-exdev.sh",
  "test/e2e/test-openclaw-skill-cli-e2e.sh",
  "test/e2e/test-openclaw-slack-pairing.sh",
  "test/e2e/test-openclaw-tui-chat-correlation.sh",
  "test/e2e/test-openshell-gateway-upgrade.sh",
  "test/e2e/test-openshell-version-pin.sh",
  "test/e2e/test-overlayfs-autofix.sh",
  "test/e2e/test-rebuild-hermes.sh",
  "test/e2e/test-rebuild-openclaw.sh",
  "test/e2e/test-runtime-overrides.sh",
  "test/e2e/test-sandbox-operations.sh",
  "test/e2e/test-sandbox-rebuild.sh",
  "test/e2e/test-sandbox-survival.sh",
  "test/e2e/test-sessions-agents-cli.sh",
  "test/e2e/test-shields-config.sh",
  "test/e2e/test-skill-agent-e2e.sh",
  "test/e2e/test-snapshot-commands.sh",
  "test/e2e/test-spark-install.sh",
  "test/e2e/test-state-backup-restore.sh",
  "test/e2e/test-telegram-injection.sh",
  "test/e2e/test-token-rotation.sh",
  "test/e2e/test-tunnel-lifecycle.sh",
  "test/e2e/test-upgrade-stale-sandbox.sh",
  "test/e2e/test-vm-driver-privileged-exec-routing.sh",
  "test/e2e/test-whatsapp-qr-compact-e2e.sh",
];

// Scheduled nightly wiring is frozen separately: retiring a nightly-wired legacy
// script should remove it from nightly and this allowlist in the same PR that
// deletes the script.
const NIGHTLY_E2E_SCRIPT_ALLOWLIST = [
  "test/e2e/test-agent-turn-latency-e2e.sh",
  "test/e2e/test-bedrock-runtime-compatible-anthropic.sh",
  "test/e2e/test-brave-search-e2e.sh",
  "test/e2e/test-channels-add-remove.sh",
  "test/e2e/test-channels-stop-start.sh",
  "test/e2e/test-cloud-inference-e2e.sh",
  "test/e2e/test-cloud-onboard-e2e.sh",
  "test/e2e/test-common-egress-agent-e2e.sh",
  "test/e2e/test-concurrent-gateway-ports.sh",
  "test/e2e/test-credential-migration.sh",
  "test/e2e/test-credential-sanitization.sh",
  "test/e2e/test-cron-preflight-inference-local-e2e.sh",
  "test/e2e/test-device-auth-health.sh",
  "test/e2e/test-diagnostics.sh",
  "test/e2e/test-docs-validation.sh",
  "test/e2e/test-double-onboard.sh",
  "test/e2e/test-full-e2e.sh",
  "test/e2e/test-gpu-double-onboard.sh",
  "test/e2e/test-gpu-e2e.sh",
  "test/e2e/test-hermes-discord-e2e.sh",
  "test/e2e/test-hermes-e2e.sh",
  "test/e2e/test-hermes-inference-switch.sh",
  "test/e2e/test-hermes-root-entrypoint-smoke.sh",
  "test/e2e/test-hermes-sandbox-secret-boundary.sh",
  "test/e2e/test-hermes-slack-e2e.sh",
  "test/e2e/test-inference-routing.sh",
  "test/e2e/test-issue-2478-crash-loop-recovery.sh",
  "test/e2e/test-issue-4434-tui-unreachable-inference.sh",
  "test/e2e/test-issue-4462-scope-upgrade-approval.sh",
  "test/e2e/test-jetson-nvmap-gpu.sh",
  "test/e2e/test-kimi-inference-compat.sh",
  "test/e2e/test-launchable-smoke.sh",
  "test/e2e/test-messaging-compatible-endpoint.sh",
  "test/e2e/test-messaging-providers.sh",
  "test/e2e/test-network-policy.sh",
  "test/e2e/test-onboard-negative-paths.sh",
  "test/e2e/test-onboard-repair.sh",
  "test/e2e/test-onboard-resume.sh",
  "test/e2e/test-openclaw-discord-pairing.sh",
  "test/e2e/test-openclaw-inference-switch.sh",
  "test/e2e/test-openclaw-skill-cli-e2e.sh",
  "test/e2e/test-openclaw-slack-pairing.sh",
  "test/e2e/test-openclaw-tui-chat-correlation.sh",
  "test/e2e/test-openshell-gateway-upgrade.sh",
  "test/e2e/test-overlayfs-autofix.sh",
  "test/e2e/test-rebuild-hermes.sh",
  "test/e2e/test-rebuild-openclaw.sh",
  "test/e2e/test-runtime-overrides.sh",
  "test/e2e/test-sandbox-operations.sh",
  "test/e2e/test-sandbox-survival.sh",
  "test/e2e/test-sessions-agents-cli.sh",
  "test/e2e/test-shields-config.sh",
  "test/e2e/test-skill-agent-e2e.sh",
  "test/e2e/test-snapshot-commands.sh",
  "test/e2e/test-state-backup-restore.sh",
  "test/e2e/test-telegram-injection.sh",
  "test/e2e/test-token-rotation.sh",
  "test/e2e/test-tunnel-lifecycle.sh",
  "test/e2e/test-upgrade-stale-sandbox.sh",
  "test/e2e/test-vm-driver-privileged-exec-routing.sh",
];

function listLegacyE2eShellScripts(): string[] {
  return readdirSync(new URL("./e2e/", import.meta.url))
    .filter((name) => /^test-.*\.sh$/.test(name))
    .map((name) => `test/e2e/${name}`)
    .sort();
}

function collectLegacyE2eShellScriptRefs(value: unknown): string[] {
  const scripts = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(/test\/e2e\/test-[A-Za-z0-9_.-]+\.sh/g)) {
        scripts.add(match[0] ?? "");
      }
      scripts.delete("");
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) visit(item);
    }
  };

  visit(value);
  return [...scripts].sort();
}

describe("E2E reusable workflow contract", () => {
  const { runnerWorkflow, nightlyWorkflow, action } = loadE2eWorkflowContract();

  it("does not persist checkout credentials in the reusable runner", () => {
    const checkoutSteps = runnerWorkflow.jobs.run.steps.filter((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );

    expect(checkoutSteps).toHaveLength(2);
    for (const step of checkoutSteps) {
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("runs only validated test/e2e shell scripts through the composite action", () => {
    const runStep = action.runs.steps.find((step) => step.name === "Run E2E script");

    expect(runStep).toBeDefined();
    expect(runStep?.env?.E2E_SCRIPT).toBe("${{ inputs.script }}");
    expect(runStep?.run).toContain('case "$E2E_SCRIPT" in');
    expect(runStep?.run).toContain("test/e2e/*.sh");
    expect(runStep?.run).toContain('bash "$E2E_SCRIPT"');
    expect(runStep?.run).not.toContain('bash "${{ inputs.script }}"');
  });

  it("keeps the top-level legacy E2E bash script set frozen", () => {
    expect(listLegacyE2eShellScripts()).toEqual(LEGACY_E2E_SHELL_ALLOWLIST);
  });

  it("keeps scheduled nightly legacy E2E script wiring frozen and file-backed", () => {
    const nightlyScripts = collectLegacyE2eShellScriptRefs(nightlyWorkflow.jobs);

    expect(nightlyScripts).toEqual(NIGHTLY_E2E_SCRIPT_ALLOWLIST);
    for (const script of nightlyScripts) {
      expect(existsSync(new URL(`../${script}`, import.meta.url)), script).toBe(true);
    }
  });

  it("passes only named secrets to reusable nightly jobs", () => {
    const reusableJobs = reusableNightlyJobs(nightlyWorkflow);
    const defaultSecrets = {
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
      BRAVE_API_KEY: "${{ secrets.BRAVE_API_KEY }}",
      DOCKERHUB_USERNAME:
        "${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.DOCKERHUB_USERNAME || '' }}",
      DOCKERHUB_TOKEN:
        "${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.DOCKERHUB_TOKEN || '' }}",
    };
    const trustedRefGuard = "github.event_name != 'workflow_dispatch' || inputs.target_ref == ''";
    const messagingLiveSecrets = {
      TELEGRAM_BOT_TOKEN_REAL: `\${{ (${trustedRefGuard}) && secrets.TELEGRAM_BOT_TOKEN_REAL || '' }}`,
      TELEGRAM_CHAT_ID_E2E: `\${{ (${trustedRefGuard}) && secrets.TELEGRAM_CHAT_ID_E2E || '' }}`,
      DISCORD_BOT_TOKEN_REAL: `\${{ (${trustedRefGuard}) && secrets.DISCORD_BOT_TOKEN_REAL || '' }}`,
      DISCORD_CHANNEL_ID_E2E: `\${{ (${trustedRefGuard}) && secrets.DISCORD_CHANNEL_ID_E2E || '' }}`,
      SLACK_BOT_TOKEN_REAL: `\${{ (${trustedRefGuard}) && secrets.SLACK_BOT_TOKEN_REAL || '' }}`,
      SLACK_APP_TOKEN_REAL: `\${{ (${trustedRefGuard}) && secrets.SLACK_APP_TOKEN_REAL || '' }}`,
      SLACK_CHANNEL_ID_E2E: `\${{ (${trustedRefGuard}) && secrets.SLACK_CHANNEL_ID_E2E || '' }}`,
    };

    expect(reusableJobs.length).toBeGreaterThan(20);
    for (const [name, job] of reusableJobs) {
      const expectsLiveMessaging = name === "messaging-providers-e2e";
      const expectedSecrets = expectsLiveMessaging
        ? { ...defaultSecrets, ...messagingLiveSecrets }
        : defaultSecrets;
      expect(job.secrets, name).toEqual(expectedSecrets);
      expect(job.with?.messaging_live_secrets ?? false, name).toBe(
        expectsLiveMessaging
          ? "${{ github.event_name != 'workflow_dispatch' || inputs.target_ref == '' }}"
          : false,
      );
    }
  });

  it("requires trusted target refs and an explicit opt-in before exposing live messaging secrets", () => {
    const callInputs =
      runnerWorkflow.on?.workflow_call?.inputs ?? runnerWorkflow.true?.workflow_call?.inputs ?? {};
    const runStep = runnerWorkflow.jobs.run.steps.find((step) => step.name === "Run E2E script");
    const messagingJob = nightlyWorkflow.jobs["messaging-providers-e2e"];

    expect(callInputs.messaging_live_secrets?.default).toBe(false);
    expect(messagingJob.with?.messaging_live_secrets).toBe(
      "${{ github.event_name != 'workflow_dispatch' || inputs.target_ref == '' }}",
    );
    for (const name of [
      "TELEGRAM_BOT_TOKEN_REAL",
      "TELEGRAM_CHAT_ID_E2E",
      "DISCORD_BOT_TOKEN_REAL",
      "DISCORD_CHANNEL_ID_E2E",
      "SLACK_BOT_TOKEN_REAL",
      "SLACK_APP_TOKEN_REAL",
      "SLACK_CHANNEL_ID_E2E",
    ]) {
      expect(messagingJob.secrets?.[name], name).toBe(
        `\${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.${name} || '' }}`,
      );
    }
    expect(runStep?.env?.TELEGRAM_BOT_TOKEN_REAL).toBe(
      "${{ inputs.messaging_live_secrets && secrets.TELEGRAM_BOT_TOKEN_REAL || '' }}",
    );
    expect(runStep?.env?.DISCORD_BOT_TOKEN_REAL).toBe(
      "${{ inputs.messaging_live_secrets && secrets.DISCORD_BOT_TOKEN_REAL || '' }}",
    );
    expect(runStep?.env?.SLACK_BOT_TOKEN_REAL).toBe(
      "${{ inputs.messaging_live_secrets && secrets.SLACK_BOT_TOKEN_REAL || '' }}",
    );
    expect(runStep?.env?.SLACK_APP_TOKEN_REAL).toBe(
      "${{ inputs.messaging_live_secrets && secrets.SLACK_APP_TOKEN_REAL || '' }}",
    );
  });

  it("authenticates Docker Hub pulls without exposing credentials to target-ref dispatches", () => {
    const authStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Authenticate to Docker Hub",
    );

    expect(authStep?.if).toBe(
      "${{ github.event_name != 'workflow_dispatch' || github.event.inputs.target_ref == '' }}",
    );
    expect(authStep?.env?.DOCKERHUB_USERNAME).toBe("${{ secrets.DOCKERHUB_USERNAME }}");
    expect(authStep?.env?.DOCKERHUB_TOKEN).toBe("${{ secrets.DOCKERHUB_TOKEN }}");
    expect(authStep?.run).toContain("docker login docker.io");
    expect(authStep?.run).toContain("for attempt in 1 2 3");
    expect(authStep?.run).toContain("timeout 30s docker login");
    expect(authStep?.run).toContain("Docker Hub login failed after 3 attempts");
    expect(authStep?.run).toContain("continuing with anonymous pulls");
  });

  it("authenticates Docker Hub pulls in direct nightly E2E jobs", () => {
    const directE2eJobs = [
      "docs-validation-e2e",
      "openclaw-tui-chat-correlation-e2e",
      "issue-3600-gpu-proof-optional-e2e",
      "kimi-inference-compat-e2e",
      "bedrock-runtime-compatible-anthropic-e2e",
      "token-rotation-e2e",
      "sandbox-operations-e2e",
      "openshell-gateway-upgrade-e2e",
      "double-onboard-e2e",
      "onboard-repair-e2e",
      "onboard-resume-e2e",
      "onboard-negative-paths-e2e",
      "runtime-overrides-e2e",
      "credential-sanitization-e2e",
      "telegram-injection-e2e",
      "launchable-smoke-e2e",
      "gpu-e2e",
      "gpu-double-onboard-e2e",
    ];

    for (const name of directE2eJobs) {
      const checkoutStep = nightlyWorkflow.jobs[name].steps?.find((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      const authStep = nightlyWorkflow.jobs[name].steps?.find(
        (step) => step.name === "Authenticate to Docker Hub",
      );

      expect(checkoutStep?.with?.ref, name).toBe("${{ inputs.target_ref || github.ref }}");
      expect(checkoutStep?.with?.["persist-credentials"], name).toBe(false);
      expect(authStep, name).toBeDefined();
      expect(authStep?.if, name).toBe(
        "${{ github.event_name != 'workflow_dispatch' || inputs.target_ref == '' }}",
      );
      expect(authStep?.env?.DOCKERHUB_USERNAME, name).toBe(
        "${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.DOCKERHUB_USERNAME || '' }}",
      );
      expect(authStep?.env?.DOCKERHUB_TOKEN, name).toBe(
        "${{ (github.event_name != 'workflow_dispatch' || inputs.target_ref == '') && secrets.DOCKERHUB_TOKEN || '' }}",
      );
      expect(authStep?.run, name).toContain("docker login docker.io");
      expect(authStep?.run, name).toContain("for attempt in 1 2 3");
      expect(authStep?.run, name).toContain("timeout 30s docker login");
      expect(authStep?.run, name).toContain("Docker Hub login failed after 3 attempts");
      expect(authStep?.run, name).not.toContain("persist-credentials:");
      expect(authStep?.run, name).not.toContain("uses:");
      expect(authStep?.run, name).not.toContain("with:");
    }
  });

  it("validates env_json keys before writing GITHUB_ENV", () => {
    const exportStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Export script environment",
    );

    expect(exportStep?.run).toContain('name_pattern = re.compile(r"^[A-Z_][A-Z0-9_]*$")');
    expect(exportStep?.run).toContain(
      'reserved_prefixes = ("ACTIONS_", "GITHUB_", "INPUT_", "RUNNER_")',
    );
    expect(exportStep?.run).toContain('reserved_names = {"CI", "HOME", "PATH", "PWD", "SHELL"}');
    expect(exportStep?.run).toContain('delimiter = f"EOF_{secrets.token_hex(16)}"');
  });

  it("keeps env_json valid and aligned with target-ref installs", () => {
    const reusableJobs = reusableNightlyJobs(nightlyWorkflow);

    for (const [name, job] of reusableJobs) {
      const envJson = job.with?.env_json;
      if (envJson === undefined) {
        continue;
      }
      const parsed = JSON.parse(envJson) as Record<string, unknown>;
      expect(Object.keys(parsed).length, name).toBeGreaterThan(0);
      if (parsed.NEMOCLAW_INSTALL_REF !== undefined) {
        expect(parsed.NEMOCLAW_INSTALL_REF, name).toBe("${{ inputs.target_ref || github.ref }}");
      }
      expect(parsed.NEMOCLAW_PUBLIC_INSTALL_REF, name).toBeUndefined();
    }
  });

  it("exports checked-out commit SHAs for reusable public-installer jobs", () => {
    const publicInstallerJob = nightlyWorkflow.jobs["cloud-onboard-e2e"];
    const exportStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Export checked-out ref environment",
    );

    expect(publicInstallerJob.with?.checked_out_ref_env).toBe("NEMOCLAW_PUBLIC_INSTALL_REF");
    expect(exportStep?.env?.E2E_CHECKED_OUT_REF_ENV).toBe("${{ inputs.checked_out_ref_env }}");
    expect(exportStep?.run).toContain('[[ ! "$E2E_CHECKED_OUT_REF_ENV" =~ ^[A-Z_][A-Z0-9_]*$ ]]');
    expect(exportStep?.run).toContain("git -C repo rev-parse HEAD");
    expect(exportStep?.run).toContain('>> "$GITHUB_ENV"');
  });

  it("keeps converted jobs dispatchable through the reusable workflow", () => {
    const cloudJob = nightlyWorkflow.jobs["cloud-e2e"];

    expect(cloudJob).toBeDefined();
    expect(cloudJob.uses).toBe("./.github/workflows/e2e-script.yaml");
    expect(cloudJob.with?.script).toBe("test/e2e/test-full-e2e.sh");
    expect(cloudJob.with?.ref).toBe("${{ inputs.target_ref || github.ref }}");
  });

  it("gates WhatsApp sandbox-owned preload acceptance on non-root entrypoint evidence", () => {
    const script = readFileSync(
      new URL("./e2e/test-messaging-providers.sh", import.meta.url),
      "utf8",
    );

    expect(script).toContain(
      "entrypoint_start_log_stat=$(sandbox_exec \"stat -c '%U:%a' /tmp/nemoclaw-start.log",
    );
    expect(script).toContain(
      '[ "$whatsapp_qr_preload_stat" = "sandbox:444" ] && [ "$entrypoint_start_log_stat" = "sandbox:600" ]',
    );
    expect(script).toContain("entrypoint start log: ${entrypoint_start_log_stat}");
  });
});
