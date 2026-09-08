#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const PR_WORKFLOW_PATH = ".github/workflows/pr.yaml";
const SHA = /^[0-9a-f]{40}$/u;
const RUN_TITLE = /^CI PR #(\d+) head ([0-9a-f]{40}) base ([0-9a-f]{40}) gate true$/u;

type GreenChecksGateInput = {
  repository: string;
  sourceRunId: number;
  sourceRunAttempt: number;
  sourcePath: string;
  sourceEvent: string;
  sourceStatus: string;
  sourceConclusion: string;
  sourceHeadSha: string;
  sourceTitle: string;
};

type PullRequestResponse = {
  number?: unknown;
  state?: unknown;
  head?: { sha?: unknown };
  base?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
};

type WorkflowJobsResponse = {
  total_count?: unknown;
  jobs?: Array<{
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    head_sha?: unknown;
  }>;
};

export type GreenChecksGateTarget = {
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
};

type GreenChecksGateDependencies = {
  request?: (apiPath: string, token: string) => Promise<unknown>;
};

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function parseSourceRun(input: GreenChecksGateInput): {
  prNumber: number;
  headSha: string;
  baseSha: string;
} {
  if (input.repository !== REPOSITORY) throw new Error(`repository must be ${REPOSITORY}`);
  if (input.sourcePath !== PR_WORKFLOW_PATH) {
    throw new Error(`source workflow must be ${PR_WORKFLOW_PATH}`);
  }
  if (input.sourceEvent !== "pull_request") throw new Error("source event must be pull_request");
  if (input.sourceStatus !== "completed") throw new Error("source workflow must be completed");
  if (input.sourceConclusion !== "success") throw new Error("source workflow must be successful");
  const match = RUN_TITLE.exec(input.sourceTitle);
  if (!match) throw new Error("source workflow title must identify a required PR checks run");
  const prNumber = positiveInteger(match[1], "source PR number");
  const headSha = sha(match[2], "source title head SHA");
  const baseSha = sha(match[3], "source title base SHA");
  if (headSha !== input.sourceHeadSha) {
    throw new Error("source workflow title head SHA does not match the workflow run");
  }
  return { prNumber, headSha, baseSha };
}

export async function resolveGreenChecksGate(
  input: GreenChecksGateInput,
  token: string,
  dependencies: GreenChecksGateDependencies = {},
): Promise<GreenChecksGateTarget> {
  if (!Number.isSafeInteger(input.sourceRunId) || input.sourceRunId < 1) {
    throw new Error("source run ID must be a positive integer");
  }
  if (!Number.isSafeInteger(input.sourceRunAttempt) || input.sourceRunAttempt < 1) {
    throw new Error("source run attempt must be a positive integer");
  }
  const source = parseSourceRun(input);
  const request = dependencies.request ?? githubApi;
  const pull = (await request(
    `repos/${REPOSITORY}/pulls/${source.prNumber}`,
    token,
  )) as PullRequestResponse;
  const currentHeadSha = sha(pull.head?.sha, "current PR head SHA");
  const currentBaseSha = sha(pull.base?.sha, "current PR base SHA");
  const baseRef = required(
    typeof pull.base?.ref === "string" ? pull.base.ref : undefined,
    "current PR base ref",
  );
  if (
    pull.number !== source.prNumber ||
    pull.state !== "open" ||
    pull.base?.repo?.full_name !== REPOSITORY
  ) {
    throw new Error("source workflow does not identify an open NemoClaw pull request");
  }
  if (currentHeadSha !== source.headSha || currentBaseSha !== source.baseSha) {
    throw new Error("source workflow does not match the current PR revision");
  }

  const jobs = (await request(
    `repos/${REPOSITORY}/actions/runs/${input.sourceRunId}/attempts/${input.sourceRunAttempt}/jobs?per_page=100`,
    token,
  )) as WorkflowJobsResponse;
  if (
    !Number.isSafeInteger(jobs.total_count) ||
    (jobs.total_count as number) < 1 ||
    (jobs.total_count as number) > 100 ||
    !Array.isArray(jobs.jobs) ||
    jobs.jobs.length !== jobs.total_count
  ) {
    throw new Error("source workflow returned an incomplete job list");
  }
  const checks = jobs.jobs.filter((job) => job.name === "checks");
  if (checks.length !== 1) throw new Error("source workflow must contain one checks job");
  const check = checks[0]!;
  if (
    check.status !== "completed" ||
    check.conclusion !== "success" ||
    check.head_sha !== source.headSha
  ) {
    throw new Error("source workflow checks job must pass for the current PR revision");
  }

  return {
    repository: REPOSITORY,
    prNumber: source.prNumber,
    headSha: source.headSha,
    baseSha: source.baseSha,
    baseRef,
  };
}

function inputFromEnvironment(env: NodeJS.ProcessEnv): GreenChecksGateInput {
  return {
    repository: required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    sourceRunId: positiveInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
    sourceRunAttempt: positiveInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
    sourcePath: required(env.SOURCE_RUN_PATH, "SOURCE_RUN_PATH"),
    sourceEvent: required(env.SOURCE_RUN_EVENT, "SOURCE_RUN_EVENT"),
    sourceStatus: required(env.SOURCE_RUN_STATUS, "SOURCE_RUN_STATUS"),
    sourceConclusion: required(env.SOURCE_RUN_CONCLUSION, "SOURCE_RUN_CONCLUSION"),
    sourceHeadSha: sha(
      required(env.SOURCE_RUN_HEAD_SHA, "SOURCE_RUN_HEAD_SHA"),
      "SOURCE_RUN_HEAD_SHA",
    ),
    sourceTitle: required(env.SOURCE_RUN_TITLE, "SOURCE_RUN_TITLE"),
  };
}

async function main(): Promise<void> {
  const token = required(process.env.GH_TOKEN, "GH_TOKEN");
  const output = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const target = await resolveGreenChecksGate(inputFromEnvironment(process.env), token);
  fs.appendFileSync(
    output,
    [
      `target_repo=${target.repository}`,
      `pr_number=${target.prNumber}`,
      `head_sha=${target.headSha}`,
      `base_sha=${target.baseSha}`,
      `base_ref=${target.baseRef}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
