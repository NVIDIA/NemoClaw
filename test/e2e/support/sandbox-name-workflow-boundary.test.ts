// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  resolveWorkflowSandboxIdentities,
  validateWorkflowSandboxNames,
} from "../../../tools/e2e/sandbox-name-workflow-boundary.mts";
import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const WORKFLOW_PATHS = [".github/workflows/e2e.yaml"] as const;

describe("live workflow sandbox name boundary", () => {
  it.each(WORKFLOW_PATHS)(
    "keeps every literal and matrix-generated sandbox identity canonical in %s (#8497)",
    (workflowPath) => {
      const workflow = readYaml<Workflow>(workflowPath);
      const identities = resolveWorkflowSandboxIdentities(workflow);

      expect(identities.length).toBeGreaterThan(0);
      expect(validateWorkflowSandboxNames(workflow)).toEqual([]);
    },
  );

  it("rejects overlong and unresolved optional-lane sandbox identities (#8497)", () => {
    const workflow = readYaml<Workflow>(".github/workflows/e2e.yaml");
    workflow.jobs["hermes-gpu-startup"]!.strategy!.matrix = {
      scenario: ["e2e-overlong-optional-lane", {}],
    };

    expect(validateWorkflowSandboxNames(workflow)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('invalid sandbox name "e2e-overlong-optional-lane"'),
        expect.stringContaining('resolves to invalid sandbox name ""'),
      ]),
    );
  });
});
