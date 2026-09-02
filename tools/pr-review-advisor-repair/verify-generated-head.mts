#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import { CANONICAL_REPOSITORY, RepairContractError, sanitizeDiagnostic } from "./contract.mts";
import {
  GENERATED_HEAD_VALIDATIONS,
  generatedHeadRunTitle,
  TRUSTED_GENERATED_HEAD_REF,
} from "./generated-head-validation.mts";
import { appendGeneratedHeadJobSummary } from "./summary.mts";

const POLL_ATTEMPTS = 360;
const POLL_DELAY_MS = 15_000;

type GitHubRequest = <T>(
  apiPath: string,
  token: string,
  options?: { method?: "GET" | "POST"; body?: unknown },
) => Promise<T>;

type CheckRun = {
  id?: unknown;
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  external_id?: unknown;
  details_url?: unknown;
  app?: { slug?: unknown };
};

type WorkflowRun = {
  id?: unknown;
  run_attempt?: unknown;
  event?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  path?: unknown;
  status?: unknown;
  conclusion?: unknown;
  display_title?: unknown;
};

type WorkflowJob = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
};

type RequiredCheckEvidence = {
  name: string;
  detailsUrl: string;
  workflow: string;
  runId: number;
  jobId: number;
};

type VerificationState = "pending" | "success";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function fullSha(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new RepairContractError(`${name} must be a full SHA`);
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

function exactCompletion<T extends { status?: unknown; conclusion?: unknown }>(
  matches: T[],
  name: string,
): T | undefined {
  if (matches.length > 1) {
    throw new RepairContractError(`${name} has ambiguous generated-head validation results`);
  }
  if (matches.length === 0 || !completedSuccessfully(matches[0]!, name)) return undefined;
  return matches[0]!;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RepairContractError(`${name} has an invalid GitHub identity`);
  }
  return Number(value);
}

function expectedJobUrl(runId: number, jobId: number): string {
  return `https://github.com/${CANONICAL_REPOSITORY}/actions/runs/${runId}/job/${jobId}`;
}

async function collectSuccessfulWorkflowEvidence(input: {
  commitSha: string;
  baseSha: string;
  attemptKey: string;
  token: string;
  request: GitHubRequest;
}): Promise<RequiredCheckEvidence[] | undefined> {
  const requiredChecks: RequiredCheckEvidence[] = [];
  for (const validation of GENERATED_HEAD_VALIDATIONS) {
    const runs = await input.request<{ total_count?: unknown; workflow_runs?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/${validation.workflow}/runs?event=workflow_dispatch&branch=${TRUSTED_GENERATED_HEAD_REF}&per_page=100`,
      input.token,
    );
    if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) {
      throw new RepairContractError(
        `${validation.workflow} generated-head run listing is incomplete`,
      );
    }
    const matches = (runs.workflow_runs as WorkflowRun[]).filter(
      (run) =>
        run.event === "workflow_dispatch" &&
        run.head_branch === TRUSTED_GENERATED_HEAD_REF &&
        run.head_sha === input.baseSha &&
        run.path === `.github/workflows/${validation.workflow}` &&
        run.display_title ===
          generatedHeadRunTitle(validation.titlePrefix, input.attemptKey, input.commitSha),
    );
    const run = exactCompletion(matches, validation.workflow);
    if (!run) return undefined;
    const runId = positiveInteger(run.id, `${validation.workflow} run`);
    const runAttempt = positiveInteger(run.run_attempt, `${validation.workflow} run attempt`);
    if (validation.requiredChecks.length === 0) continue;

    const jobs = await input.request<{ total_count?: unknown; jobs?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
      input.token,
    );
    if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) {
      throw new RepairContractError(
        `${validation.workflow} generated-head job listing is incomplete`,
      );
    }
    for (const requiredCheck of validation.requiredChecks) {
      const job = exactCompletion(
        (jobs.jobs as WorkflowJob[]).filter(
          (candidate) => candidate.name === requiredCheck.jobName,
        ),
        requiredCheck.name,
      );
      if (!job) return undefined;
      const jobId = positiveInteger(job.id, `${requiredCheck.name} job`);
      const detailsUrl = expectedJobUrl(runId, jobId);
      if (job.html_url !== detailsUrl) {
        throw new RepairContractError(`${requiredCheck.name} job URL is not canonical`);
      }
      requiredChecks.push({
        name: requiredCheck.name,
        detailsUrl,
        workflow: validation.workflow,
        runId,
        jobId,
      });
    }
  }
  return requiredChecks;
}

async function attestRequiredChecks(input: {
  commitSha: string;
  attemptKey: string;
  token: string;
  request: GitHubRequest;
  evidence: RequiredCheckEvidence[];
}): Promise<void> {
  const checks = await input.request<{ total_count?: unknown; check_runs?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/commits/${input.commitSha}/check-runs?per_page=100`,
    input.token,
  );
  if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length) {
    throw new RepairContractError("generated-head check listing is incomplete");
  }
  for (const evidence of input.evidence) {
    const externalId = `${input.attemptKey}:required:${evidence.name}`;
    const matches = (checks.check_runs as CheckRun[]).filter(
      (check) => check.external_id === externalId,
    );
    if (matches.length > 1) {
      throw new RepairContractError(
        `${evidence.name} has ambiguous generated-head validation results`,
      );
    }
    if (matches.length === 1) {
      const check = matches[0]!;
      if (
        check.name !== evidence.name ||
        check.head_sha !== input.commitSha ||
        check.app?.slug !== "github-actions" ||
        check.status !== "completed" ||
        check.conclusion !== "success" ||
        check.details_url !== evidence.detailsUrl
      ) {
        throw new RepairContractError(`${evidence.name} generated-head attestation is malformed`);
      }
      continue;
    }
    const created = await input.request<{ id?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/check-runs`,
      input.token,
      {
        method: "POST",
        body: {
          name: evidence.name,
          head_sha: input.commitSha,
          status: "completed",
          conclusion: "success",
          external_id: externalId,
          details_url: evidence.detailsUrl,
          output: {
            title: `${evidence.name} passed on the exact generated head`,
            summary: `Trusted ${evidence.workflow} run ${evidence.runId}, job ${evidence.jobId}, validated repair attempt ${input.attemptKey}.`,
          },
        },
      },
    );
    positiveInteger(created.id, `${evidence.name} check run`);
  }
}

export async function verifyGeneratedHeadOnce(input: {
  commitSha: string;
  baseSha: string;
  attemptKey: string;
  token: string;
  request?: GitHubRequest;
}): Promise<VerificationState> {
  const request = input.request ?? githubApi;
  const evidence = await collectSuccessfulWorkflowEvidence({ ...input, request });
  if (!evidence) return "pending";
  await attestRequiredChecks({ ...input, request, evidence });
  return "success";
}

export async function waitForGeneratedHeadValidation(input: {
  commitSha: string;
  baseSha: string;
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
  const commitSha = fullSha(required(env, "COMMIT_SHA"), "COMMIT_SHA");
  const baseSha = fullSha(required(env, "BASE_SHA"), "BASE_SHA");
  const attemptKey = required(env, "ATTEMPT_KEY");
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptKey)) {
    throw new RepairContractError("ATTEMPT_KEY is malformed");
  }
  await waitForGeneratedHeadValidation({
    commitSha,
    baseSha,
    attemptKey,
    token: required(env, "GITHUB_TOKEN"),
  });
  appendGeneratedHeadJobSummary(env.GITHUB_STEP_SUMMARY, attemptKey, commitSha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
