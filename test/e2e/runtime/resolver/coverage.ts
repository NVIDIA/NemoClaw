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

import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import type { ResolverInput } from "./load.ts";

export interface CoverageReportOptions {
  /** Optional map of scenario id -> last known run status. */
  lastRunStatus?: Record<string, string>;
}

interface ParityInventoryAssertion {
  mapping_status?: string;
}

interface ParityInventoryEntrypoint {
  script: string;
  assertions: ParityInventoryAssertion[];
}

function renderLegacyParitySummary(meta: ResolverInput): string[] {
  if (!meta.sourceDir) return [];
  const docsDir = path.join(meta.sourceDir, "docs");
  const inventoryPath = path.join(docsDir, "parity-inventory.generated.json");
  const mapPath = path.join(docsDir, "parity-map.yaml");
  if (!fs.existsSync(inventoryPath) || !fs.existsSync(mapPath)) return [];

  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as {
    entrypoints: ParityInventoryEntrypoint[];
  };
  const parityMap = (yaml.load(fs.readFileSync(mapPath, "utf8")) ?? {}) as {
    scripts?: Record<string, { bucket?: string }>;
  };
  const counts = { mapped: 0, deferred: 0, retired: 0, unmapped: 0 };
  const buckets = new Map<string, { scripts: Set<string>; mapped: number; deferred: number; retired: number; unmapped: number }>();

  for (const entrypoint of inventory.entrypoints) {
    const script = path.basename(entrypoint.script);
    const bucket = parityMap.scripts?.[script]?.bucket ?? "unbucketed";
    const row = buckets.get(bucket) ?? {
      scripts: new Set<string>(),
      mapped: 0,
      deferred: 0,
      retired: 0,
      unmapped: 0,
    };
    row.scripts.add(script);
    buckets.set(bucket, row);
    for (const assertion of entrypoint.assertions) {
      const status = assertion.mapping_status;
      if (status === "mapped" || status === "deferred" || status === "retired") {
        counts[status]++;
        row[status]++;
      } else {
        counts.unmapped++;
        row.unmapped++;
      }
    }
  }

  const lines: string[] = [];
  lines.push("## Legacy Parity Summary");
  lines.push("");
  lines.push(`- Scripts: ${inventory.entrypoints.length}`);
  lines.push(`- Mapped assertions: ${counts.mapped}`);
  lines.push(`- Deferred assertions: ${counts.deferred}`);
  lines.push(`- Retired assertions: ${counts.retired}`);
  lines.push(`- Unmapped assertions: ${counts.unmapped}`);
  lines.push("");
  lines.push("| Bucket | Scripts | Mapped | Deferred | Retired | Unmapped |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [bucket, row] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| ${bucket} | ${row.scripts.size} | ${row.mapped} | ${row.deferred} | ${row.retired} | ${row.unmapped} |`,
    );
  }
  lines.push("");
  return lines;
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
  lines.push(...renderLegacyParitySummary(meta));

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
