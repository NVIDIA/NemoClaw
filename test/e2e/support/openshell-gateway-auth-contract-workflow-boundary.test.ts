// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { UPLOAD_E2E_ARTIFACTS_ACTION } from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
};

function workflowJobs(): Record<string, WorkflowJob> {
  return (readWorkflow().jobs ?? {}) as Record<string, WorkflowJob>;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return job.steps?.find((step) => step.name === name);
}

describe("OpenShell gateway auth contract workflow boundary", () => {
  it("keeps the resource-heavy auth contract explicit-only", () => {
    const inventory = readFreeStandingJobsInventory();

    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-gateway-auth-contract");
    expect(inventory.explicitOnlyJobs).toContain("openshell-gateway-auth-contract");
    expect(inventory.targetToJob.get("openshell-gateway-auth-contract")).toBe(
      "openshell-gateway-auth-contract",
    );
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).not.toContain(
      "openshell-gateway-auth-contract",
    );
  });

  it("runs the auth contract when explicitly selected by target or job", () => {
    for (const selector of [
      { targets: "openshell-gateway-auth-contract" },
      { jobs: "openshell-gateway-auth-contract" },
    ]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openshell-gateway-auth-contract"],
        registryTargets: [],
      });
    }
  });

  it("keeps checkout credential-free and runs the unified live test with pinned inputs", () => {
    const job = workflowJobs()["openshell-gateway-auth-contract"];
    expect(job).toBeDefined();
    expect(job.needs).toBe("generate-matrix");
    expect(job.env).toMatchObject({
      E2E_JOB: "1",
      E2E_DEFAULT_ENABLED: "0",
      E2E_TARGET_ID: "openshell-gateway-auth-contract",
      E2E_ARTIFACT_DIR:
        "${{ github.workspace }}/e2e-artifacts/live/openshell-gateway-auth-contract",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.72",
      DOCKER_GRPC_PROBE_IMAGE:
        "node:22-trixie-slim@sha256:2d9f5c76c8f4dd36e8f253bee5d828a83a6c09f36188f0b0414325232e0b175d",
    });

    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);

    const install = namedStep(job, "Install OpenShell CLI");
    expect(install?.run).toContain("env -u DOCKER_CONFIG");
    expect(install?.run).toContain("-u GITHUB_TOKEN");
    expect(install?.run).toContain("bash scripts/install-openshell.sh");

    const run = namedStep(job, "Run OpenShell gateway auth contract live test");
    expect(run?.run).toContain("npx vitest run --project e2e-live");
    expect(run?.run).toContain("test/e2e/live/openshell-gateway-auth-source-contract.test.ts");

    const upload = namedStep(job, "Upload OpenShell gateway auth contract artifacts");
    expect(upload?.if).toBe("always()");
    expect(upload?.uses).toBe(UPLOAD_E2E_ARTIFACTS_ACTION);
    expect(upload?.with).toBeUndefined();
  });

  it("waits for the auth contract in every aggregate result job", () => {
    const jobs = workflowJobs();
    for (const aggregate of ["report-to-pr", "scorecard"]) {
      expect(jobs[aggregate]?.needs).toContain("openshell-gateway-auth-contract");
    }
  });
});
