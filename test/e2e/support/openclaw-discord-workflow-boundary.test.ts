// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("OpenClaw Discord pairing workflow boundary", () => {
  it("rejects workspace Docker auth and unpinned checkout drift", () => {
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
    fs.writeFileSync(workflowPath, YAML.stringify(parsedWorkflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "openclaw-discord-pairing job env must not include DOCKER_CONFIG",
          "openclaw-discord-pairing step 'actions/checkout@v4' action must be pinned to a full commit SHA",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
