#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  parseFullSha as fullSha,
  RepairContractError,
  requiredEnvironment as required,
  sanitizeDiagnostic,
} from "./contract.mts";
import {
  assertGeneratedHeadPullRequestIdentity,
  type GeneratedHeadPullRequest,
} from "./generated-head-context.mts";
import {
  GENERATED_HEAD_VALIDATIONS,
  generatedHeadRunTitle,
  listGeneratedHeadWorkflowRuns,
  TRUSTED_GENERATED_HEAD_REF,
} from "./generated-head-validation.mts";

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

export type GeneratedHeadVerificationReceipt = {
  version: 1;
  attemptKey: string;
  sourceHeadSha: string;
  baseSha: string;
  commitSha: string;
  outcome: "success" | "manual-remediation-required";
  failureClass: "none" | "gate-failed" | "evidence-invalid" | "timed-out";
  failedGate: string | null;
};

class GeneratedHeadGateError extends RepairContractError {
  constructor(readonly gate: string) {
    super(`${gate} failed generated-head validation`);
  }
}

function completedSuccessfully(
  item: { status?: unknown; conclusion?: unknown },
  name: string,
): boolean {
  if (item.status !== "completed") return false;
  if (item.conclusion !== "success") {
    throw new GeneratedHeadGateError(name);
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
  const [match] = matches;
  if (!match || !completedSuccessfully(match, name)) return undefined;
  return match;
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
    const runs = await listGeneratedHeadWorkflowRuns(
      validation.workflow,
      input.token,
      input.request,
    );
    const matches = (runs as WorkflowRun[]).filter(
      (run) =>
        run.event === "workflow_dispatch" &&
        run.head_branch === TRUSTED_GENERATED_HEAD_REF &&
        typeof run.head_sha === "string" &&
        /^[0-9a-f]{40}$/u.test(run.head_sha) &&
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
  const checks = await input.request<{
    total_count?: unknown;
    check_runs?: unknown;
  }>(
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
    const [check] = matches;
    if (check) {
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
  prNumber: number;
  commitSha: string;
  baseSha: string;
  attemptKey: string;
  token: string;
  request?: GitHubRequest;
}): Promise<VerificationState> {
  const request = input.request ?? githubApi;
  const evidence = await collectSuccessfulWorkflowEvidence({
    ...input,
    request,
  });
  if (!evidence) return "pending";
  const pull = await request<GeneratedHeadPullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${input.prNumber}`,
    input.token,
  );
  assertGeneratedHeadPullRequestIdentity(pull, {
    prNumber: input.prNumber,
    sourceHeadSha: input.commitSha,
    baseSha: input.baseSha,
  });
  await attestRequiredChecks({ ...input, request, evidence });
  return "success";
}

export async function waitForGeneratedHeadValidation(input: {
  prNumber: number;
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

function verificationFailure(
  error: unknown,
): Pick<GeneratedHeadVerificationReceipt, "failureClass" | "failedGate"> {
  if (error instanceof GeneratedHeadGateError) {
    return { failureClass: "gate-failed", failedGate: error.gate };
  }
  if (
    error instanceof RepairContractError &&
    error.message === "generated-head validation did not complete within ninety minutes"
  ) {
    return { failureClass: "timed-out", failedGate: null };
  }
  return { failureClass: "evidence-invalid", failedGate: null };
}

function writeVerificationReceipt(
  outputDirectory: string,
  receipt: GeneratedHeadVerificationReceipt,
): void {
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(outputDirectory, "generated-head-verification-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

export async function verifyGeneratedHeadWithReceipt(input: {
  prNumber: number;
  commitSha: string;
  sourceHeadSha: string;
  baseSha: string;
  attemptKey: string;
  token: string;
  outputDirectory: string;
  request?: GitHubRequest;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<GeneratedHeadVerificationReceipt> {
  try {
    await waitForGeneratedHeadValidation(input);
  } catch (error) {
    const receipt: GeneratedHeadVerificationReceipt = {
      version: 1,
      attemptKey: input.attemptKey,
      sourceHeadSha: input.sourceHeadSha,
      baseSha: input.baseSha,
      commitSha: input.commitSha,
      outcome: "manual-remediation-required",
      ...verificationFailure(error),
    };
    writeVerificationReceipt(input.outputDirectory, receipt);
    throw error;
  }
  const receipt: GeneratedHeadVerificationReceipt = {
    version: 1,
    attemptKey: input.attemptKey,
    sourceHeadSha: input.sourceHeadSha,
    baseSha: input.baseSha,
    commitSha: input.commitSha,
    outcome: "success",
    failureClass: "none",
    failedGate: null,
  };
  writeVerificationReceipt(input.outputDirectory, receipt);
  return receipt;
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const prNumber = positiveInteger(Number(required(env, "PR_NUMBER")), "PR_NUMBER");
  const commitSha = fullSha(required(env, "COMMIT_SHA"), "COMMIT_SHA");
  const sourceHeadSha = fullSha(required(env, "SOURCE_HEAD_SHA"), "SOURCE_HEAD_SHA");
  const baseSha = fullSha(required(env, "BASE_SHA"), "BASE_SHA");
  const attemptKey = required(env, "ATTEMPT_KEY");
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptKey)) {
    throw new RepairContractError("ATTEMPT_KEY is malformed");
  }
  await verifyGeneratedHeadWithReceipt({
    prNumber,
    commitSha,
    sourceHeadSha,
    baseSha,
    attemptKey,
    token: required(env, "GITHUB_TOKEN"),
    outputDirectory: required(env, "VERIFICATION_OUTPUT_DIR"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
