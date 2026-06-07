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
    "_Generated from `test/e2e-scenario/nemoclaw_scenarios/{scenarios,expected-states}.yaml` and `test/e2e-scenario/validation_suites/suites.yaml`._",
  );
  lines.push("");
  lines.push("## Base Scenarios");
  lines.push("");
  lines.push("| Base | Platform | Install | Runtime | Requirements |");
  lines.push("|---|---|---|---|---|");
  for (const [id, base] of Object.entries(scenarios.base_scenarios ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(
      `| ${id} | ${base.platform} | ${base.install} | ${base.runtime} | ${(base.runner_requirements ?? []).join(", ") || "_none_"} |`,
    );
  }
  lines.push("");
  lines.push("## Onboarding Profiles");
  lines.push("");
  lines.push("| Profile | Path | Provider | Agent | Route |");
  lines.push("|---|---|---|---|---|");
  for (const [id, profile] of Object.entries(
    scenarios.onboarding_profiles ?? {},
  ).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| ${id} | ${profile.path ?? ""} | ${profile.provider ?? ""} | ${profile.agent ?? ""} | ${profile.inference_route ?? ""} |`,
    );
  }
  lines.push("");
  lines.push("## Test Plans");
  lines.push("");
  lines.push("| Plan | Base | Onboarding | Expected state | Suites |");
  lines.push("|---|---|---|---|---|");
  for (const [id, plan] of Object.entries(scenarios.test_plans ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(
      `| ${id} | ${plan.base} | ${plan.onboarding} | ${plan.expected_state} | ${(plan.suites ?? []).join(", ") || "_(none)_"} |`,
    );
  }
  lines.push("");
  lines.push("## Suites");
  lines.push("");
  lines.push(`Total suites: ${Object.keys(meta.suites.suites).length}`);
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  const hasStatus =
    options.lastRunStatus && Object.keys(options.lastRunStatus).length > 0;
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
    if (!sc) continue;
    const suites = sc.suites ?? [];
    const dimensions = sc.dimensions;
    const suiteCell = suites.length === 0 ? "_(none)_" : suites.join(", ");
    const row = [
      id,
      dimensions?.platform ?? "",
      dimensions?.install ?? "",
      dimensions?.runtime ?? "",
      dimensions?.onboarding ?? "",
      sc.expected_state ?? "",
      suiteCell,
    ];
    if (hasStatus) {
      row.push(options.lastRunStatus?.[id] ?? "_unknown_");
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  // Gaps section.
  const scenarioEntries = scenarioIds.flatMap((id) => {
    const scenario = scenarios.setup_scenarios[id];
    return scenario ? [{ id, scenario }] : [];
  });
  const scenariosWithoutSuites = scenarioEntries
    .filter(({ scenario }) => (scenario.suites ?? []).length === 0)
    .map(({ id }) => id);
  const skippedScenarios = scenarioEntries
    .map(({ id, scenario }) => ({
      id,
      skips: scenario.skipped_capabilities ?? [],
    }))
    .filter(({ skips }) => skips.length > 0);
  const referencedStates = new Set<string>(
    scenarioEntries
      .map(({ scenario }) => scenario.expected_state)
      .filter((state): state is string => Boolean(state)),
  );
  const unusedStates = Object.keys(expectedStates.expected_states)
    .filter((s) => !referencedStates.has(s))
    .sort();

  lines.push("## Gaps");
  lines.push("");
  if (
    scenariosWithoutSuites.length === 0 &&
    unusedStates.length === 0 &&
    skippedScenarios.length === 0
  ) {
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
    if (skippedScenarios.length > 0) {
      lines.push("### Explicitly skipped capabilities");
      lines.push("");
      for (const { id, skips } of skippedScenarios) {
        for (const skip of skips) {
          const suites =
            Array.isArray(skip.suites) && skip.suites.length > 0
              ? ` Suites: ${skip.suites.map((suite) => `\`${suite}\``).join(", ")}.`
              : "";
          lines.push(`- \`${id}\` / \`${skip.id}\`: ${skip.reason}${suites}`);
        }
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
