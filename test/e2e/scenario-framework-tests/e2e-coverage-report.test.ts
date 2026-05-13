// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";

import { loadMetadataFromDir, loadMetadataFromObjects } from "../runtime/resolver/load.ts";
import { renderCoverageReport } from "../runtime/resolver/coverage.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e");

describe("coverage report", () => {
  it("should_render_single_coverage_table", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const md = renderCoverageReport(meta);
    // Exactly one primary Scenario Coverage table.
    const headers = md.match(/\|\s*Scenario\s*\|\s*Platform\s*\|\s*Install\s*\|\s*Runtime\s*\|\s*Onboarding\s*\|\s*Expected state\s*\|\s*Suites\s*\|/g);
    expect(headers).toBeTruthy();
    expect(headers?.length).toBe(1);
    // Every scenario should appear as a row.
    for (const id of Object.keys(meta.scenarios.setup_scenarios)) {
      expect(md).toContain(id);
    }
    // Rows should be sorted deterministically (alphabetically).
    const rowOrder = Object.keys(meta.scenarios.setup_scenarios).sort();
    let pos = 0;
    for (const id of rowOrder) {
      const idx = md.indexOf(`| ${id} |`, pos);
      expect(idx, `row ${id} not found in order. report:\n${md}`).toBeGreaterThanOrEqual(0);
      pos = idx;
    }
  });

  it("should_flag_scenarios_without_suites", () => {
    const meta = loadMetadataFromObjects({
      scenarios: {
        platforms: { p: {} },
        installs: { i: {} },
        runtimes: { r: {} },
        onboarding: { o: { agent: "openclaw", provider: "nvidia" } },
        setup_scenarios: {
          "empty-suite-scenario": {
            dimensions: { platform: "p", install: "i", runtime: "r", onboarding: "o" },
            expected_state: "some-state",
            suites: [],
          },
        },
      },
      expectedStates: { expected_states: { "some-state": { gateway: { health: "healthy" } } } },
      suites: { suites: {} },
    });
    const md = renderCoverageReport(meta);
    expect(md).toMatch(/## Gaps/);
    expect(md).toMatch(/empty-suite-scenario.*no suites|no suites.*empty-suite-scenario/s);
  });

  it("coverage_report_should_include_legacy_parity_summary", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const md = renderCoverageReport(meta);
    expect(md).toMatch(/## Legacy Parity Summary/);
    expect(md).toMatch(/Unmapped assertions: 0/);
    expect(md).toMatch(/onboarding-baseline/);
    expect(md).toMatch(/lifecycle/);
    expect(md).toMatch(/rebuild-runtime/);
    expect(md).toMatch(/providers-messaging/);
    expect(md).toMatch(/final-security-policy-platform-misc/);
  });

  it("should_flag_expected_states_not_used_by_any_scenario", () => {
    const meta = loadMetadataFromObjects({
      scenarios: {
        platforms: { p: {} },
        installs: { i: {} },
        runtimes: { r: {} },
        onboarding: { o: { agent: "openclaw", provider: "nvidia" } },
        setup_scenarios: {
          s1: {
            dimensions: { platform: "p", install: "i", runtime: "r", onboarding: "o" },
            expected_state: "used-state",
            suites: ["smoke"],
          },
        },
      },
      expectedStates: {
        expected_states: {
          "used-state": { gateway: { health: "healthy" } },
          "unused-state": { gateway: { health: "healthy" } },
        },
      },
      suites: {
        suites: { smoke: { steps: [{ id: "a", script: "suites/smoke/a.sh" }] } },
      },
    });
    const md = renderCoverageReport(meta);
    expect(md).toMatch(/## Gaps/);
    expect(md).toMatch(/unused-state/);
  });
});
