// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

type WorkflowNeed = {
  result?: unknown;
};

const CONTROLLER_JOBS = ["base-image-publication", "generate-matrix"] as const;
const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function parseJobIds(value: string, label: string, invalidLabel = label.toLowerCase()): string[] {
  const jobs = JSON.parse(value) as unknown;
  if (!Array.isArray(jobs)) {
    throw new Error(`${label} must be a JSON array`);
  }
  const invalidJobs = jobs.filter((job) => typeof job !== "string" || !JOB_ID_PATTERN.test(job));
  if (invalidJobs.length > 0) {
    throw new Error(`Invalid ${invalidLabel}: ${invalidJobs.join(", ")}`);
  }
  if (new Set(jobs).size !== jobs.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return jobs as string[];
}

export function failedReleaseQualificationJobs(
  needs: Record<string, WorkflowNeed>,
  releaseRequiredJobs: readonly string[],
): string[] {
  return [...CONTROLLER_JOBS, ...releaseRequiredJobs].filter(
    (job) => needs[job]?.result !== "success",
  );
}

export function assertReleaseQualification(
  needsJson: string,
  releaseRequiredJobsJson: string,
  evidence?: { outputPath: string; runId: string; attempt: string },
): void {
  const needs = JSON.parse(needsJson) as Record<string, WorkflowNeed>;
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("Missing workflow results");
  }
  const releaseRequiredJobs = parseJobIds(
    releaseRequiredJobsJson,
    "Release-required jobs",
    "release-required job IDs",
  );
  const failedJobs = failedReleaseQualificationJobs(needs, releaseRequiredJobs);
  if (evidence) {
    if (!/^[1-9][0-9]*$/.test(evidence.runId) || !/^[1-9][0-9]*$/.test(evidence.attempt)) {
      throw new Error("Invalid dispatch receipt reference");
    }
    if (
      releaseRequiredJobs.length === 0 ||
      releaseRequiredJobs.length > 200 ||
      releaseRequiredJobs.some((job) => CONTROLLER_JOBS.some((controller) => job === controller))
    ) {
      throw new Error("PR evidence requires a nonempty bounded selection");
    }
    const results = [...new Set([...CONTROLLER_JOBS, ...releaseRequiredJobs])].map((job) => ({
      job,
      result: needs[job]?.result ?? null,
    }));
    writeFileSync(
      evidence.outputPath,
      `${JSON.stringify(
        {
          kind: "nemoclaw-review-queue-e2e-result-v1",
          dispatchArtifact: `e2e-dispatch-${evidence.runId}-${evidence.attempt}`,
          selectedWorkflowJobs: releaseRequiredJobs,
          results,
          status:
            failedJobs.length === 0
              ? "pass"
              : results.some(({ result }) => result === "failure")
                ? "fail"
                : "unknown",
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  if (failedJobs.length > 0) {
    throw new Error(`Release qualification did not pass: ${failedJobs.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertReleaseQualification(
    process.env.NEEDS_JSON ?? "{}",
    process.env.RELEASE_REQUIRED_JOBS ?? "",
    process.env.E2E_RESULT_PATH
      ? {
          outputPath: process.env.E2E_RESULT_PATH,
          runId: process.env.GITHUB_RUN_ID ?? "",
          attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
        }
      : undefined,
  );
}
