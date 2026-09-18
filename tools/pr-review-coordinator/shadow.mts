// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getPath, isObjectRecord, stringOrUndefined } from "../advisors/json.mts";
import {
  type AdvisorBlockerGateResult,
  evaluateAdvisorBlockers,
} from "../pr-review-advisor/blocker-gate.mts";
import {
  type AdvisorFindingLedger,
  parseAdvisorFindingLedger,
} from "../pr-review-advisor/finding-ledger.mts";
import {
  type GitHubReviewContext,
  readPreparedGitHubContext,
} from "../pr-review-advisor/github-context.mts";
import { ADVISOR_INTERESTS } from "../pr-review-advisor/specialist-catalog.mts";
import { type CoordinatorSnapshot, decideReviewAction } from "./decision.mts";

const MAX_SHADOW_INPUT_BYTES = 1024 * 1024;
const OUTPUT_DIRECTORY = "artifacts/pr-review-coordinator-shadow";

type ShadowInput = Readonly<{
  context: GitHubReviewContext;
  gate: AdvisorBlockerGateResult;
  ledgers: readonly AdvisorFindingLedger[];
  prNumber: number;
  headSha: string;
  baseSha: string;
}>;

export function buildCoordinatorShadowSnapshot(input: ShadowInput): CoordinatorSnapshot {
  const pullRequest = record(input.context.pullRequest, "pull request context");
  const contextHead = stringOrUndefined(getPath<unknown>(pullRequest, ["head", "sha"]));
  const contextBase = stringOrUndefined(getPath<unknown>(pullRequest, ["base", "sha"]));
  if (
    input.context.prNumber !== input.prNumber ||
    contextHead !== input.headSha ||
    contextBase !== input.baseSha
  ) {
    throw new Error("Coordinator shadow context does not match the exact Advisor revision");
  }
  const author = stringOrUndefined(getPath<unknown>(pullRequest, ["user", "login"]));
  if (!author) throw new Error("Coordinator shadow context is missing the pull request author");

  const findings = input.ledgers.flatMap((ledger) =>
    ledger.findings.map((finding) => ({
      id: finding.id,
      contractKey: finding.id,
      severity: finding.severity,
      summary: finding.summary,
      path: finding.path,
      // Shadow mode preserves model findings as ambiguous evidence. A future
      // writer must validate claims and reconstruct the frozen contract first.
      validation: "ambiguous" as const,
      relationship: "existing-contract" as const,
    })),
  );
  const advisor =
    input.gate.status === "clear"
      ? {
          identity: "exact-head" as const,
          headSha: input.headSha,
          baseSha: input.baseSha,
          status: "clear" as const,
          findings: [],
        }
      : findings.length > 0
        ? {
            identity: "exact-head" as const,
            headSha: input.headSha,
            baseSha: input.baseSha,
            status: "blocked" as const,
            findings,
          }
        : null;
  const state = stringOrUndefined(pullRequest.state)?.toUpperCase();
  const mergeable = pullRequest.mergeable;
  return {
    version: 1,
    pullRequest: {
      number: input.prNumber,
      state: state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "CLOSED",
      draft: pullRequest.draft === true,
      author,
      reviewer: "nemoclaw-review-coordinator[bot]",
      headSha: input.headSha,
      baseSha: input.baseSha,
    },
    advisor,
    readiness: {
      requiredChecks: "pass",
      mergeability:
        mergeable === true ? "mergeable" : mergeable === false ? "conflicting" : "unknown",
      // These gates intentionally remain closed until a reviewed writer owns
      // their live evidence and exact-head write guard.
      commitsVerified: false,
      productScope: "missing",
    },
    history: {
      frozenContractKeys: [],
      writes: [],
    },
  };
}

export function evaluateCoordinatorShadow(input: ShadowInput) {
  const snapshot = buildCoordinatorShadowSnapshot(input);
  return Object.freeze({
    mode: "read-only-shadow" as const,
    snapshot,
    decision: decideReviewAction(snapshot),
  });
}

function readBoundedJson(filePath: string): unknown {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SHADOW_INPUT_BYTES) {
      throw new Error("Coordinator shadow input must be a bounded nonempty regular file");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Coordinator shadow requires ${name}`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error(`Coordinator shadow ${label} must be an object`);
  return value;
}

async function main(): Promise<void> {
  const artifactsRoot = path.resolve(requiredEnv("PR_REVIEW_ADVISOR_ARTIFACTS"));
  const contextPath = path.resolve(requiredEnv("PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH"));
  const attempt = requiredEnv("GITHUB_RUN_ATTEMPT");
  const headSha = requiredEnv("EXPECTED_HEAD_SHA");
  const baseSha = requiredEnv("EXPECTED_BASE_SHA");
  const repo = requiredEnv("TARGET_REPO");
  const prNumber = Number.parseInt(requiredEnv("PR_NUMBER"), 10);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("Coordinator shadow requires a positive PR_NUMBER");
  }
  const gate = evaluateAdvisorBlockers({
    artifactsRoot,
    attempt,
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
  });
  const context = readPreparedGitHubContext(contextPath, { repo, prNumber });
  if (!context || context.fetchError) {
    throw new Error("Coordinator shadow requires complete GitHub review context");
  }
  const ledgers = ADVISOR_INTERESTS.map((interest) =>
    parseAdvisorFindingLedger(
      readBoundedJson(
        path.join(
          artifactsRoot,
          `pr-review-specialist-${interest}-${attempt}`,
          `pr-review-${interest}-findings.json`,
        ),
      ),
      { headSha, interest },
    ),
  );
  const result = evaluateCoordinatorShadow({ context, gate, ledgers, prNumber, headSha, baseSha });
  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const outputPath = path.join(OUTPUT_DIRECTORY, "decision.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const summary = [
    "## Review coordinator shadow",
    "",
    `Action: \`${result.decision.action}\``,
    "",
    `Reason: \`${result.decision.reason}\``,
    "",
    result.decision.details,
    "",
    "Shadow mode is read-only and never posts a review, approves, merges, or modifies a branch.",
    "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      `::error title=Review coordinator shadow failed::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
