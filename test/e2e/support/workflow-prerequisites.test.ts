// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { requiresManagedImages } from "../../../tools/e2e/workflow-prerequisites.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow, type Workflow } from "../../helpers/e2e-workflow-contract.ts";
import { buildE2eWorkflowPlan, selectedWorkflowJobs } from "../../../tools/e2e/workflow-plan.mts";

describe("selected E2E prerequisites", () => {
  it.each([
    {
      name: "version output",
      mutate: (workflow: Workflow) => {
        workflow.jobs["generate-matrix"]!.outputs!.openshell_version = "0.0.116";
      },
    },
    {
      name: "version command",
      mutate: (workflow: Workflow) => {
        workflow.jobs["generate-matrix"]!.steps!.find(
          (step) => step.id === "openshell_version",
        )!.run = "echo version=0.0.116 >> $GITHUB_OUTPUT";
      },
    },
    {
      name: "version identity",
      mutate: (workflow: Workflow) => {
        workflow.jobs["generate-matrix"]!.steps!.find(
          (step) => step.id === "openshell_version",
        )!.env!.CANDIDATE_SHA = "${{ inputs.base_sha }}";
      },
    },
    {
      name: "health version",
      mutate: (workflow: Workflow) => {
        workflow.jobs["external-gateway-health"]!.env!.NEMOCLAW_OPENSHELL_PIN_VERSION = "0.0.116";
      },
    },
    {
      name: "publication selector",
      mutate: (workflow: Workflow) => {
        workflow.jobs["base-image-publication"]!.if = "false";
      },
    },
    {
      name: "full release bypass",
      mutate: (workflow: Workflow) => {
        workflow.jobs["release-qualification"]!.steps![1]!.env!.MANAGED_IMAGE_REQUIRED = "false";
      },
    },
  ])("rejects an altered $name boundary", ({ mutate }) => {
    const workflow = structuredClone(readWorkflow()) as unknown as Workflow;
    mutate(workflow);
    expect(validateE2eWorkflow(workflow).length).toBeGreaterThan(0);
  });
  it.each([
    ["openshell-gateway-auth-contract", false],
    ["external-gateway-health", false],
    ["openshell-gateway-auth-contract,external-gateway-health", false],
    ["openshell-gateway-auth-contract,mcp-bridge", true],
    ["managed-image-protected-runtime", true],
    ["", true],
  ])("requires managed images for %s: %s", (jobs, expected) => {
    expect(requiresManagedImages(selectedWorkflowJobs(buildE2eWorkflowPlan({ jobs })))).toBe(
      expected,
    );
  });

  it("follows transitive consumers and checks every selected dependency", () => {
    const jobs = {
      "base-image-publication": {},
      consumer: { needs: "base-image-publication" },
      nested: { needs: "consumer" },
      independent: {},
    };
    expect(requiresManagedImages(["nested", "independent"], jobs)).toBe(true);
    expect(() => requiresManagedImages(["nested", "unknown"], jobs)).toThrow("Unknown");
    expect(requiresManagedImages([], jobs)).toBe(false);
  });

  it("rejects cycles and malformed dependencies", () => {
    expect(() => requiresManagedImages(["a"], { a: { needs: "b" }, b: { needs: "a" } })).toThrow(
      "Cyclic",
    );
    expect(() =>
      requiresManagedImages(["a"], { a: { needs: [42] as unknown as string[] } }),
    ).toThrow("Invalid");
  });
});
