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
      steps?: WorkflowStep[];
    }
  >;
};

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
});
