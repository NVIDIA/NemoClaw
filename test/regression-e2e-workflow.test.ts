// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

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
    }
  >;
};

const FULL_SHA_ACTION = /@[0-9a-f]{40}$/i;

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

    expect(runText).toContain("test/e2e-scenario/live/whatsapp-qr-compact.test.ts");
    expect(runText).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runText).not.toContain("test/e2e/test-whatsapp-qr-compact-e2e.sh");
  });

  it("runs OpenClaw plugin runtime-deps EXDEV through a secret-free Vitest lane", () => {
    const job = workflow.jobs?.["openclaw-plugin-runtime-exdev-e2e"];
    const steps = job?.steps ?? [];
    const runText = steps.map((step) => step.run ?? "").join("\n");
    const checkoutStep = steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    const setupNodeStep = steps.find((step) => step.name === "Setup Node");
    const runVitestStep = steps.find(
      (step) => step.name === "Run OpenClaw plugin runtime-deps EXDEV Vitest test",
    );

    expect(job?.permissions).toEqual({ contents: "read" });
    expect(checkoutStep?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkoutStep?.with?.["persist-credentials"]).toBe(false);
    expect(setupNodeStep?.uses).toMatch(FULL_SHA_ACTION);
    expect(runVitestStep?.env?.NEMOCLAW_RUN_E2E_SCENARIOS).toBe("1");
    for (const step of steps) {
      expect(step.env?.NVIDIA_API_KEY, step.name ?? step.uses ?? "<unnamed>").toBeUndefined();
    }

    expect(runText).toContain("test/e2e-scenario/live/openclaw-plugin-runtime-exdev.test.ts");
    expect(runText).toContain("npx vitest run --project e2e-scenarios-live");
    expect(runText).toContain("npm ci --ignore-scripts");
    expect(runText).toContain("npm run build:cli");
    expect(runText).not.toContain("test/e2e/test-openclaw-plugin-runtime-exdev.sh");
  });
});
