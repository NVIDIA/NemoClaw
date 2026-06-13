// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadE2eWorkflowContract,
  readYaml,
  reusableNightlyJobs,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

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
];

// Scheduled nightly wiring is frozen separately: retiring a nightly-wired legacy
// script should remove it from nightly and this allowlist in the same PR that
// deletes the script.
const RETIRED_VM_DRIVER_PRIVEXEC_JOB = "vm-driver-privileged-exec-routing-e2e";
const VM_DRIVER_PRIVEXEC_VITEST = "test/vm-driver-privileged-exec-routing.test.ts";

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
  "test/e2e/test-credential-sanitization.sh",
  "test/e2e/test-cron-preflight-inference-local-e2e.sh",
  "test/e2e/test-device-auth-health.sh",
  "test/e2e/test-diagnostics.sh",
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

  it("does not persist checkout credentials in sandbox image E2E jobs", () => {
    const sandboxWorkflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
      ".github/workflows/sandbox-images-and-e2e.yaml",
    );

    for (const [jobName, job] of Object.entries(sandboxWorkflow.jobs)) {
      const checkoutStep = job.steps?.find((step) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );
      if (!checkoutStep) continue;

      expect(checkoutStep.with?.["persist-credentials"], jobName).toBe(false);
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

  it("keeps the unwired VM driver privileged-exec lane covered by CLI Vitest", () => {
    const { cliCoverageShardAction } = loadE2eWorkflowContract();
    const runStepNames = cliCoverageShardAction.runs.steps.map((step) => step.name);
    const cliShardRunStep = cliCoverageShardAction.runs.steps.find(
      (step) => step.name === "Run CLI coverage shard",
    );

    expect(nightlyWorkflow.jobs[RETIRED_VM_DRIVER_PRIVEXEC_JOB]).toBeUndefined();
    expect(collectLegacyE2eShellScriptRefs(nightlyWorkflow)).not.toContain(
      "test/e2e/test-vm-driver-privileged-exec-routing.sh",
    );
    expect(
      existsSync(new URL("./e2e/test-vm-driver-privileged-exec-routing.sh", import.meta.url)),
    ).toBe(true);
    expect(existsSync(new URL(`../${VM_DRIVER_PRIVEXEC_VITEST}`, import.meta.url))).toBe(true);
    expect(VM_DRIVER_PRIVEXEC_VITEST).toMatch(/^test\/.*\.test\.ts$/);
    expect(runStepNames).toContain("Run CLI coverage shard");
    expect(cliShardRunStep?.run?.split("\n").map((line) => line.trim())).toEqual(
      expect.arrayContaining([
        "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
        "npm run build:cli",
        "npx tsx scripts/check-dist-sourcemaps.ts dist",
        "npx vitest run --project cli \\",
      ]),
    );
  });

  it("passes only named secrets to reusable nightly jobs", () => {
    const reusableJobs = reusableNightlyJobs(nightlyWorkflow);
    const defaultSecrets = {
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
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

  it("runs docs validation directly through Vitest artifacts", () => {
    const job = nightlyWorkflow.jobs["docs-validation-e2e"];
    const checkoutStep = job.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const authStep = job.steps?.find((step) => step.name === "Authenticate to Docker Hub");
    const installStep = job.steps?.find((step) => step.name === "Install root dependencies");
    const setupNodeStep = job.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/setup-node@"),
    );
    const runStep = job.steps?.find((step) => step.name === "Run docs validation Vitest test");
    const uploadStep = job.steps?.find((step) => step.name === "Upload docs validation artifacts");

    expect(checkoutStep?.with?.ref).toBe("${{ inputs.target_ref || github.ref }}");
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(authStep).toBeUndefined();
    expect(setupNodeStep?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(setupNodeStep?.with?.cache).toBe("npm");
    expect(installStep?.run).toBe("npm ci --ignore-scripts");
    expect(runStep?.run).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runStep?.run).toContain("test/e2e-scenario/live/docs-validation.test.ts");
    expect(runStep?.run).not.toContain("test/e2e/test-docs-validation.sh");
    expect(runStep?.env?.CHECK_DOC_LINKS_REMOTE).toBe("0");
    expect(runStep?.env?.NEMOCLAW_RUN_E2E_SCENARIOS).toBe("1");
    expect(runStep?.env?.E2E_ARTIFACT_DIR).toBe(
      "${{ github.workspace }}/e2e-artifacts/vitest/docs-validation",
    );
    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.with?.path).toBe("e2e-artifacts/vitest/docs-validation/");
    expect(uploadStep?.with?.["include-hidden-files"]).toBe(false);
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("ignore");
    expect(uploadStep?.with?.["retention-days"]).toBe(14);
  });

  it("runs credential migration on the former shell runner through Vitest artifacts", () => {
    const job = nightlyWorkflow.jobs["credential-migration-e2e"];
    const checkoutStep = job.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const authStep = job.steps?.find((step) => step.name === "Authenticate to Docker Hub");
    const installStep = job.steps?.find((step) => step.name === "Install root dependencies");
    const buildStep = job.steps?.find((step) => step.name === "Build CLI");
    const setupNodeStep = job.steps?.find((step) =>
      String(step.uses ?? "").startsWith("actions/setup-node@"),
    );
    const runStep = job.steps?.find((step) => step.name === "Run credential migration Vitest test");
    const uploadStep = job.steps?.find(
      (step) => step.name === "Upload credential migration artifacts",
    );

    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(50);
    expect(checkoutStep?.with?.ref).toBe("${{ inputs.target_ref || github.ref }}");
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(authStep).toBeDefined();
    expect(setupNodeStep?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    expect(setupNodeStep?.with?.cache).toBe("npm");
    expect(installStep?.run).toBe("npm ci --ignore-scripts");
    expect(buildStep?.run).toBe("npm run build:cli");
    expect(runStep?.run).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runStep?.run).toContain("test/e2e-scenario/live/credential-migration.test.ts");
    expect(runStep?.run).not.toContain("test/e2e/test-credential-migration.sh");
    expect(runStep?.env?.NVIDIA_INFERENCE_API_KEY).toBe("${{ secrets.NVIDIA_INFERENCE_API_KEY }}");
    expect(runStep?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(runStep?.env?.NEMOCLAW_RUN_E2E_SCENARIOS).toBe("1");
    expect(runStep?.env?.NEMOCLAW_SANDBOX_NAME).toBe("e2e-cred-migration");
    expect(runStep?.env?.E2E_ARTIFACT_DIR).toBe(
      "${{ github.workspace }}/e2e-artifacts/vitest/credential-migration",
    );
    expect(uploadStep?.if).toBe("always()");
    expect(uploadStep?.with?.path).toBe("e2e-artifacts/vitest/credential-migration/");
    expect(uploadStep?.with?.["include-hidden-files"]).toBe(false);
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("ignore");
    expect(uploadStep?.with?.["retention-days"]).toBe(14);
  });

  it("authenticates Docker Hub pulls in direct nightly E2E jobs", () => {
    const directE2eJobs = [
      "openclaw-tui-chat-correlation-e2e",
      "issue-3600-gpu-proof-optional-e2e",
      "kimi-inference-compat-e2e",
      "bedrock-runtime-compatible-anthropic-e2e",
      "token-rotation-e2e",
      "sandbox-operations-e2e",
      "credential-migration-e2e",
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

  it("can route selected reusable jobs through the CI compatible inference endpoint", () => {
    const exportStep = runnerWorkflow.jobs.run.steps.find(
      (step) => step.name === "Export CI compatible inference environment",
    );
    const expectedJobs = ["cloud-e2e", "cloud-onboard-e2e", "cloud-inference-e2e"];
    const workflowCall = runnerWorkflow.on?.workflow_call ?? runnerWorkflow.true?.workflow_call;

    expect(workflowCall?.inputs?.nvidia_secret_as_compatible_api_key).toMatchObject({
      required: false,
      type: "boolean",
      default: false,
    });
    expect(exportStep?.if).toBe("${{ inputs.nvidia_secret_as_compatible_api_key }}");
    expect(exportStep?.env?.NVIDIA_INFERENCE_API_KEY).toBe(
      "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    );
    expect(exportStep?.run).toContain("NEMOCLAW_E2E_USE_NVIDIA_SECRET_AS_COMPATIBLE=1");
    expect(exportStep?.run).toContain("NEMOCLAW_PROVIDER=custom");
    expect(exportStep?.run).toContain("NEMOCLAW_ENDPOINT_URL=https://inference-api.nvidia.com/v1");
    expect(exportStep?.run).toContain("NEMOCLAW_MODEL=nvidia/nvidia/nemotron-3-super-v3");
    expect(exportStep?.run).toContain("NEMOCLAW_COMPAT_MODEL=nvidia/nvidia/nemotron-3-super-v3");
    expect(exportStep?.run).toContain("COMPATIBLE_API_KEY=%s");

    for (const name of expectedJobs) {
      expect(nightlyWorkflow.jobs[name].with?.nvidia_secret_as_compatible_api_key, name).toBe(true);
    }
  });

  it("routes legacy token rotation through the CI compatible inference endpoint", () => {
    const runStep = nightlyWorkflow.jobs["token-rotation-e2e"].steps?.find(
      (step) => step.name === "Run token rotation E2E test",
    );
    const script = readFileSync(new URL("./e2e/test-token-rotation.sh", import.meta.url), "utf8");

    expect(runStep?.env?.NVIDIA_INFERENCE_API_KEY).toBe("${{ secrets.NVIDIA_INFERENCE_API_KEY }}");
    expect(runStep?.env?.NEMOCLAW_E2E_USE_NVIDIA_SECRET_AS_COMPATIBLE).toBe("1");
    expect(script).toContain("lib/ci-compatible-inference.sh");
    expect(script).toContain("nemoclaw_e2e_configure_compatible_inference");
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
