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
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
      "timeout-minutes"?: number;
    }
  >;
};

const FULL_SHA_ACTION = /@[0-9a-f]{40}$/i;
const PREPARED_VITEST_JOBS = [
  ["gateway-health-honest-e2e", "Run gateway health-honesty E2E test", undefined],
  ["openshell-version-pin-e2e", "Run OpenShell version-pin E2E test", { "build-cli": "false" }],
  ["gateway-drift-preflight-e2e", "Run gateway drift preflight E2E test", undefined],
  [
    "model-router-provider-routed-inference-e2e",
    "Run Model Router provider-routed inference E2E test",
    undefined,
  ],
] as const;

describe("Regression E2E workflow contract", () => {
  const workflow = readYaml<RegressionWorkflow>(".github/workflows/regression-e2e.yaml");

  it.each([
    ["docker-unreachable-gateway-start-e2e", "docker_unreachable_gateway_start"],
    ["onboard-inference-smoke-e2e", "onboard_inference_smoke"],
  ])("does not advertise or select retired lane %s", (jobName, selectorOutput) => {
    const jobsDescription = workflow.on?.workflow_dispatch?.inputs?.jobs?.description ?? "";
    const selectorScript =
      workflow.jobs?.select_regression_jobs?.steps?.find((step) => step.id === "select")?.run ?? "";

    expect(jobsDescription).not.toContain(jobName);
    expect(Object.keys(workflow.jobs ?? {})).not.toContain(jobName);
    expect(selectorScript).not.toContain(jobName);
    expect(selectorScript).not.toContain(selectorOutput);
  });

  it("does not advertise or select the retired strict-tool-call-probe lane", () => {
    const jobsDescription = workflow.on?.workflow_dispatch?.inputs?.jobs?.description ?? "";
    const selectorScript =
      workflow.jobs?.select_regression_jobs?.steps?.find((step) => step.id === "select")?.run ?? "";

    expect(jobsDescription).not.toContain("strict-tool-call-probe-e2e");
    expect(Object.keys(workflow.jobs ?? {})).not.toContain("strict-tool-call-probe-e2e");
    expect(selectorScript).not.toContain("strict-tool-call-probe-e2e");
    expect(selectorScript).not.toContain("strict_tool_call_probe");
  });

  it("runs WhatsApp compact QR through Vitest instead of the retired shell script", () => {
    const job = workflow.jobs?.["whatsapp-qr-compact-e2e"];
    const runText = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(runText).toContain("test/e2e/live/whatsapp-qr-compact.test.ts");
    expect(runText).toContain("npx vitest run --project e2e-live");
  });

  it("stages the public NVIDIA key for the Model Router's NVIDIA credential", () => {
    const job = workflow.jobs?.["model-router-provider-routed-inference-e2e"];
    const runStep = job?.steps?.find(
      (step) => step.name === "Run Model Router provider-routed inference E2E test",
    );
    expect(runStep?.env?.NVIDIA_API_KEY).toBe("${{ secrets.NVIDIA_API_KEY }}");
    expect(runStep?.env?.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  });

  it.each(
    PREPARED_VITEST_JOBS,
  )("prepares %s before invoking Vitest (#6692)", (jobName, runStepName, prepareInputs) => {
    const job = workflow.jobs?.[jobName];
    const steps = job?.steps ?? [];
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const prepareIndex = steps.findIndex((step) => step.name === PREPARE_E2E_STEP);
    const runIndex = steps.findIndex((step) => step.name === runStepName);
    const checkout = steps[checkoutIndex];
    const prepare = steps[prepareIndex];

    expect(job?.permissions).toEqual({ contents: "read" });
    expect(checkout?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(prepare?.uses).toBe(PREPARE_E2E_ACTION);
    expect(prepare?.with).toEqual(prepareInputs);
    expect(prepare?.env).toBeUndefined();
    expect(prepareIndex).toBeGreaterThan(checkoutIndex);
    expect(runIndex).toBeGreaterThan(prepareIndex);
    expect(steps.filter((step) => step.uses === PREPARE_E2E_ACTION)).toHaveLength(1);
    expect(steps.map((step) => step.name)).not.toContain("Setup Node");
    expect(steps.map((step) => step.name)).not.toContain("Install root dependencies");
    expect(steps.map((step) => step.name)).not.toContain("Build CLI");
  });

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

  it("runs the OpenClaw custom-plugin lifecycle and EXDEV guard in a secret-free lane", () => {
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
    expect(job?.["timeout-minutes"]).toBe(130);
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
    expect(runText).toContain("npx vitest run --project e2e-live");
    expect(runText).toContain("npm ci --ignore-scripts");
    expect(runText).toContain("npm run build:cli");
  });
});
