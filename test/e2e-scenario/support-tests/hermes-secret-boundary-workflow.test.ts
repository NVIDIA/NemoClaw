// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

it("routes Hermes sandbox secret-boundary selective dispatch to its free-standing Vitest job", () => {
  const inventory = readFreeStandingJobsInventory();

  expect(inventory.allowedJobs).toContain("hermes-sandbox-secret-boundary-vitest");
  expect(inventory.scenarioToJob.get("hermes-sandbox-secret-boundary")).toBe(
    "hermes-sandbox-secret-boundary-vitest",
  );
  expect(
    evaluateE2eVitestWorkflowDispatchSelectors({
      scenarios: "hermes-sandbox-secret-boundary",
    }),
  ).toMatchObject({
    valid: true,
    liveScenariosRuns: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary-vitest"],
    registryScenarios: [],
  });
  expect(
    evaluateE2eVitestWorkflowDispatchSelectors({
      jobs: "hermes-sandbox-secret-boundary-vitest",
    }),
  ).toMatchObject({
    valid: true,
    liveScenariosRuns: false,
    selectedFreeStandingJobs: ["hermes-sandbox-secret-boundary-vitest"],
    registryScenarios: [],
  });
});

it("rejects Hermes sandbox secret-boundary workflow secret and Docker-auth drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-secret-boundary-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as {
    jobs: Record<string, { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }>;
  };
  const job = workflow.jobs["hermes-sandbox-secret-boundary-vitest"];
  expect(job).toBeDefined();

  job.env = {
    ...job.env,
    NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
    DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
  };
  job.steps.splice(1, 0, {
    name: "Authenticate to Docker Hub",
    env: {
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    },
    run: "docker login docker.io --username $DOCKERHUB_USERNAME --password $DOCKERHUB_TOKEN",
  });
  const runVitest = job.steps.find(
    (step) => step.name === "Run Hermes sandbox secret-boundary live test",
  );
  expect(runVitest).toBeDefined();
  runVitest!.env = {
    NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
  };
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));

  try {
    expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toEqual(
      expect.arrayContaining([
        "hermes-sandbox-secret-boundary-vitest job env must not include NVIDIA_INFERENCE_API_KEY",
        "hermes-sandbox-secret-boundary-vitest job env must not include DOCKERHUB_USERNAME",
        "hermes-sandbox-secret-boundary-vitest job env must not include DOCKERHUB_TOKEN",
        "hermes-sandbox-secret-boundary-vitest must not authenticate to Docker Hub before branch-controlled test code runs",
        "hermes-sandbox-secret-boundary-vitest step 'Authenticate to Docker Hub' env must not include DOCKERHUB_USERNAME",
        "hermes-sandbox-secret-boundary-vitest step 'Authenticate to Docker Hub' env must not include DOCKERHUB_TOKEN",
        "hermes-sandbox-secret-boundary-vitest step 'Authenticate to Docker Hub' run script must not use docker login or inline secret interpolation",
        "hermes-sandbox-secret-boundary-vitest step 'Run Hermes sandbox secret-boundary live test' env must not include NVIDIA_INFERENCE_API_KEY",
      ]),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
