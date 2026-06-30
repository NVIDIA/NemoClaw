// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("OpenClaw Discord pairing workflow boundary", () => {
  it("rejects secret, checkout, dependency, build, and installer drift", () => {
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
    const discordJob = parsedWorkflow.jobs["openclaw-discord-pairing"];
    discordJob.env.DOCKER_CONFIG =
      "${{ github.workspace }}/.docker-config-openclaw-discord-pairing";
    const checkout = discordJob.steps.find((step) =>
      String(step.uses).startsWith("actions/checkout@"),
    ) as { uses: string; with: Record<string, unknown> };
    checkout.uses = "actions/checkout@v4";
    checkout.with["persist-credentials"] = true;
    const setupNode = discordJob.steps.find((step) => step.name === "Set up Node") as {
      uses: string;
    };
    setupNode.uses = "actions/setup-node@v4";
    const installRootDependencies = discordJob.steps.find(
      (step) => step.name === "Install root dependencies",
    ) as Record<string, unknown>;
    Object.assign(installRootDependencies, { run: "npm install" });
    const buildCli = discordJob.steps.find((step) => step.name === "Build CLI") as Record<
      string,
      unknown
    >;
    Object.assign(buildCli, { run: "echo skipping build" });
    const installOpenShell = discordJob.steps.find(
      (step) => step.name === "Install OpenShell CLI",
    ) as Record<string, unknown>;
    Object.assign(installOpenShell, { run: "bash scripts/install-openshell.sh" });
    fs.writeFileSync(workflowPath, YAML.stringify(parsedWorkflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "openclaw-discord-pairing job must not set DOCKER_CONFIG at job level",
          "openclaw-discord-pairing checkout action must be pinned to a full commit SHA",
          "openclaw-discord-pairing checkout step must set persist-credentials=false",
          "openclaw-discord-pairing setup-node action must be pinned to a full commit SHA",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "step 'Build CLI' run script must include npm run build:cli",
          "step 'Install OpenShell CLI' run script must include env -u DOCKER_CONFIG",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
