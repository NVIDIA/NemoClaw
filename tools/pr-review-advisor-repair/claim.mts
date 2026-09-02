#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  parseSelectionBundle,
  readBoundedJson,
  RepairContractError,
  sanitizeDiagnostic,
  type SelectionBundle,
} from "./contract.mts";
import { appendClaimJobSummary } from "./summary.mts";

const CLAIM_NAME = "Advisor repair attempt";
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CLAIM_CHECK_RUNS = 10_000;

type CheckRun = {
  id?: unknown;
  name?: unknown;
  external_id?: unknown;
};

type CheckRunList = {
  total_count?: unknown;
  check_runs?: unknown;
};

type GitHubRequest = <T>(
  apiPath: string,
  token: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

async function listRepairClaims(
  sourceHeadSha: string,
  token: string,
  request: GitHubRequest,
): Promise<CheckRun[]> {
  const checkRuns: CheckRun[] = [];
  const seenCheckRunIds = new Set<number>();
  let expectedTotal: number | undefined;
  for (let page = 1; checkRuns.length < MAX_CLAIM_CHECK_RUNS; page += 1) {
    const suffix = page === 1 ? "" : `&page=${page}`;
    const listing = await request<CheckRunList>(
      `repos/${CANONICAL_REPOSITORY}/commits/${sourceHeadSha}/check-runs?check_name=${encodeURIComponent(CLAIM_NAME)}&filter=all&per_page=${CHECK_RUN_PAGE_SIZE}${suffix}`,
      token,
    );
    if (
      !Number.isSafeInteger(listing.total_count) ||
      Number(listing.total_count) < 0 ||
      Number(listing.total_count) > MAX_CLAIM_CHECK_RUNS ||
      !Array.isArray(listing.check_runs) ||
      listing.check_runs.length > CHECK_RUN_PAGE_SIZE
    ) {
      throw new RepairContractError("repair attempt check listing is incomplete");
    }
    expectedTotal ??= Number(listing.total_count);
    if (Number(listing.total_count) !== expectedTotal) {
      throw new RepairContractError("repair attempt check listing changed during pagination");
    }
    const pageCheckRuns = listing.check_runs as CheckRun[];
    for (const { id } of pageCheckRuns) {
      const checkRunId = Number(id);
      if (!Number.isSafeInteger(id) || checkRunId < 1 || seenCheckRunIds.has(checkRunId)) {
        throw new RepairContractError("repair attempt check listing changed during pagination");
      }
      seenCheckRunIds.add(checkRunId);
    }
    checkRuns.push(...pageCheckRuns);
    if (checkRuns.length === expectedTotal) return checkRuns;
    if (checkRuns.length > expectedTotal || listing.check_runs.length === 0) break;
  }
  throw new RepairContractError("repair attempt check listing is incomplete");
}

export async function claimRepairAttempt(
  selection: SelectionBundle,
  token: string,
  detailsUrl: string,
  request: GitHubRequest = githubApi,
): Promise<number> {
  const checkRuns = await listRepairClaims(selection.input.sourceHeadSha, token, request);
  const duplicate = checkRuns.find(
    (check) => check.name === CLAIM_NAME && check.external_id === selection.attemptKey,
  );
  if (duplicate) {
    throw new RepairContractError("this exact repair attempt was already claimed");
  }
  const created = await request<{ id?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/check-runs`,
    token,
    {
      method: "POST",
      body: {
        name: CLAIM_NAME,
        head_sha: selection.input.sourceHeadSha,
        status: "completed",
        conclusion: "neutral",
        external_id: selection.attemptKey,
        details_url: detailsUrl,
        output: {
          title: "One maintainer-authorized repair attempt claimed",
          summary: [
            `Attempt: ${selection.attemptKey}`,
            `Advisor run: ${selection.input.advisor.runId} attempt ${selection.input.advisor.runAttempt}`,
            `Findings: ${selection.selectedFindingIds.join(", ")}`,
            "This neutral check records deduplication only; it is not a merge gate or validation result.",
          ].join("\n\n"),
        },
      },
    },
  );
  if (!Number.isSafeInteger(created.id) || Number(created.id) < 1) {
    throw new RepairContractError("GitHub did not return the repair claim check identity");
  }
  return Number(created.id);
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const selection = parseSelectionBundle(
    readBoundedJson(required(env, "SELECTION_FILE"), 1024 * 1024),
  );
  const checkId = await claimRepairAttempt(
    selection,
    required(env, "GITHUB_TOKEN"),
    required(env, "RUN_URL"),
  );
  const output = required(env, "GITHUB_OUTPUT");
  fs.appendFileSync(output, `check_id=${checkId}\n`);
  appendClaimJobSummary(env.GITHUB_STEP_SUMMARY, selection.attemptKey, checkId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
