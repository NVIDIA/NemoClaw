// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

type WorkflowNeed = {
  result?: unknown;
};

const CONTROLLER_JOBS = ["base-image-publication", "generate-matrix"] as const;
const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COMPLETED_WORKFLOW_RESULTS = new Set(["failure", "success"]);

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
  releaseQualificationWaivedJobsJson = "[]",
): void {
  const needs = JSON.parse(needsJson) as Record<string, WorkflowNeed>;
  const releaseRequiredJobs = parseJobIds(
    releaseRequiredJobsJson,
    "Release-required jobs",
    "release-required job IDs",
  );
  const waivedJobs = parseJobIds(
    releaseQualificationWaivedJobsJson,
    "Release qualification waived jobs",
  );
  const controllerWaivers = waivedJobs.filter((job) =>
    (CONTROLLER_JOBS as readonly string[]).includes(job),
  );
  if (controllerWaivers.length > 0) {
    throw new Error(`Release controller jobs cannot be waived: ${controllerWaivers.join(", ")}`);
  }
  const requiredJobSet = new Set(releaseRequiredJobs);
  const overlappingJobs = waivedJobs.filter((job) => requiredJobSet.has(job));
  if (overlappingJobs.length > 0) {
    throw new Error(`Waived jobs remain release-required: ${overlappingJobs.join(", ")}`);
  }
  const invalidWaiverEvidence = waivedJobs.filter(
    (job) => !COMPLETED_WORKFLOW_RESULTS.has(String(needs[job]?.result ?? "")),
  );
  if (invalidWaiverEvidence.length > 0) {
    throw new Error(
      `Waived jobs must finish with success or failure: ${invalidWaiverEvidence.join(", ")}`,
    );
  }
  const failedJobs = failedReleaseQualificationJobs(needs, releaseRequiredJobs);
  if (failedJobs.length > 0) {
    throw new Error(`Release qualification did not pass: ${failedJobs.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertReleaseQualification(
    process.env.NEEDS_JSON ?? "{}",
    process.env.RELEASE_REQUIRED_JOBS ?? "",
    process.env.RELEASE_QUALIFICATION_WAIVED_JOBS ?? "[]",
  );
}
