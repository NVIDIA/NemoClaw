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

  it("does not advertise or select the retired docker-unreachable gateway-start lane", () => {
    const jobsDescription = workflow.on?.workflow_dispatch?.inputs?.jobs?.description ?? "";
    const selectorScript =
      workflow.jobs?.select_regression_jobs?.steps?.find((step) => step.id === "select")?.run ?? "";

    expect(jobsDescription).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(Object.keys(workflow.jobs ?? {})).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(selectorScript).not.toContain("docker-unreachable-gateway-start-e2e");
    expect(selectorScript).not.toContain("docker_unreachable_gateway_start");
  });
});
