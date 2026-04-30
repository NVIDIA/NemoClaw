// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-validate E2E test recommendations in .coderabbit.yaml against the
 * actual nightly-e2e.yaml workflow.
 *
 * Catches:
 * - Stale job names in CodeRabbit instructions (job renamed or removed)
 * - Stale file path globs in CodeRabbit instructions (file renamed or deleted)
 * - Nightly E2E jobs with no CodeRabbit path_instructions coverage (new job
 *   added but no mapping created)
 * - Nightly E2E jobs missing the selective dispatch guard in their `if:` condition
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

/**
 * Extract the `if:` condition string from a workflow job object.
 */
function getJobIf(job: unknown): string | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const record = job as Record<string, unknown>;
  if (typeof record.if === "string") return record.if;
  return undefined;
}

/**
 * Extract all E2E job names referenced inside CodeRabbit path_instructions
 * that are part of the E2E recommendation block (contain "-e2e").
 */
function getReferencedJobNames(coderabbit: Record<string, unknown>): Set<string> {
  const reviews = coderabbit.reviews as Record<string, unknown> | undefined;
  if (!reviews) return new Set();

  const pathInstructions = reviews.path_instructions as
    | Array<{ path: string; instructions: string }>
    | undefined;
  if (!pathInstructions) return new Set();

  const jobNames = new Set<string>();
  // Match job names inside backticks: `cloud-e2e`, `sandbox-survival-e2e`
  // or in the gh workflow run -f jobs= argument.
  // This avoids false positives from prose like "nightly-e2e.yaml" or
  // "forward-proxy-e2e exists".
  const backtickPattern = /`([a-z][-a-z]*-e2e)`/g;
  const jobsArgPattern = /-f jobs=([a-z][-a-z,]*-e2e)/g;

  for (const entry of pathInstructions) {
    const instructions =
      typeof entry.instructions === "string" ? entry.instructions : "";
    for (const match of instructions.matchAll(backtickPattern)) {
      jobNames.add(match[1]);
    }
    for (const match of instructions.matchAll(jobsArgPattern)) {
      for (const name of match[1].split(",")) {
        jobNames.add(name);
      }
    }
  }
  return jobNames;
}

/**
 * Extract E2E path_instructions entries (those containing "-e2e" in instructions).
 * Returns the path globs.
 */
function getE2ePathGlobs(coderabbit: Record<string, unknown>): string[] {
  const reviews = coderabbit.reviews as Record<string, unknown> | undefined;
  if (!reviews) return [];

  const pathInstructions = reviews.path_instructions as
    | Array<{ path: string; instructions: string }>
    | undefined;
  if (!pathInstructions) return [];

  return pathInstructions
    .filter((entry) => {
      const instructions =
        typeof entry.instructions === "string" ? entry.instructions : "";
      return instructions.includes("-e2e");
    })
    .map((entry) => entry.path);
}

/**
 * Check if a path glob matches at least one file in the repo.
 * Handles exact paths, directory patterns (agents/hermes/**), and
 * simple wildcards (src/lib/shields*.ts).
 *
 * Not a full glob implementation — covers the patterns we actually use.
 */
function globMatchesAnyFile(glob: string): boolean {
  // Exact file path
  if (!glob.includes("*")) {
    return existsSync(repoPath(glob));
  }

  // Directory wildcard: "agents/hermes/**" or "nemoclaw-blueprint/policies/**"
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3);
    const fullDir = repoPath(dir);
    return existsSync(fullDir) && statSync(fullDir).isDirectory();
  }

  // Simple wildcard in filename: "src/lib/shields*.ts"
  const lastSlash = glob.lastIndexOf("/");
  const dir = glob.substring(0, lastSlash);
  const pattern = glob.substring(lastSlash + 1);

  const fullDir = repoPath(dir);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) return false;

  // Convert simple glob to regex: "shields*.ts" -> /^shields.*\.ts$/
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);

  const files = readdirSync(fullDir);
  return files.some((f) => regex.test(f));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E coverage cross-validation", () => {
  const coderabbit = loadYaml(".coderabbit.yaml");
  const workflow = loadYaml(".github/workflows/nightly-e2e.yaml");

  const nightlyJobs = getNightlyJobNames(workflow);
  const referencedJobs = getReferencedJobNames(coderabbit);
  const e2ePathGlobs = getE2ePathGlobs(coderabbit);

  it("every job name in CodeRabbit instructions exists in nightly-e2e.yaml", () => {
    const stale = [...referencedJobs].filter(
      (name) => !nightlyJobs.includes(name),
    );
    expect(
      stale,
      `Stale E2E job names in .coderabbit.yaml path_instructions ` +
        `(not found in nightly-e2e.yaml): ${stale.join(", ")}. ` +
        `Update or remove these from the CodeRabbit E2E recommendations.`,
    ).toEqual([]);
  });

  it("every E2E path glob in CodeRabbit instructions matches at least one file", () => {
    const stale = e2ePathGlobs.filter((glob) => !globMatchesAnyFile(glob));
    expect(
      stale,
      `Stale file path globs in .coderabbit.yaml E2E path_instructions ` +
        `(no matching files): ${stale.join(", ")}. ` +
        `The referenced files may have been renamed or deleted.`,
    ).toEqual([]);
  });

  it("every nightly E2E job has at least one CodeRabbit path_instructions entry", () => {
    const uncovered = nightlyJobs.filter((name) => !referencedJobs.has(name));
    // This is a warning-level check: some jobs (e.g., diagnostics-e2e,
    // upgrade-stale-sandbox-e2e) may intentionally lack path-based
    // recommendations. We still flag them so maintainers can decide.
    if (uncovered.length > 0) {
      console.warn(
        `⚠️  Nightly E2E jobs with no CodeRabbit path_instructions coverage: ` +
          `${uncovered.join(", ")}. ` +
          `Consider adding path_instructions entries in .coderabbit.yaml ` +
          `for the source files these jobs exercise.`,
      );
    }
    // Intentionally does not fail — this is advisory.
    expect(true).toBe(true);
  });

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
});
