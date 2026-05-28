// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 11: Clean the House - final metadata and documentation hygiene.
 *
 * These tests are intentionally conservative during the incremental
 * migration: they guard the README, assert that every suite script
 * referenced in suites.yaml exists and is executable, and assert that
 * every scenario either has both an expected state and at least one
 * suite or is explicitly marked as negative / disabled.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { loadMetadataFromDir } from "../runtime/resolver/load.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const VALIDATION_SUITES_DIR = path.join(E2E_DIR, "validation_suites");
describe("Phase 11 final hygiene", () => {
  it("all_suite_scripts_should_exist", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const missing: string[] = [];
    for (const [suiteId, suite] of Object.entries(meta.suites.suites)) {
      for (const step of suite.steps) {
        const p = path.join(VALIDATION_SUITES_DIR, step.script);
        if (!fs.existsSync(p)) {
          missing.push(`${suiteId}/${step.id} -> ${step.script}`);
        } else {
          const mode = fs.statSync(p).mode;
          // owner-executable bit must be set
          if ((mode & 0o100) === 0) {
            missing.push(`${suiteId}/${step.id} -> ${step.script} (not executable)`);
          }
        }
      }
    }
    expect(missing, `missing/non-executable suite scripts:\n${missing.join("\n")}`).toEqual([]);
  });

  it("all_scenarios_should_have_expected_state_and_suites", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const problems: string[] = [];
    for (const [id, sc] of Object.entries(meta.scenarios.setup_scenarios)) {
      if (!sc.expected_state) {
        problems.push(`${id}: missing expected_state`);
        continue;
      }
      // Negative scenarios (preflight failures) intentionally have no suites.
      const state = meta.expectedStates.expected_states[sc.expected_state] as {
        failure?: { expected?: boolean };
      };
      const isNegative = state?.failure?.expected === true;
      if (!Array.isArray(sc.suites)) {
        problems.push(`${id}: suites must be an array`);
        continue;
      }
      if (sc.suites.length === 0 && !isNegative) {
        problems.push(`${id}: no suites and not a negative scenario`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

});
