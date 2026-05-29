// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { scenario } from "../scenarios/builder.ts";
import { compileRunPlans } from "../scenarios/compiler.ts";
import { migrationInventory } from "../scenarios/migration-inventory.ts";
import { buildScenarioRegistry, listScenarios } from "../scenarios/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SCENARIOS = path.join(REPO_ROOT, "test/e2e-scenario/scenarios/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runScenarioCli(args: string[]) {
  return spawnSync(TSX, [RUN_SCENARIOS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

function scenarioOwnerIds(): string[] {
  return Array.from(
    new Set(
      [...migrationInventory.setupScenarios, ...migrationInventory.testPlans]
        .map((entry) => entry.newOwner)
        .filter((owner) => owner.startsWith("scenario:"))
        .map((owner) => owner.replace(/^scenario:/, "")),
    ),
  ).sort();
}

describe("deterministic scenario registry", () => {
  it("test_should_register_canonical_scenarios_for_all_required_old_coverage", () => {
    const registeredIds = new Set(listScenarios().map((entry) => entry.id));
    const missing = scenarioOwnerIds().filter((id) => !registeredIds.has(id));

    expect(missing, `missing canonical scenario IDs: ${missing.join(", ")}`).toEqual([]);
  });

  it("test_should_reject_duplicate_scenario_ids", () => {
    const first = scenario("duplicate-id").manifest("test/e2e-scenario/manifests/openclaw-nvidia.yaml").build();
    const second = scenario("duplicate-id").manifest("test/e2e-scenario/manifests/hermes-nvidia.yaml").build();

    expect(() => buildScenarioRegistry([first, second])).toThrow(/duplicate-id/);
  });

  it("test_should_return_actionable_unknown_scenario_error", () => {
    const result = runScenarioCli(["--scenarios", "does-not-exist", "--plan-only"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/does-not-exist/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Available scenarios:/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ubuntu-repo-cloud-openclaw/);
  });

  it("test_should_compile_multiple_targeted_scenario_plans", () => {
    const plans = compileRunPlans(["ubuntu-repo-cloud-openclaw", "ubuntu-repo-cloud-hermes"]);

    expect(plans.map((plan) => plan.scenarioId)).toEqual([
      "ubuntu-repo-cloud-openclaw",
      "ubuntu-repo-cloud-hermes",
    ]);
  });

  it("cli_should_emit_two_plan_sections_for_comma_separated_scenarios", () => {
    const result = runScenarioCli([
      "--scenarios",
      "ubuntu-repo-cloud-openclaw,ubuntu-repo-cloud-hermes",
      "--plan-only",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^Scenario: /gm)).toHaveLength(2);
    expect(result.stdout).toContain("Scenario: ubuntu-repo-cloud-openclaw");
    expect(result.stdout).toContain("Scenario: ubuntu-repo-cloud-hermes");
  });

  it("baseline_plan_should_match_legacy_resolver_semantics", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);

    expect(plan.environment).toEqual({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });
    expect(plan.expectedStateId).toBe("cloud-openclaw-ready");
    expect(plan.suiteIds).toEqual(["smoke", "inference", "credentials"]);
    expect(plan.onboardingAssertionIds).toEqual(["base-installed", "preflight-passed"]);
  });
});
