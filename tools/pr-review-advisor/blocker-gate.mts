// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { TrustedE2eRecommendationInventory } from "../advisors/e2e-recommendations.mts";
import { RISK_PLAN_VERSION, type RiskPlan } from "../advisors/risk-plan.mts";
import { parseArgs } from "../advisors/io.mts";
import { collectE2eRecommendations } from "./e2e-receipt.mts";
import { parseAdvisorFindingLedger } from "./finding-ledger.mts";
import { ADVISOR_INTERESTS } from "./specialist-catalog.mts";

const MAX_GATE_ARTIFACT_BYTES = 1024 * 1024;

type GateContext = {
  kind: "nemoclaw-review-queue-context-v1";
  headSha: string;
  baseSha: string;
  expectedSpecialists: string[];
  deterministic: RiskPlan;
  selectorInventory: TrustedE2eRecommendationInventory;
  provenance: unknown;
};

export type AdvisorBlockerGateResult = Readonly<{
  status: "clear" | "blocked";
  findingCount: number;
  unresolvedRecommendationCount: number;
  findingInterests: readonly string[];
  unresolvedInterests: readonly string[];
}>;

export function evaluateAdvisorBlockers(options: {
  artifactsRoot: string;
  attempt: string;
  expectedHeadSha?: string;
  expectedBaseSha?: string;
}): AdvisorBlockerGateResult {
  const attempt = positiveDecimal(options.attempt, "attempt");
  const root = path.resolve(options.artifactsRoot);
  const expectedSpecialists = [...ADVISOR_INTERESTS].sort();
  const artifacts = expectedSpecialists.map((interest) => {
    const directory = path.join(root, `pr-review-specialist-${interest}-${attempt}`);
    requireDirectory(directory);
    return {
      interest,
      context: readBoundedJson(path.join(directory, "review-queue-context.json")),
      receipt: readBoundedJson(path.join(directory, `pr-review-${interest}-e2e.json`)),
      ledger: readBoundedJson(path.join(directory, `pr-review-${interest}-findings.json`)),
    };
  });

  const context = parseGateContext(artifacts[0]?.context, expectedSpecialists);
  for (const artifact of artifacts.slice(1)) {
    if (!isDeepStrictEqual(artifact.context, context)) {
      throw new Error("Advisor specialist artifacts do not share one review queue context");
    }
  }
  requireExpectedSha(options.expectedHeadSha, context.headSha, "head");
  requireExpectedSha(options.expectedBaseSha, context.baseSha, "base");

  const receipts = artifacts.map(({ receipt }) => receipt);
  collectE2eRecommendations(receipts, {
    baseSha: context.baseSha,
    expectedSpecialists,
    riskPlan: context.deterministic,
    inventory: context.selectorInventory,
  });

  const findingInterests: string[] = [];
  const unresolvedInterests: string[] = [];
  let findingCount = 0;
  let unresolvedRecommendationCount = 0;
  for (const artifact of artifacts) {
    const ledger = parseAdvisorFindingLedger(artifact.ledger, {
      headSha: context.headSha,
      interest: artifact.interest,
    });
    if (ledger.findings.length > 0) findingInterests.push(artifact.interest);
    findingCount += ledger.findings.length;

    const receipt = artifact.receipt as {
      advisor: { unresolvedRecommendations: unknown[] };
    };
    const unresolved = receipt.advisor.unresolvedRecommendations.length;
    if (unresolved > 0) unresolvedInterests.push(artifact.interest);
    unresolvedRecommendationCount += unresolved;
  }

  return Object.freeze({
    status: findingCount > 0 || unresolvedRecommendationCount > 0 ? "blocked" : "clear",
    findingCount,
    unresolvedRecommendationCount,
    findingInterests: Object.freeze(findingInterests),
    unresolvedInterests: Object.freeze(unresolvedInterests),
  });
}

