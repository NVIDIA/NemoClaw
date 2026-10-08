// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  resolveWorkflowSandboxIdentities,
  validateWorkflowSandboxNames,
} from "../../../tools/e2e/sandbox-name-workflow-boundary.mts";
import { E2E_TARGET_CATALOGUE } from "../../../tools/e2e/target-catalogue.mts";
import * as importedSandboxNameContract from "../../../nemoclaw/src/shared/sandbox-name.cts";
import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const WORKFLOW_PATHS = [".github/workflows/e2e.yaml"] as const;
const sandboxNameContract = (
  "default" in importedSandboxNameContract && importedSandboxNameContract.default
    ? importedSandboxNameContract.default
    : importedSandboxNameContract
) as typeof import("../../../nemoclaw/src/shared/sandbox-name.cts");
const { isValidName } = sandboxNameContract;

describe("E2E sandbox name boundary", () => {
  it("keeps every catalogue fixture sandbox name within the canonical boundary", () => {
    const invalidTargets = E2E_TARGET_CATALOGUE.flatMap((target) => {
      const sandboxName = target.environment.NEMOCLAW_SANDBOX_NAME;
      return sandboxName === undefined || isValidName(sandboxName) ? [] : [target.id];
    });

    expect(isValidName("e2e-overlong-catalogue-name")).toBe(false);
    expect(invalidTargets).toEqual([]);
  });

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
