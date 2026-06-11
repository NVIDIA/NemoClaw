// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listScenarios } from "../scenarios/registry.ts";
import { liveScenarioSupport, liveScenarioTestName } from "../scenarios/runtime-support.ts";

/**
 * Locks the contract that the live registry-scenarios test file registers
 * each scenario under a name equal to `scenario.id` (no `[not wired: ...]`
 * suffix), so the workflow's exact `-t "^${SCENARIO_ID}$"` filter matches
 * supported AND unsupported entries identically. Without this contract,
 * explicit unsupported selections on `workflow_dispatch` would match zero
 * tests and Vitest would exit non-zero with no structured skip reason.
 */
describe("live registry-scenarios skip-name contract", () => {
  it("registers every scenario under a name equal to its id", () => {
    const scenarios = listScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(liveScenarioTestName(scenario)).toBe(scenario.id);
    }
  });

  it('matches the workflow\'s exact `-t "^${SCENARIO_ID}$"` regex for every scenario', () => {
    for (const scenario of listScenarios()) {
      const name = liveScenarioTestName(scenario);
      const filter = new RegExp(`^${scenario.id}$`);
      expect(
        filter.test(name),
        `workflow filter must match registered name for ${scenario.id}`,
      ).toBe(true);
    }
  });

  it("matches an explicit unsupported selection through the workflow filter", () => {
    const unsupported = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");
    expect(
      unsupported,
      "ubuntu-repo-cloud-hermes must remain a canonical unsupported example",
    ).toBeTruthy();
    const support = liveScenarioSupport(unsupported!);
    expect(support.supported).toBe(false);

    const name = liveScenarioTestName(unsupported!);
    const filter = new RegExp(`^${unsupported!.id}$`);
    expect(filter.test(name)).toBe(true);
    // Negative: any historical `[not wired: ...]` suffix would break the workflow filter.
    expect(name).not.toMatch(/\[not wired:/);
  });

  it("registers the canonical supported scenario under its bare id", () => {
    const supported = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");
    expect(supported).toBeTruthy();
    expect(liveScenarioSupport(supported!).supported).toBe(true);
    expect(liveScenarioTestName(supported!)).toBe("ubuntu-repo-cloud-openclaw");
  });

  // Note: the workflow's `-t "^${SCENARIO_ID}$"` filter pattern itself is
  // locked by `tools/e2e-scenarios/workflow-boundary.mts` and exercised by
  // `e2e-scenarios-workflow.test.ts`. This file only needs to guarantee
  // that the test names registered under that filter equal `scenario.id`.
});
