// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Render a Markdown coverage report for E2E setup scenarios.
 *
 * Design (per the simplify pass): one primary table, one row per scenario.
 * A `## Gaps` section flags scenarios without suites and expected states
 * that no scenario references. Rows are sorted deterministically for
 * stable CI diffs.
 */

import type { ResolverInput } from "./load.ts";

export interface CoverageReportOptions {
  /** Optional map of scenario id -> last known run status. */
  lastRunStatus?: Record<string, string>;
}

export function renderCoverageReport(
  meta: ResolverInput,
  options: CoverageReportOptions = {},
): string {
  const { scenarios, expectedStates } = meta;
  const scenarioIds = Object.keys(scenarios.setup_scenarios).sort();
  const lines: string[] = [];
  lines.push("# E2E Setup Scenario Coverage");
  lines.push("");
  lines.push(
    "_Generated from `test/e2e/{scenarios,expected-states,suites}.yaml`._",
  );
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  const hasStatus = options.lastRunStatus && Object.keys(options.lastRunStatus).length > 0;
  const header = hasStatus
    ? "| Scenario | Platform | Install | Runtime | Onboarding | Expected state | Suites | Last run |"
    : "| Scenario | Platform | Install | Runtime | Onboarding | Expected state | Suites |";
  const sep = hasStatus
    ? "|---|---|---|---|---|---|---|---|"
    : "|---|---|---|---|---|---|---|";
  lines.push(header);
  lines.push(sep);
  for (const id of scenarioIds) {
    const sc = scenarios.setup_scenarios[id];
    const suiteCell = sc.suites.length === 0 ? "_(none)_" : sc.suites.join(", ");
    const row = [
      id,
      sc.dimensions.platform,
      sc.dimensions.install,
      sc.dimensions.runtime,
      sc.dimensions.onboarding,
      sc.expected_state,
      suiteCell,
    ];
    if (hasStatus) {
      row.push(options.lastRunStatus?.[id] ?? "_unknown_");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  // Gaps section.
  const scenariosWithoutSuites = scenarioIds.filter(
    (id) => scenarios.setup_scenarios[id].suites.length === 0,
  );
  const referencedStates = new Set<string>(
    scenarioIds.map((id) => scenarios.setup_scenarios[id].expected_state),
  );
  const unusedStates = Object.keys(expectedStates.expected_states)
    .filter((s) => !referencedStates.has(s))
    .sort();

  lines.push("## Gaps");
  lines.push("");
  if (scenariosWithoutSuites.length === 0 && unusedStates.length === 0) {
    lines.push("_No gaps detected._");
  } else {
    if (scenariosWithoutSuites.length > 0) {
      lines.push("### Scenarios with no suites");
      lines.push("");
      for (const id of scenariosWithoutSuites.sort()) {
        lines.push(`- \`${id}\`: no suites configured`);
      }
      lines.push("");
    }
    if (unusedStates.length > 0) {
      lines.push("### Unused expected states");
      lines.push("");
      for (const id of unusedStates) {
        lines.push(`- \`${id}\`: no scenario references this expected state`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
