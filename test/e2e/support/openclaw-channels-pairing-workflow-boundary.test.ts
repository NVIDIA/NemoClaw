// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("OpenClaw channels pairing workflow boundary", () => {
  it("rejects workspace Docker auth, secret, checkout, and installer drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    const parsedWorkflow = YAML.parse(workflow) as {
      jobs: Record<
        string,
        {
          env: Record<string, string>;
          steps: Array<Record<string, unknown>>;
        }
      >;
    };
    const pairingJob = parsedWorkflow.jobs["openclaw-channels-pairing"];
    pairingJob.env.DOCKER_CONFIG =
      "${{ github.workspace }}/.docker-config-openclaw-channels-pairing";
    const checkout = pairingJob.steps.find((step) =>
      String(step.uses).startsWith("actions/checkout@"),
    ) as { uses: string; with: Record<string, unknown> };
    checkout.uses = "actions/checkout@v4";
    checkout.with["persist-credentials"] = true;
    const liveStep = pairingJob.steps.find(
      (step) => step.name === "Run OpenClaw channels pairing live tests",
    ) as { env: Record<string, string> };
    liveStep.env.DISCORD_BOT_TOKEN = "real-ish-token";
    liveStep.env.SLACK_BOT_TOKEN = "real-ish-token";
    liveStep.env.SLACK_APP_TOKEN = "real-ish-token";
    const installOpenShell = pairingJob.steps.find(
      (step) => step.name === "Install OpenShell CLI",
    ) as Record<string, unknown>;
    Object.assign(installOpenShell, { run: "bash scripts/install-openshell.sh" });
    fs.writeFileSync(workflowPath, YAML.stringify(parsedWorkflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "openclaw-channels-pairing job must not set DOCKER_CONFIG at job level",
          "openclaw-channels-pairing checkout action must be pinned to a full commit SHA",
          "openclaw-channels-pairing checkout step must set persist-credentials=false",
          "openclaw-channels-pairing step must use fake Discord token",
          "openclaw-channels-pairing step must use fake Slack bot token",
          "openclaw-channels-pairing step must use fake Slack app token",
          "step 'Install OpenShell CLI' run script must include env -u DOCKER_CONFIG",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
