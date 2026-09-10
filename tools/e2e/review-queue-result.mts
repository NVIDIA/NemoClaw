// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type JobResult = "success" | "failure" | "cancelled" | "skipped";
type ResultIdentity = {
  repository: string;
  prNumber: number;
  candidateSha: string;
  baseSha: string;
  workflowSha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
};

export function buildReviewQueueResult(
  identity: ResultIdentity,
  selected: unknown,
  needs: unknown,
) {
  if (
    identity.repository !== "NVIDIA/NemoClaw" ||
    !Number.isSafeInteger(identity.prNumber) ||
    identity.prNumber < 1 ||
    ![identity.candidateSha, identity.baseSha, identity.workflowSha].every((sha) =>
      /^[a-f0-9]{40}$/.test(sha),
    ) ||
    !/^[1-9][0-9]*$/.test(identity.workflowRunId) ||
    !Number.isSafeInteger(identity.workflowRunAttempt) ||
    identity.workflowRunAttempt < 1
  ) {
    throw new Error("Invalid review queue result identity");
  }
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > 200 ||
    selected.includes("generate-matrix") ||
    selected.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error("Missing, empty, or invalid selected workflow jobs");
  }
  if (!needs || typeof needs !== "object" || Array.isArray(needs))
    throw new Error("Missing workflow results");
  const byId = needs as Record<string, { result?: unknown }>;
  const results = [...new Set(["generate-matrix", ...selected])].map((job: string) => {
    const result = byId[job]?.result;
    if (!["success", "failure", "cancelled", "skipped"].includes(String(result)))
      throw new Error(`Missing or invalid result for ${job}`);
    return { job, result: result as JobResult };
  });
  return {
    kind: "nemoclaw-review-queue-e2e-result-v1" as const,
    ...identity,
    selectedWorkflowJobs: [...selected] as string[],
    results,
    status: results.some(({ result }) => result === "failure")
      ? ("fail" as const)
      : results.every(({ result }) => result === "success")
        ? ("pass" as const)
        : ("unknown" as const),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const receipt = buildReviewQueueResult(
    {
      repository: env.GITHUB_REPOSITORY ?? "",
      prNumber: Number(env.PR_NUMBER),
      candidateSha: env.CANDIDATE_SHA ?? "",
      baseSha: env.BASE_SHA ?? "",
      workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
      workflowRunId: env.GITHUB_RUN_ID ?? "",
      workflowRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    JSON.parse(env.SELECTED_WORKFLOW_JOBS ?? "null"),
    JSON.parse(env.NEEDS_JSON ?? "null"),
  );
  if (!process.argv[2]) throw new Error("Result output path is required");
  writeFileSync(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
