// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileRunPlans } from "../scenarios/compiler.ts";
import { listScenarios } from "../scenarios/registry.ts";
import type { ScenarioDefinition } from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SCENARIOS = path.join(REPO_ROOT, "test/e2e-scenario/scenarios/run.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function runScenarioCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(TSX, [RUN_SCENARIOS, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("plan compiler", () => {
  it("test_should_emit_machine_and_human_plan_artifacts_under_context_dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-plan-"));
    try {
      const result = runScenarioCli(["--scenarios", "ubuntu-repo-cloud-openclaw", "--plan-only"], {
        E2E_CONTEXT_DIR: tmp,
      });

      expect(result.status, result.stderr).toBe(0);
      const planPath = path.join(tmp, ".e2e", "run-plan.json");
      const summaryPath = path.join(tmp, ".e2e", "plan.txt");
      expect(fs.existsSync(planPath)).toBe(true);
      expect(fs.existsSync(summaryPath)).toBe(true);
      const plans = JSON.parse(fs.readFileSync(planPath, "utf8"));
      expect(plans[0].scenarioId).toBe("ubuntu-repo-cloud-openclaw");
      expect(fs.readFileSync(summaryPath, "utf8")).toContain("Scenario: ubuntu-repo-cloud-openclaw");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("test_should_include_expanded_assertion_steps_by_phase", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const onboarding = plan.phases.find((phase) => phase.name === "onboarding");
    const runtime = plan.phases.find((phase) => phase.name === "runtime");

    expect(onboarding?.assertionGroups.map((group) => group.id)).toContain("onboarding.base-installed");
    expect(runtime?.assertionGroups.map((group) => group.id)).toContain("suite.smoke");
    expect(runtime?.assertionGroups.flatMap((group) => group.steps.map((step) => step.id))).toContain(
      "runtime.smoke.gateway-health",
    );
  });

  it("test_should_show_timeout_and_retry_policy_in_plan", () => {
    const summary = runScenarioCli(["--scenarios", "ubuntu-repo-cloud-openclaw", "--plan-only"]);

    expect(summary.status, summary.stderr).toBe(0);
    expect(summary.stdout).toContain("timeout=30s");
    expect(summary.stdout).toContain("retry=2 on gateway-transient");
  });

  it("test_should_reject_incompatible_manifest_scenario_combination", () => {
    const badScenario: ScenarioDefinition = {
      id: "bad-platform",
      manifestPath: "test/e2e-scenario/manifests/openclaw-nvidia-macos.yaml",
      environment: {
        platform: "ubuntu-local",
        install: "repo-current",
        runtime: "docker-running",
        onboarding: "cloud-openclaw",
      },
      assertionGroups: [],
      expectedStateId: "cloud-openclaw-ready",
      suiteIds: [],
      onboardingAssertionIds: [],
    };

    expect(() => compileRunPlans([badScenario])).toThrow(/incompatible.*platform|platform.*incompatible/i);
  });

  it("test_should_reject_suite_filter", () => {
    const result = runScenarioCli(["--scenarios", "ubuntu-repo-cloud-openclaw", "--plan-only"], {
      E2E_SUITE_FILTER: "smoke",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/E2E_SUITE_FILTER|scenario builders/i);
  });

  it("plan_only_should_work_for_every_canonical_scenario_id", () => {
    const ids = listScenarios().map((scenario) => scenario.id);
    const plans = compileRunPlans(ids);

    expect(plans.map((plan) => plan.scenarioId)).toEqual(ids);
  });
});
