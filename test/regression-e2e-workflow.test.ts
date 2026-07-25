// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PREPARE_E2E_ACTION,
  PREPARE_E2E_STEP,
} from "../tools/e2e/prepare-e2e-workflow-boundary.mts";
import { readYaml, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type RegressionWorkflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        jobs?: {
          description?: string;
        };
      };
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
      "timeout-minutes"?: number;
      uses?: string;
    }
  >;
};

const FULL_SHA_ACTION = /@[0-9a-f]{40}$/i;

function preparedVitestJobs(workflow: RegressionWorkflow) {
  return Object.entries(workflow.jobs ?? {}).filter(([, job]) => {
    const steps = job.steps ?? [];
    const invokesVitest = steps.some((step) => /\bvitest\s+run\b/.test(step.run ?? ""));
    const usesDirectSetup = steps.some((step) => step.name === "Setup Node");
    return invokesVitest && !usesDirectSetup;
  });
}

describe("Regression E2E workflow contract", () => {
  const workflow = readYaml<RegressionWorkflow>(".github/workflows/regression-e2e.yaml");
  const branchValidation = readYaml<RegressionWorkflow>(
    ".github/workflows/e2e-branch-validation.yaml",
  );

  // source-shape-contract: compatibility -- Keeps the executable WhatsApp regression on the supported Vitest live runner
  it("runs WhatsApp compact QR through Vitest instead of the retired shell script", () => {
    const job = workflow.jobs?.["whatsapp-qr-compact-e2e"];
    const runText = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(runText).toContain("test/e2e/live/whatsapp-qr-compact.test.ts");
    expect(runText).toContain("npx vitest run --project e2e-live");
  });

  // source-shape-contract: security -- Preserves the public NVIDIA credential boundary for Model Router regression execution
  it("stages the public NVIDIA key for the Model Router's NVIDIA credential", () => {
    const branchValidationCallers = Object.values(workflow.jobs ?? {}).filter(
      (job) => job.uses === "./.github/workflows/e2e-branch-validation.yaml",
    );
    const job = workflow.jobs?.["model-router-provider-routed-inference-e2e"];
    const runStep = job?.steps?.find(
      (step) => step.name === "Run Model Router provider-routed inference E2E test",
    );
    expect(runStep?.env?.NVIDIA_API_KEY).toBe("${{ secrets.NVIDIA_API_KEY }}");
    expect(runStep?.env?.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(branchValidationCallers).toHaveLength(1);
    expect(workflow.permissions).toEqual(branchValidation.permissions);
    expect(workflow.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "write",
    });
  });

  // source-shape-contract: security -- Every discovered non-hermetic Vitest job must use immutable credential-free preparation
  it("prepares every discovered non-hermetic Vitest job before execution (#6692)", () => {
    const preparedJobs = preparedVitestJobs(workflow);

    expect(preparedJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of preparedJobs) {
      const steps = job?.steps ?? [];
      const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      const prepareIndex = steps.findIndex((step) => step.name === PREPARE_E2E_STEP);
      const runIndex = steps.findIndex((step) => /\bvitest\s+run\b/.test(step.run ?? ""));
      const checkout = steps[checkoutIndex];
      const prepare = steps[prepareIndex];

      expect(job?.permissions, jobName).toEqual({ contents: "read" });
      expect(checkout?.uses, jobName).toMatch(FULL_SHA_ACTION);
      expect(checkout?.with?.["persist-credentials"], jobName).toBe(false);
      expect(prepare?.uses, jobName).toBe(PREPARE_E2E_ACTION);
      expect(
        prepare?.with === undefined ||
          JSON.stringify(prepare.with) === JSON.stringify({ "build-cli": "false" }),
        `${jobName} prepare inputs`,
      ).toBe(true);
      expect(prepare?.env, jobName).toBeUndefined();
      expect(prepareIndex, jobName).toBeGreaterThan(checkoutIndex);
      expect(runIndex, jobName).toBeGreaterThan(prepareIndex);
      expect(
        steps.filter((step) => step.uses === PREPARE_E2E_ACTION),
        jobName,
      ).toHaveLength(1);
      expect(
        steps.map((step) => step.name),
        jobName,
      ).not.toContain("Setup Node");
      expect(
        steps.map((step) => step.name),
        jobName,
      ).not.toContain("Install root dependencies");
      expect(
        steps.map((step) => step.name),
        jobName,
      ).not.toContain("Build CLI");
    }
  });

  // source-shape-contract: compatibility -- Keeps the gateway drift regression in its stateful integration execution lane
  it("collects the gateway drift regression from its integration project (#6692)", () => {
    const job = workflow.jobs?.["gateway-drift-preflight-e2e"];
    const runStep = job?.steps?.find(
      (step) => step.name === "Run gateway drift preflight E2E test",
    );

    expect(runStep?.run).toContain(
      "vitest run --project integration test/gateway-drift-preflight.test.ts",
    );
    expect(runStep?.run).not.toContain("vitest run --project cli");
  });

  // source-shape-contract: security -- Keeps the custom-plugin EXDEV regression immutable and free of repository secrets
  it("runs the OpenClaw custom-plugin lifecycle and EXDEV guard in a secret-free lane", () => {
    const releaseJob = workflow.jobs?.["openclaw-plugin-runtime-exdev-release-e2e"];
    const job = workflow.jobs?.["openclaw-plugin-runtime-exdev-e2e"];
    const steps = job?.steps ?? [];
    const runText = steps.map((step) => step.run ?? "").join("\n");
    const checkoutStep = steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const setupNodeStep = steps.find((step) => step.name === "Setup Node");
    const runVitestStep = steps.find(
      (step) =>
        step.name === "Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV Vitest test",
    );
    const serializedJob = JSON.stringify(job);

    expect(job?.permissions).toEqual({ contents: "read" });
    expect(job?.["timeout-minutes"]).toBe(105);
    expect(checkoutStep?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(setupNodeStep?.uses).toMatch(FULL_SHA_ACTION);
    expect(runVitestStep?.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(serializedJob).not.toContain("${{ secrets.");
    expect(serializedJob).not.toMatch(/"secrets"\s*:\s*"inherit"/);
    for (const step of steps) {
      expect(
        step.env?.NVIDIA_INFERENCE_API_KEY,
        step.name ?? step.uses ?? "<unnamed>",
      ).toBeUndefined();
    }

    expect(runText).toContain("test/e2e/live/openclaw-plugin-runtime-exdev.test.ts");
    expect(runText).toContain("-t current-lifecycle");
    expect(runText).toContain("npx vitest run --project e2e-live");
    expect(runText).toContain("npm ci --ignore-scripts");
    expect(runText).toContain("npm run build:cli");

    const releaseRunText = (releaseJob?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(releaseJob?.permissions).toEqual({ contents: "read" });
    expect(releaseJob?.["timeout-minutes"]).toBe(55);
    expect(JSON.stringify(releaseJob)).not.toContain("${{ secrets.");
    expect(releaseRunText).toContain("test/e2e/live/openclaw-plugin-runtime-exdev.test.ts");
    expect(releaseRunText).toContain("-t release-baseline");
  });
});
