// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import {
  assertionGroupForSuite,
  assertionGroupsForScenario,
  assertionRegistry,
  validateAssertionGroups,
} from "../scenarios/assertions/registry.ts";
import { listScenarios } from "../scenarios/registry.ts";
import type { AssertionGroup } from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const SUITES_PATH = path.join(E2E_DIR, "validation_suites", "suites.yaml");

type AnyRecord = Record<string, unknown>;

function loadYaml(filePath: string): AnyRecord {
  const doc = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!doc || typeof doc !== "object") {
    throw new Error(`${filePath} did not parse to an object`);
  }
  return doc as AnyRecord;
}

function allPlannedAssertionGroupIds(): Set<string> {
  return new Set(
    listScenarios().flatMap((scenario) => assertionGroupsForScenario(scenario).map((group) => group.id)),
  );
}

describe("assertion modules", () => {
  it("test_should_define_onboarding_assertions_in_modules", () => {
    const onboardingGroups = assertionRegistry.groups.filter((group) => group.phase === "onboarding");
    const stepIds = new Set(onboardingGroups.flatMap((group) => group.steps.map((step) => step.id)));

    for (const id of ["onboarding.base.cli-installed", "onboarding.preflight.passed", "onboarding.preflight.expected-failed"]) {
      expect(stepIds.has(id), `missing onboarding step ${id}`).toBe(true);
    }
    for (const step of onboardingGroups.flatMap((group) => group.steps)) {
      expect(step.phase).toBe("onboarding");
      expect(step.implementation?.ref).toMatch(/^test\/e2e-scenario\/onboarding_assertions\//);
    }
  });

  it("test_should_map_every_old_validation_suite_to_canonical_assertion_group", () => {
    const suites = loadYaml(SUITES_PATH).suites as AnyRecord;

    for (const suiteId of Object.keys(suites)) {
      const group = assertionGroupForSuite(suiteId);
      expect(group?.id, `missing assertion group for suite ${suiteId}`).toBe(`suite.${suiteId}`);
      expect(group?.steps.length, `suite ${suiteId} must not be alias-only`).toBeGreaterThan(0);
      expect(group?.steps.every((step) => step.implementation?.kind !== "pending")).toBe(true);
    }
  });

  it("test_should_keep_snapshot_suite_distinct_from_snapshot_lifecycle", () => {
    const snapshot = assertionGroupForSuite("snapshot");
    const snapshotLifecycle = assertionGroupForSuite("snapshot-lifecycle");

    expect(snapshot?.steps.map((step) => step.id)).toEqual(["runtime.snapshot.sandbox-listed"]);
    expect(snapshot?.steps.map((step) => step.implementation?.ref)).toEqual([
      "test/e2e-scenario/validation_suites/smoke/02-sandbox-listed.sh",
    ]);
    expect(snapshotLifecycle?.steps.map((step) => step.implementation?.ref)).toEqual([
      "test/e2e-scenario/validation_suites/sandbox/snapshot/00-create-list-restore.sh",
    ]);
  });

  it("test_should_require_each_assertion_group_to_have_steps", () => {
    const emptyGroup: AssertionGroup = { id: "empty", phase: "runtime", steps: [] };

    expect(() => validateAssertionGroups([...assertionRegistry.groups, emptyGroup], E2E_DIR)).toThrow(/empty/);
  });

  it("test_should_require_each_assertion_group_to_be_used_by_a_scenario_plan", () => {
    const planned = allPlannedAssertionGroupIds();
    const unused = assertionRegistry.groups.map((group) => group.id).filter((id) => !planned.has(id));

    expect(unused, `unused assertion groups: ${unused.join(", ")}`).toEqual([]);
  });

  it("test_should_fail_when_assertion_step_references_missing_script", () => {
    const badGroup: AssertionGroup = {
      id: "bad.missing-script",
      phase: "runtime",
      steps: [
        {
          id: "bad.missing-script.step",
          phase: "runtime",
          implementation: { kind: "shell", ref: "test/e2e-scenario/validation_suites/does-not-exist.sh" },
          evidencePath: ".e2e/bad.log",
        },
      ],
    };

    expect(() => validateAssertionGroups([badGroup], E2E_DIR)).toThrow(/does-not-exist/);
  });

  it("test_should_fail_when_retry_attempts_lack_classifier", () => {
    const badGroup: AssertionGroup = {
      id: "bad.retry",
      phase: "runtime",
      steps: [
        {
          id: "bad.retry.step",
          phase: "runtime",
          implementation: { kind: "probe", ref: "fakeProbe" },
          evidencePath: ".e2e/bad.log",
          reliability: { retry: { attempts: 2, on: [] } },
        },
      ],
    };

    expect(() => validateAssertionGroups([badGroup], E2E_DIR)).toThrow(/classifier|retry/i);
  });

  it("test_should_block_complete_status_for_manual_classification_steps", () => {
    expect(() => validateAssertionGroups(assertionRegistry.groups, E2E_DIR)).not.toThrow(/needs-manual-classification/);
    expect(assertionRegistry.groups.every((group) => group.migrationStatus === "complete")).toBe(true);
  });
});
