// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  catalogueTarget,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

// #6042: onboard-policy-preset-sequencing.test.ts drives the real
// interactive onboard wizard through a PTY; forcing non-interactive mode
// (as cloud-onboard and double-onboard both do) would defeat the whole
// regression. Prove the catalogue selects the right test file today, and
// that reintroducing NEMOCLAW_NON_INTERACTIVE on this target is caught.
describe("onboard-policy-preset-sequencing workflow boundary", () => {
  it("selects onboard-policy-preset-sequencing.test.ts with interactive mode enabled", () => {
    const target = catalogueTarget("onboard-policy-preset-sequencing");
    const plan = buildE2eWorkflowPlan({ jobs: target.id });

    expect(target.testFile).toBe("test/e2e/live/onboard-policy-preset-sequencing.test.ts");
    expect(target.installNonInteractive).toBe(false);
    expect(target.environment.NEMOCLAW_NON_INTERACTIVE).toBeUndefined();
    expect(plan.catalogueMatrices.standard).toEqual([
      expect.objectContaining({
        id: target.id,
        install_non_interactive: false,
        test_file: target.testFile,
      }),
    ]);
  });

  it("rejects onboard-policy-preset-sequencing forced back into non-interactive mode", () => {
    const target = catalogueTarget("onboard-policy-preset-sequencing");

    expect(() =>
      validateE2eTargetCatalogue([
        {
          ...target,
          installNonInteractive: true,
          environment: { ...target.environment, NEMOCLAW_NON_INTERACTIVE: "1" },
        },
      ]),
    ).toThrow(
      "E2E target onboard-policy-preset-sequencing requires interactive installation and execution",
    );
  });
});
