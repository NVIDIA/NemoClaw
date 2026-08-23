#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getChangedFiles, getDiff, getHeadSha } from "../advisors/git.mts";
import { parseArgs, parsePositiveInt } from "../advisors/io.mts";
import {
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_PROVIDER,
  advisorRunErrors,
  runReadOnlyAdvisor,
  type RunAdvisorResult,
  type RunReadOnlyAdvisorOptions,
} from "../advisors/session.mts";
import { collectDeterministicContext } from "./deterministic-context.mts";
import { collectGitHubReviewContext } from "./github-context.mts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  buildSpecialistInvestigateTurn,
  parseAdvisorInterest,
  type AdvisorInterest,
} from "./specialists.mts";
import { createTerminologyToolController } from "./terminology.mts";
import {
  buildSystemPrompt,
  readParsedTrustedSecurityRubric,
  readTrustedControlledWords,
} from "./trusted-guidance.mts";
import {
  buildCorrectnessTurnContext,
  buildOperationsTurnContext,
  buildReconciliationTurnContext,
  buildScopeRiskTurnContext,
  buildSecurityTurnContext,
  buildTestsTurnContext,
} from "./turn-context.mts";

const CREDENTIAL_ENV = ["PR", "REVIEW", "ADVISOR", "API", "KEY"].join("_");

export function documentationSpecialistTools(
  interest: AdvisorInterest,
  { baseRef, headRef, cwd = process.cwd() }: { baseRef: string; headRef: string; cwd?: string },
): ToolDefinition[] {
  return interest === "documentation"
    ? createTerminologyToolController({ baseRef, headRef, cwd }).tools
    : [];
}

export function renderSpecialistSummary(interest: AdvisorInterest, text: string): string {
  const title = interest
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" / ");
  return `# PR Review Advisor — ${title} specialist\n\n> Evidence for synthesis and human review. Synthesis publishes the final review.\n\n${text.trim()}\n`;
}

export function writeSpecialistSummary(
  outDir: string,
  interest: AdvisorInterest,
  text: string,
): string {
  const file = path.join(outDir, `pr-review-${interest}-summary.md`);
  fs.writeFileSync(file, renderSpecialistSummary(interest, text));
  return file;
}

export function runSpecialistAdvisor(
  interest: AdvisorInterest,
  refs: { baseRef: string; headRef: string },
  options: Omit<RunReadOnlyAdvisorOptions, "customTools">,
  run: (options: RunReadOnlyAdvisorOptions) => Promise<RunAdvisorResult> = runReadOnlyAdvisor,
): Promise<RunAdvisorResult> {
  return run({
    ...options,
    customTools: documentationSpecialistTools(interest, { ...refs, cwd: options.cwd }),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactName = process.env.PR_REVIEW_ADVISOR_ARTIFACT_DIR || "pr-review-specialist";
  const outDir =
    args.outDir ||
    path.join(process.env.GITHUB_WORKSPACE || process.cwd(), "artifacts", artifactName);
  const baseRef = args.base || process.env.BASE_REF || "origin/main";
  const headRef = args.head || process.env.HEAD_REF || "HEAD";
  const interest = parseAdvisorInterest(
    args.interest || process.env.PR_REVIEW_ADVISOR_INTEREST || "",
  );
  const configDir =
    process.env.PR_REVIEW_ADVISOR_CONFIG_DIR ||
    path.join("/tmp", `nemoclaw-pr-review-specialist-${interest}-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });

  const changedFiles = getChangedFiles(baseRef, headRef);
  const headSha = getHeadSha(headRef);
  const diff = getDiff(baseRef, headRef);
  const deterministic = await collectDeterministicContext(
    { baseRef, headRef, headSha, changedFiles, diff },
    { collectGitHubContext: () => collectGitHubReviewContext({ baseRef, headRef, headSha }) },
  );
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const diffDirectory = path.join(process.cwd(), ".pr-review-advisor-context");
  fs.mkdirSync(diffDirectory, { recursive: true });
  const diffPath = path.join(diffDirectory, "diff.patch");
  fs.writeFileSync(diffPath, diff);

  const turn = buildSpecialistInvestigateTurn(interest, {
    metadata: JSON.stringify({ version: 1, baseRef, headRef, headSha, changedFiles }, null, 2),
    scopeRisk: buildScopeRiskTurnContext(deterministic),
    diffPath: path.relative(process.cwd(), diffPath),
    controlledWords: readTrustedControlledWords(),
    terminology: {
      issueReferenceLines: deterministic.github?.issueReferenceLines ?? [],
      linkedIssues: deterministic.github?.linkedIssues ?? [],
      githubFetchError: deterministic.github?.fetchError,
    },
    correctness: buildCorrectnessTurnContext(deterministic),
    security: buildSecurityTurnContext(deterministic),
    tests: buildTestsTurnContext(deterministic),
    operations: buildOperationsTurnContext(deterministic),
    reconciliation: buildReconciliationTurnContext(deterministic),
  });
  const run = await runSpecialistAdvisor(
    interest,
    { baseRef, headRef },
    {
      cwd: process.cwd(),
      promptTurns: [turn],
      systemPrompt: buildSystemPrompt(readParsedTrustedSecurityRubric()),
      configDir,
      timeoutMs: parsePositiveInt(process.env.PR_REVIEW_ADVISOR_TIMEOUT_MS, 900000),
      heartbeatMs: parsePositiveInt(process.env.PR_REVIEW_ADVISOR_HEARTBEAT_MS, 60000),
      maxCaptureBytes: parsePositiveInt(
        process.env.PR_REVIEW_ADVISOR_MAX_CAPTURE_BYTES,
        5 * 1024 * 1024,
      ),
      provider: DEFAULT_ADVISOR_PROVIDER,
      modelId: process.env.PR_REVIEW_ADVISOR_MODEL || DEFAULT_ADVISOR_MODEL,
      credentialEnv: CREDENTIAL_ENV,
      logPrefix: `pr-review-${interest}`,
      logProgress: (message) => console.log(`[pr-review-${interest}] ${message}`),
    },
  );
  const errors = advisorRunErrors(run);
  if (errors.length > 0) throw new Error(errors.join("; "));
  writeSpecialistSummary(outDir, interest, run.text);
  if (!run.sessionFile) throw new Error("Pi did not persist a specialist JSONL session");
  const sessionStat = fs.lstatSync(run.sessionFile);
  if (!sessionStat.isFile() || sessionStat.isSymbolicLink()) {
    throw new Error("Pi specialist session must be a regular file");
  }
  fs.copyFileSync(run.sessionFile, path.join(outDir, `pr-review-${interest}-session.jsonl`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
