// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

type WorkflowNeed = {
  result?: unknown;
};

const CONTROLLER_JOBS = ["base-image-publication", "generate-matrix"] as const;
const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
): void {
  const needs = JSON.parse(needsJson) as Record<string, WorkflowNeed>;
  const releaseRequiredJobs = JSON.parse(releaseRequiredJobsJson) as unknown;
  if (!Array.isArray(releaseRequiredJobs)) {
    throw new Error("Release-required jobs must be a JSON array");
  }
  const invalidJobs = releaseRequiredJobs.filter(
    (job) => typeof job !== "string" || !JOB_ID_PATTERN.test(job),
  );
  if (invalidJobs.length > 0) {
    throw new Error(`Invalid release-required job IDs: ${invalidJobs.join(", ")}`);
  }
  const failedJobs = failedReleaseQualificationJobs(needs, releaseRequiredJobs as string[]);
  if (failedJobs.length > 0) {
    throw new Error(`Release qualification did not pass: ${failedJobs.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertReleaseQualification(
    process.env.NEEDS_JSON ?? "{}",
    process.env.RELEASE_REQUIRED_JOBS ?? "",
  );
}
