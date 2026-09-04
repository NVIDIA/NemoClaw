// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CANONICAL_REPOSITORY, RepairContractError } from "./contract.mts";

export const TRUSTED_GENERATED_HEAD_REF = "main";

const WORKFLOW_RUN_PAGE_SIZE = 100;
const MAX_WORKFLOW_RUNS = 10_000;

type GitHubRequest = <T>(apiPath: string, token: string) => Promise<T>;

export const GENERATED_HEAD_VALIDATIONS = [
  {
    workflow: "pr.yaml",
    titlePrefix: "Generated-head CI",
    requiredChecks: [
      { name: "changes", jobName: "changes" },
      { name: "checks", jobName: "checks" },
    ],
  },
  {
    workflow: "commit-lint.yaml",
    titlePrefix: "Generated-head title",
    requiredChecks: [{ name: "commit-lint", jobName: "commit-lint" }],
  },
  {
    workflow: "dco-check.yaml",
    titlePrefix: "Generated-head DCO",
    requiredChecks: [{ name: "dco-check", jobName: "dco-check" }],
  },
  {
    workflow: "installer-hash-check.yaml",
    titlePrefix: "Generated-head installer hash",
    requiredChecks: [{ name: "check-hash", jobName: "check-hash" }],
  },
  {
    workflow: "code-scanning.yaml",
    titlePrefix: "Generated-head CodeQL",
    requiredChecks: [],
  },
  {
    workflow: "pr-review-advisor.yaml",
    titlePrefix: "Generated-head Advisor",
    requiredChecks: [],
  },
] as const;

export const GENERATED_HEAD_WORKFLOW_NAMES = GENERATED_HEAD_VALIDATIONS.map(
  ({ workflow }) => workflow,
);

export function generatedHeadRunTitle(
  titlePrefix: string,
  attemptKey: string,
  commitSha: string,
): string {
  return `${titlePrefix} ${attemptKey} ${commitSha}`;
}

export async function listGeneratedHeadWorkflowRuns(
  workflow: string,
  token: string,
  request: GitHubRequest,
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  const seenRunIds = new Set<number>();
  let expectedTotal: number | undefined;
  for (let page = 1; collected.length < MAX_WORKFLOW_RUNS; page += 1) {
    const suffix = page === 1 ? "" : `&page=${page}`;
    const response = await request<{
      total_count?: unknown;
      workflow_runs?: unknown;
    }>(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${TRUSTED_GENERATED_HEAD_REF}&per_page=${WORKFLOW_RUN_PAGE_SIZE}${suffix}`,
      token,
    );
    if (
      !Number.isSafeInteger(response.total_count) ||
      Number(response.total_count) < 0 ||
      Number(response.total_count) > MAX_WORKFLOW_RUNS ||
      !Array.isArray(response.workflow_runs) ||
      response.workflow_runs.length > WORKFLOW_RUN_PAGE_SIZE
    ) {
      throw new RepairContractError(`${workflow} generated-head run listing is incomplete`);
    }
    expectedTotal ??= Number(response.total_count);
    if (Number(response.total_count) !== expectedTotal) {
      throw new RepairContractError(
        `${workflow} generated-head run listing changed during pagination`,
      );
    }
    const pageRuns = response.workflow_runs as Array<Record<string, unknown>>;
    for (const { id } of pageRuns) {
      const runId = Number(id);
      if (!Number.isSafeInteger(id) || runId < 1 || seenRunIds.has(runId)) {
        throw new RepairContractError(
          `${workflow} generated-head run listing changed during pagination`,
        );
      }
      seenRunIds.add(runId);
    }
    collected.push(...pageRuns);
    if (collected.length === expectedTotal) return collected;
    if (collected.length > expectedTotal || response.workflow_runs.length === 0) break;
  }
  throw new RepairContractError(`${workflow} generated-head run listing is incomplete`);
}
