// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

it("routes Hermes sandbox secret-boundary selective dispatch to its free-standing E2E job", () => {
  const inventory = readFreeStandingJobsInventory();

  expect(inventory.allowedJobs).toContain("hermes-sandbox-secret-boundary");
  expect(inventory.targetToJob.get("hermes-sandbox-secret-boundary")).toBe(
    "hermes-sandbox-secret-boundary",
  );
  expect(
    evaluateE2eWorkflowDispatchSelectors({
      targets: "hermes-sandbox-secret-boundary",
    }),
  ).toMatchObject({
    valid: true,
    liveTargetsRun: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary"],
    registryTargets: [],
  });
  expect(
    evaluateE2eWorkflowDispatchSelectors({
      jobs: "hermes-sandbox-secret-boundary",
    }),
  ).toMatchObject({
    valid: true,
    liveTargetsRun: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary"],
    registryTargets: [],
  });
});

it("rejects broad Hermes sandbox secret-boundary workflow secret scope", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-secret-boundary-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<string, { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }>;
  };
  const job = workflow.jobs["hermes-sandbox-secret-boundary"];
  expect(job).toBeDefined();

  job.env = {
    ...job.env,
    NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
    DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
  };
  const runVitest = job.steps.find(
    (step) => step.name === "Run Hermes sandbox secret-boundary live test",
  );
  expect(runVitest).toBeDefined();
  runVitest!.env = {
    NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
  };
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "hermes-sandbox-secret-boundary job env must not include NVIDIA_INFERENCE_API_KEY",
        "hermes-sandbox-secret-boundary job env must not include DOCKERHUB_USERNAME",
        "hermes-sandbox-secret-boundary job env must not include DOCKERHUB_TOKEN",
        "hermes-sandbox-secret-boundary step 'Run Hermes sandbox secret-boundary live test' env must not include NVIDIA_INFERENCE_API_KEY",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
