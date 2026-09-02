#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import { CANONICAL_REPOSITORY, RepairContractError, sanitizeDiagnostic } from "./contract.mts";

const REQUIRED_CHECKS = ["changes", "checks", "commit-lint", "dco-check", "check-hash"] as const;
const REQUIRED_WORKFLOWS = ["code-scanning.yaml", "pr-review-advisor.yaml"] as const;
const POLL_ATTEMPTS = 360;
const POLL_DELAY_MS = 15_000;

type GitHubRequest = <T>(apiPath: string, token: string) => Promise<T>;

type CheckRun = {
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  app?: { slug?: unknown };
};

type WorkflowRun = {
  event?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  display_title?: unknown;
};

type VerificationState = "pending" | "success";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function completedSuccessfully(
  item: { status?: unknown; conclusion?: unknown },
  name: string,
): boolean {
  if (item.status !== "completed") return false;
  if (item.conclusion !== "success") {
    throw new RepairContractError(`${name} failed generated-head validation`);
  }
  return true;
}

export async function verifyGeneratedHeadOnce(input: {
  commitSha: string;
  headRef: string;
  attemptKey: string;
  token: string;
  request?: GitHubRequest;
}): Promise<VerificationState> {
  const request = input.request ?? githubApi;
  const checks = await request<{ total_count?: unknown; check_runs?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/commits/${input.commitSha}/check-runs?per_page=100`,
    input.token,
  );
  if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length) {
    throw new RepairContractError("generated-head check listing is incomplete");
  }
  let pending = false;
  for (const name of REQUIRED_CHECKS) {
    const matches = (checks.check_runs as CheckRun[]).filter(
      (check) =>
        check.name === name &&
        check.head_sha === input.commitSha &&
        check.app?.slug === "github-actions",
    );
    if (matches.length === 0) {
      pending = true;
      continue;
    }
    if (!matches.some((check) => completedSuccessfully(check, name))) pending = true;
  }

  for (const workflow of REQUIRED_WORKFLOWS) {
    const runs = await request<{ total_count?: unknown; workflow_runs?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(input.headRef)}&per_page=100`,
      input.token,
    );
    if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) {
      throw new RepairContractError(`${workflow} generated-head run listing is incomplete`);
    }
    const matches = (runs.workflow_runs as WorkflowRun[]).filter(
      (run) =>
        run.event === "workflow_dispatch" &&
        run.head_sha === input.commitSha &&
        typeof run.display_title === "string" &&
        run.display_title.includes(input.attemptKey),
    );
    if (matches.length === 0) {
      pending = true;
      continue;
    }
    if (!matches.some((run) => completedSuccessfully(run, workflow))) pending = true;
  }
  return pending ? "pending" : "success";
}

export async function waitForGeneratedHeadValidation(input: {
  commitSha: string;
  headRef: string;
  attemptKey: string;
  token: string;
  request?: GitHubRequest;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const wait =
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    if ((await verifyGeneratedHeadOnce(input)) === "success") return;
    if (attempt < POLL_ATTEMPTS) await wait(POLL_DELAY_MS);
  }
  throw new RepairContractError("generated-head validation did not complete within ninety minutes");
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const commitSha = required(env, "COMMIT_SHA");
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new RepairContractError("COMMIT_SHA must be a full SHA");
  }
  const attemptKey = required(env, "ATTEMPT_KEY");
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptKey)) {
    throw new RepairContractError("ATTEMPT_KEY is malformed");
  }
  await waitForGeneratedHeadValidation({
    commitSha,
    headRef: required(env, "HEAD_REF"),
    attemptKey,
    token: required(env, "GITHUB_TOKEN"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