function parseGateContext(value: unknown, expectedSpecialists: string[]): GateContext {
  const raw = record(value, "review queue context");
  const deterministic = record(raw.deterministic, "deterministic risk plan");
  const inventory = record(raw.selectorInventory, "selector inventory");
  const headSha = fullSha(raw.headSha, "context head SHA");
  fullSha(raw.baseSha, "context base SHA");
  if (raw.kind !== "nemoclaw-review-queue-context-v1") {
    throw new Error("Advisor review queue context has an unsupported kind");
  }
  if (!isDeepStrictEqual(stringArray(raw.expectedSpecialists), expectedSpecialists)) {
    throw new Error("Advisor review queue context has an incomplete specialist inventory");
  }
  if (
    deterministic.version !== RISK_PLAN_VERSION ||
    deterministic.headSha !== headSha ||
    !/^[0-9a-f]{64}$/u.test(String(deterministic.planHash)) ||
    !Array.isArray(deterministic.requiredJobs) ||
    !Array.isArray(deterministic.requiredTargets)
  ) {
    throw new Error("Advisor review queue context has an invalid deterministic risk plan");
  }
  if (
    inventory.workflow !== "e2e.yaml" ||
    inventory.fanoutId !== "e2e-all" ||
    !sameMembers(stringArray(inventory.selectorTypes), ["all", "job", "target"]) ||
    !Array.isArray(inventory.allowedJobIds) ||
    !Array.isArray(inventory.manualOnlyJobIds) ||
    !Array.isArray(inventory.liveSupportedTargetIds)
  ) {
    throw new Error("Advisor review queue context has an invalid selector inventory");
  }
  return raw as GateContext;
}

function readBoundedJson(file: string): unknown {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error("Advisor blocker gate requires nonempty regular artifact files");
    }
    if (stat.size > MAX_GATE_ARTIFACT_BYTES) {
      throw new Error("Advisor blocker gate artifact exceeds its size limit");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Advisor blocker gate requires regular specialist artifact directories");
  }
}

function requireExpectedSha(expected: string | undefined, actual: string, label: string): void {
  if (!expected) throw new Error(`Advisor blocker gate requires expected ${label} SHA`);
  if (fullSha(expected, `expected ${label} SHA`) !== actual) {
    throw new Error(`Advisor blocker gate ${label} SHA does not match the checked revision`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Advisor ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Advisor context inventory must be a string array");
  }
  return value as string[];
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full SHA`);
  }
  return value;
}

function positiveDecimal(value: string, label: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive decimal`);
  return value;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));
  return isDeepStrictEqual(sorted(left), sorted(right));
}

function gateSummary(result: AdvisorBlockerGateResult): string {
  if (result.status === "clear") {
    return "PR Review Advisor is clear: all specialist blocker ledgers and E2E receipts passed.";
  }
  const findingOwners = result.findingInterests.join(", ") || "none";
  const unresolvedOwners = result.unresolvedInterests.join(", ") || "none";
  return (
    `PR Review Advisor is blocked: ${result.findingCount} P0/P1 finding(s) ` +
    `(${findingOwners}); ${result.unresolvedRecommendationCount} unresolved E2E recommendation(s) ` +
    `(${unresolvedOwners}).`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifactsRoot = args.artifacts || process.env.PR_REVIEW_ADVISOR_ARTIFACTS;
  const attempt = args.attempt || process.env.GITHUB_RUN_ATTEMPT;
  if (!artifactsRoot || !attempt) {
    throw new Error("Advisor blocker gate requires artifacts and a run attempt");
  }
  const result = evaluateAdvisorBlockers({
    artifactsRoot,
    attempt,
    expectedHeadSha: process.env.EXPECTED_HEAD_SHA,
    expectedBaseSha: process.env.EXPECTED_BASE_SHA,
  });
  const summary = gateSummary(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Advisor blocker gate\n\n${summary}\n`);
  }
  if (result.status === "blocked") {
    console.error(`::error title=PR Review Advisor has blockers::${summary}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      `::error title=PR Review Advisor blocker gate failed::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
