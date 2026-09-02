#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
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

const CLAIM_NAME = "Advisor repair attempt";

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

export async function claimRepairAttempt(
  selection: SelectionBundle,
  token: string,
  detailsUrl: string,
  request: GitHubRequest = githubApi,
): Promise<number> {
  const listing = await request<CheckRunList>(
    `repos/${CANONICAL_REPOSITORY}/commits/${selection.input.sourceHeadSha}/check-runs?per_page=100`,
    token,
  );
  if (!Array.isArray(listing.check_runs) || listing.total_count !== listing.check_runs.length) {
    throw new RepairContractError("repair attempt check listing is incomplete");
  }
  const duplicate = (listing.check_runs as CheckRun[]).find(
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
