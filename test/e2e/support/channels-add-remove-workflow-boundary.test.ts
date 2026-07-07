// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

describe("channels add/remove workflow boundary", () => {
  it("keeps channels add/remove on its authenticated local inference fixture", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          env: Record<string, unknown>;
          steps: Array<{ env?: Record<string, unknown>; name?: string }>;
        }
      >;
    };
    const job = workflow.jobs["channels-add-remove"];
    job.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE = "1";
    const runStep = job.steps.find((step) => step.name === "Run channels add/remove live test")!;
    runStep.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "channels-add-remove job must leave NEMOCLAW_E2E_USE_HOSTED_INFERENCE unset for its local inference fixture",
          "channels-add-remove step 'Run channels add/remove live test' env must not include NVIDIA_INFERENCE_API_KEY",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
