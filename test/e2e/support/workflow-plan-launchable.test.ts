// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  renderE2eWorkflowPlanSummary,
  validateE2eWorkflowPlan,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { expectedWorkflowPlanCiOutput } from "./workflow-plan-test-assertions.ts";

vi.setConfig({ maxConcurrency: 4, testTimeout: 35_000 });

describe("E2E workflow plan Launchable selection", () => {
  it("includes staging only when the execution plan selects it (#9167)", () => {
    const stagingPlan = buildE2eWorkflowPlan(
      { jobs: "staging-brev-launchable" },
      { includeStagingBrevLaunchable: false },
    );

    expect(stagingPlan.selectedJobs).toEqual(["staging-brev-launchable"]);
    expect(stagingPlan.coverageMatrix).toEqual([
      expect.objectContaining({ id: "staging-brev-launchable", source: "staging" }),
    ]);

    const hermesPlan = buildE2eWorkflowPlan({ jobs: "hermes-e2e" });
    const stagingRow = buildE2eWorkflowPlan().coverageMatrix.find(
      (row) => row.id === "staging-brev-launchable",
    )!;
    expect(() =>
      validateE2eWorkflowPlan({
        ...hermesPlan,
        coverageMatrix: [stagingRow, ...hermesPlan.coverageMatrix],
      }),
    ).toThrow("execution coverage that does not match its execution plan");
  });

  it.each(["tools/e2e/brev-launchable-e2e.sh", ".github/workflows/e2e.yaml"])(
    "excludes opted-out Launchable from changed-file execution for %s without reducing the release floor",
    (changedFile) => {
      const options = { changedFiles: [changedFile] };
      const baseline = buildE2eWorkflowPlan({}, options);
      const plan = buildE2eWorkflowPlan({}, { ...options, includeStagingBrevLaunchable: false });
      expect(baseline.selectedJobs).toContain("staging-brev-launchable");
      expect(plan.selectedJobs).toEqual(
        baseline.selectedJobs.filter((job) => job !== "staging-brev-launchable"),
      );
      expect(plan.runtimeProvidersByJob).not.toHaveProperty("staging-brev-launchable");
      expect(plan.coverageMatrix.some((row) => row.id === "staging-brev-launchable")).toBe(false);
      expect(releaseRequiredWorkflowJobs()).toContain("staging-brev-launchable");
      expect(() => validateE2eWorkflowPlan(plan)).not.toThrow();
    },
  );

  it.each([false, true])(
    "includes every catalogue profile and respects Launchable opt-in %s for an authorized candidate",
    (includeStagingBrevLaunchable) => {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-pr-"));
      const output = path.join(directory, "github-output");
      const summary = path.join(directory, "summary.md");
      const plan = buildE2eWorkflowPlan({}, { includeStagingBrevLaunchable });
      try {
        writeE2eWorkflowPlanCiOutput(
          {},
          {
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "mock",
            NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
            NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
            NEMOCLAW_E2E_INCLUDE_STAGING_BREV_LAUNCHABLE: String(includeStagingBrevLaunchable),
          },
        );

        const outputs = Object.fromEntries(
          readFileSync(output, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        expect(JSON.parse(outputs.selected_workflow_jobs).includes("staging-brev-launchable")).toBe(
          includeStagingBrevLaunchable,
        );
        expect(JSON.parse(outputs.release_required_jobs)).toContain("staging-brev-launchable");
        expect(plan.coverageMatrix.some((row) => row.id === "staging-brev-launchable")).toBe(
          includeStagingBrevLaunchable,
        );
        expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
        expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
