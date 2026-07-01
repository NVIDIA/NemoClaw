// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("channels lifecycle workflow boundary", () => {
  it("rejects OpenClaw channels stop/start workflow-boundary drift for secret and artifact handling", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          env: Record<string, unknown>;
          steps: Array<Record<string, unknown>>;
          "timeout-minutes"?: number;
        }
      >;
    };
    const job = workflow.jobs["openclaw-channels-stop-start"];
    expect(job).toBeDefined();
    job["timeout-minutes"] = 45;
    job.env.NEMOCLAW_SANDBOX_NAME = "personal-dev";
    job.env.DOCKER_CONFIG = "${{ github.workspace }}/.docker-config-shared";
    job.env.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    const checkoutStep = job.steps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    expect(checkoutStep).toBeDefined();
    checkoutStep!.with = {
      ...(checkoutStep!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const installOpenShellStep = job.steps.find((step) => step.name === "Install OpenShell");
    expect(installOpenShellStep).toBeDefined();
    installOpenShellStep!.run = "bash scripts/install-openshell.sh";

    const runStep = job.steps.find(
      (step) => step.name === "Run OpenClaw channels stop/start live test",
    );
    expect(runStep).toBeDefined();
    runStep!.env = {
      TELEGRAM_BOT_TOKEN: "real-token",
    };
    runStep!.run = String(runStep!.run).replace(
      "test/e2e/live/openclaw-channels-stop-start.test.ts",
      "test/e2e/live/hermes-channels-stop-start.test.ts",
    );

    const uploadStep = job.steps.find(
      (step) => step.name === "Upload OpenClaw channels stop/start artifacts",
    );
    expect(uploadStep).toBeDefined();
    uploadStep!.uses = "actions/upload-artifact@v4";
    uploadStep!.with = {
      ...(uploadStep!.with as Record<string, unknown>),
      name: "bad-channels-upload",
      path: "e2e-artifacts/live/bad-channels-upload/",
      "include-hidden-files": true,
      "retention-days": 1,
    };

    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "openclaw-channels-stop-start job must keep the 90 minute timeout",
          "openclaw-channels-stop-start job env NEMOCLAW_SANDBOX_NAME must be e2e-openclaw-channels-stop-start",
          "openclaw-channels-stop-start job must not set DOCKER_CONFIG at job level",
          "openclaw-channels-stop-start job env must not include NVIDIA_INFERENCE_API_KEY",
          "openclaw-channels-stop-start checkout step must set persist-credentials=false",
          "step 'Install OpenShell' run script must include env -u DOCKER_CONFIG",
          "openclaw-channels-stop-start step must receive NVIDIA_INFERENCE_API_KEY from secrets",
          "openclaw-channels-stop-start step must set fake TELEGRAM_BOT_TOKEN",
          "openclaw-channels-stop-start step must set fake DISCORD_BOT_TOKEN",
          "openclaw-channels-stop-start step must set fake MSTEAMS_APP_PASSWORD",
          "step 'Run OpenClaw channels stop/start live test' run script must include test/e2e/live/openclaw-channels-stop-start.test.ts",
          "openclaw-channels-stop-start upload-artifact action must be pinned to a full commit SHA",
          "openclaw-channels-stop-start artifact upload name must be stable",
          "openclaw-channels-stop-start artifact upload must set include-hidden-files: false",
          "openclaw-channels-stop-start artifact upload retention-days must be 14",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
