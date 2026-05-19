// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate that nightly-e2e.yaml remains internally consistent.
 *
 * Catches:
 * - Nightly E2E jobs missing the selective dispatch guard in their `if:` condition
 * - Aggregate reporting/notification jobs missing real E2E jobs in their `needs` lists
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a YAML file and return the raw object. */
function loadYaml(relPath: string): Record<string, unknown> {
  const text = readFileSync(repoPath(relPath), "utf-8");
  return YAML.parse(text) as Record<string, unknown>;
}

/**
 * Extract all E2E job names from the nightly-e2e.yaml workflow.
 * A job is any top-level key under `jobs:` except infrastructure jobs
 * (`notify-on-failure`, `report-to-pr`).
 */
function getNightlyJobNames(workflow: Record<string, unknown>): string[] {
  const jobs = workflow.jobs as Record<string, unknown> | undefined;
  if (!jobs) return [];
  const infra = new Set(["notify-on-failure", "report-to-pr", "scorecard"]);
  return Object.keys(jobs).filter((name) => !infra.has(name));
}

function getJobNeeds(job: unknown): string[] {
  if (typeof job !== "object" || job === null) return [];
  const needs = (job as Record<string, unknown>).needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) {
    return needs.filter((name): name is string => typeof name === "string");
  }
  return [];
}

/**
 * Extract the `if:` condition string from a workflow job object.
 */
function getJobIf(job: unknown): string | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const record = job as Record<string, unknown>;
  if (typeof record.if === "string") return record.if;
  return undefined;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("nightly E2E workflow validation", () => {
  const workflow = loadYaml(".github/workflows/nightly-e2e.yaml");

  const nightlyJobs = getNightlyJobNames(workflow);
  const aggregateJobs = ["notify-on-failure", "report-to-pr", "scorecard"];

  it("every nightly E2E job has the selective dispatch guard in its if: condition", () => {
    const jobs = workflow.jobs as Record<string, unknown>;
    const missing: string[] = [];

    for (const name of nightlyJobs) {
      const job = jobs[name];
      const condition = getJobIf(job);
      if (!condition) {
        missing.push(`${name} (no if: condition)`);
        continue;
      }
      // Check for the full selective dispatch pattern:
      // (github.event_name != 'workflow_dispatch' ||
      //  inputs.jobs == '' ||
      //  contains(format(',{0},', inputs.jobs), ',<job-name>,'))
      const hasDispatchBypass = condition.includes(
        "github.event_name != 'workflow_dispatch'",
      );
      const hasEmptySelectionBypass = condition.includes("inputs.jobs == ''");
      const hasExactJobMatch = condition.includes(
        `contains(format(',{0},', inputs.jobs), ',${name},')`,
      );
      if (!(hasDispatchBypass && hasEmptySelectionBypass && hasExactJobMatch)) {
        missing.push(name);
      }
    }

    expect(
      missing,
      `Nightly E2E jobs missing the selective dispatch guard in their ` +
        `if: condition: ${missing.join(", ")}. Each job needs:\n` +
        `  (github.event_name != 'workflow_dispatch' ||\n` +
        `   inputs.jobs == '' ||\n` +
        `   contains(format(',{0},', inputs.jobs), ',<job-name>,'))`,
    ).toEqual([]);
  });

  it("every aggregate job depends on every nightly E2E job", () => {
    const jobs = workflow.jobs as Record<string, unknown>;
    const missing: string[] = [];

    for (const aggregateJob of aggregateJobs) {
      const needs = new Set(getJobNeeds(jobs[aggregateJob]));
      for (const nightlyJob of nightlyJobs) {
        if (!needs.has(nightlyJob)) {
          missing.push(`${aggregateJob} -> ${nightlyJob}`);
        }
      }
    }

    expect(
      missing,
      `Nightly E2E aggregate jobs missing real E2E jobs in needs: ` +
        `${missing.join(", ")}. Update notify-on-failure, report-to-pr, ` +
        `and scorecard so their needs lists include every nightly E2E job.`,
    ).toEqual([]);
  });
});
