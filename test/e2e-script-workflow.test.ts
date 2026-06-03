// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadE2eWorkflowContract, reusableNightlyJobs } from "./helpers/e2e-workflow-contract";

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
    const messagingLiveSecrets = {
      TELEGRAM_BOT_TOKEN_REAL: "${{ secrets.TELEGRAM_BOT_TOKEN_REAL }}",
      TELEGRAM_CHAT_ID_E2E: "${{ secrets.TELEGRAM_CHAT_ID_E2E }}",
      DISCORD_BOT_TOKEN_REAL: "${{ secrets.DISCORD_BOT_TOKEN_REAL }}",
      DISCORD_CHANNEL_ID_E2E: "${{ secrets.DISCORD_CHANNEL_ID_E2E }}",
      SLACK_BOT_TOKEN_REAL: "${{ secrets.SLACK_BOT_TOKEN_REAL }}",
      SLACK_APP_TOKEN_REAL: "${{ secrets.SLACK_APP_TOKEN_REAL }}",
      SLACK_CHANNEL_ID_E2E: "${{ secrets.SLACK_CHANNEL_ID_E2E }}",
    };

    expect(reusableJobs.length).toBeGreaterThan(20);
    for (const [name, job] of reusableJobs) {
      const expectedSecrets =
        name === "messaging-providers-e2e"
          ? { ...defaultSecrets, ...messagingLiveSecrets }
          : defaultSecrets;
      expect(job.secrets, name).toEqual(expectedSecrets);
    }
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
    expect(exportStep?.env?.E2E_CHECKED_OUT_REF_ENV).toBe(
      "${{ inputs.checked_out_ref_env }}",
    );
    expect(exportStep?.run).toContain('[[ ! "$E2E_CHECKED_OUT_REF_ENV" =~ ^[A-Z_][A-Z0-9_]*$ ]]');
    expect(exportStep?.run).toContain('git -C repo rev-parse HEAD');
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
    const script = readFileSync(new URL("./e2e/test-messaging-providers.sh", import.meta.url), "utf8");

    expect(script).toContain(
      "entrypoint_start_log_stat=$(sandbox_exec \"stat -c '%U:%a' /tmp/nemoclaw-start.log",
    );
    expect(script).toContain(
      "[ \"$whatsapp_qr_preload_stat\" = \"sandbox:444\" ] && [ \"$entrypoint_start_log_stat\" = \"sandbox:600\" ]",
    );
    expect(script).toContain("entrypoint start log: ${entrypoint_start_log_stat}");
  });
});
