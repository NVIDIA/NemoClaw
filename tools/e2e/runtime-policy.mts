// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTargets } from "../../test/e2e/registry/registry.ts";
import {
  LIVE_E2E_RUNTIME_POLICY,
  type LiveE2EArtifact,
  type LiveE2ECoverageKind,
  type LiveE2EPolicyException,
  type LiveE2ERunnerClass,
  type LiveE2ERuntimePolicy,
  type LiveE2ERuntimePolicyEntry,
  type LiveE2ERuntimeTier,
  type LiveE2ETelemetry,
} from "../../test/e2e/runtime-policy.ts";
import { readFreeStandingJobsInventory } from "./workflow-boundary.mts";

export const E2E_RUNTIME_POLICY_ERROR_PREFIX = "E2E runtime policy violation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIERS = new Set<LiveE2ERuntimeTier>(["pr", "nightly", "weekly", "release"]);
const RUNNER_CLASSES = new Set<LiveE2ERunnerClass>([
  "standard-linux",
  "larger-linux",
  "mixed-linux",
  "gpu-linux",
  "jetson-linux",
  "macos",
  "windows-wsl",
  "remote-brev",
]);
const TELEMETRY = new Set<LiveE2ETelemetry>([
  "job-runtime",
  "semantic-phase-progress",
  "runner-pressure",
  "runner-comparison",
]);
const ARTIFACTS = new Set<LiveE2EArtifact>([
  "target-evidence",
  "runtime-summary",
  "launchable-evidence",
]);
const BUDGET_CEILINGS: Record<LiveE2ERuntimeTier, number> = {
  pr: 15,
  nightly: 20,
  weekly: 45,
  release: 180,
};

export interface LiveE2ERuntimePolicyInventory {
  registryTargetIds: string[];
  workflowTargetIds: string[];
}

export interface ValidateLiveE2ERuntimePolicyOptions {
  inventory?: LiveE2ERuntimePolicyInventory;
  repoRoot?: string;
  today?: Date;
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return positiveNumber(value) && Number.isInteger(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateStringList<T extends string>(
  errors: string[],
  owner: string,
  values: unknown,
  allowed: ReadonlySet<T>,
): void {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${owner} must declare at least one value`);
    return;
  }
  if (!values.every((value) => typeof value === "string" && allowed.has(value as T))) {
    errors.push(`${owner} contains an unknown value`);
  }
  for (const duplicate of duplicates(
    values.filter((value): value is string => typeof value === "string"),
  )) {
    errors.push(`${owner} repeats ${duplicate}`);
  }
}

function validateException(
  errors: string[],
  owner: string,
  exception: LiveE2EPolicyException | undefined,
  today: string,
  required: boolean,
): void {
  if (!exception) {
    if (required) errors.push(`${owner} requires an explicit exception`);
    return;
  }
  if (!exactKeys(exception, ["rationale", "expiresOn", "reviewCondition"])) {
    errors.push(`${owner} exception must use the exact rationale, expiry, and review schema`);
  }
  if (typeof exception.rationale !== "string" || exception.rationale.trim().length < 30) {
    errors.push(`${owner} exception rationale must explain the deviation`);
  }
  if (!validDate(exception.expiresOn)) {
    errors.push(`${owner} exception expiry must be YYYY-MM-DD`);
  } else if (exception.expiresOn < today) {
    errors.push(`${owner} exception expired on ${exception.expiresOn}`);
  }
  if (
    typeof exception.reviewCondition !== "string" ||
    exception.reviewCondition.trim().length < 30
  ) {
    errors.push(`${owner} exception must declare a concrete review condition`);
  }
}

function validateOwningFiles(
  errors: string[],
  entry: LiveE2ERuntimePolicyEntry,
  repoRoot: string,
): void {
  if (!Array.isArray(entry.owningFiles) || entry.owningFiles.length === 0) {
    errors.push(`${entry.id} must map at least one owning file`);
    return;
  }
  for (const duplicate of duplicates(entry.owningFiles)) {
    errors.push(`${entry.id} repeats owning file ${duplicate}`);
  }
  for (const file of entry.owningFiles) {
    if (
      typeof file !== "string" ||
      file.startsWith("/") ||
      file.split("/").some((segment) => segment === "." || segment === "..") ||
      !/^[A-Za-z0-9._/-]+$/u.test(file)
    ) {
      errors.push(`${entry.id} has unsafe owning file ${String(file)}`);
      continue;
    }
    const resolved = path.resolve(repoRoot, file);
    if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) {
      errors.push(`${entry.id} owning file escapes the repository: ${file}`);
      continue;
    }
    try {
      if (!statSync(resolved).isFile())
        errors.push(`${entry.id} owning file is not a file: ${file}`);
    } catch {
      errors.push(`${entry.id} owning file does not exist: ${file}`);
    }
  }
}

function validateEntry(
  errors: string[],
  entry: LiveE2ERuntimePolicyEntry,
  expectedKind: LiveE2ECoverageKind | undefined,
  options: Required<Pick<ValidateLiveE2ERuntimePolicyOptions, "repoRoot">> & { today: string },
): void {
  const expectedKeys = [
    "budgetMinutes",
    "expectedRunnerMinutes",
    "expectedRuntimeMinutes",
    "id",
    "kind",
    "owningFiles",
    "requiredArtifacts",
    "requiredTelemetry",
    "reviewCondition",
    "runnerClass",
    "tier",
    "uniqueBoundary",
    ...(entry.exception ? ["exception"] : []),
  ];
  if (!exactKeys(entry, expectedKeys)) {
    errors.push(`${entry.id || "<missing-id>"} must use the exact runtime policy entry schema`);
  }
  if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
    errors.push(`${entry.id || "<missing-id>"} has an invalid id`);
  }
  if (expectedKind && entry.kind !== expectedKind) {
    errors.push(`${entry.id} must use kind ${expectedKind}`);
  }
  if (
    typeof entry.uniqueBoundary !== "string" ||
    entry.uniqueBoundary.trim().length < 30 ||
    !entry.uniqueBoundary.endsWith(".")
  ) {
    errors.push(`${entry.id} must state one concrete unique live boundary`);
  }
  if (!TIERS.has(entry.tier)) errors.push(`${entry.id} has an unknown execution tier`);
  if (!RUNNER_CLASSES.has(entry.runnerClass))
    errors.push(`${entry.id} has an unknown runner class`);
  if (!positiveInteger(entry.expectedRuntimeMinutes)) {
    errors.push(`${entry.id} expected runtime must be a positive whole minute`);
  }
  if (!positiveInteger(entry.budgetMinutes)) {
    errors.push(`${entry.id} runtime budget must be a positive whole minute`);
  }
  if (!positiveInteger(entry.expectedRunnerMinutes)) {
    errors.push(`${entry.id} expected runner consumption must be a positive whole minute`);
  }
  if (
    positiveNumber(entry.expectedRuntimeMinutes) &&
    positiveNumber(entry.budgetMinutes) &&
    entry.expectedRuntimeMinutes > entry.budgetMinutes
  ) {
    errors.push(`${entry.id} expected runtime exceeds its budget`);
  }
  if (
    positiveNumber(entry.expectedRuntimeMinutes) &&
    positiveNumber(entry.expectedRunnerMinutes) &&
    entry.expectedRunnerMinutes < entry.expectedRuntimeMinutes
  ) {
    errors.push(`${entry.id} expected runner consumption is below wall runtime`);
  }
  if (
    TIERS.has(entry.tier) &&
    positiveNumber(entry.budgetMinutes) &&
    entry.budgetMinutes > BUDGET_CEILINGS[entry.tier]
  ) {
    errors.push(`${entry.id} ${entry.tier} budget exceeds ${BUDGET_CEILINGS[entry.tier]} minutes`);
  }
  validateOwningFiles(errors, entry, options.repoRoot);
  validateStringList(errors, `${entry.id} required telemetry`, entry.requiredTelemetry, TELEMETRY);
  validateStringList(errors, `${entry.id} required artifacts`, entry.requiredArtifacts, ARTIFACTS);
  if (
    typeof entry.reviewCondition !== "string" ||
    entry.reviewCondition.trim().length < 40 ||
    !/\b(?:review|consolidate|retire)\b/iu.test(entry.reviewCondition)
  ) {
    errors.push(`${entry.id} must declare a review, consolidation, or retirement condition`);
  }
  validateException(errors, entry.id, entry.exception, options.today, false);
}

export function readLiveE2ERuntimePolicyInventory(): LiveE2ERuntimePolicyInventory {
  return {
    registryTargetIds: listTargets().map((target) => target.id),
    workflowTargetIds: readFreeStandingJobsInventory().allowedJobs,
  };
}

export function validateLiveE2ERuntimePolicy(
  policy: LiveE2ERuntimePolicy = LIVE_E2E_RUNTIME_POLICY,
  options: ValidateLiveE2ERuntimePolicyOptions = {},
): string[] {
  const errors: string[] = [];
  const inventory = options.inventory ?? readLiveE2ERuntimePolicyInventory();
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const today = (options.today ?? new Date()).toISOString().slice(0, 10);

  if (!exactKeys(policy, ["apiVersion", "baseline", "coverage", "kind"])) {
    errors.push("policy must use the exact top-level schema");
  }
  if (policy.apiVersion !== "nemoclaw.io/v1" || policy.kind !== "LiveE2ERuntimePolicy") {
    errors.push("policy identity must be nemoclaw.io/v1 LiveE2ERuntimePolicy");
  }
  if (
    !exactKeys(policy.baseline, [
      "goals",
      "sourceRun",
      "status",
      ...(policy.baseline.exception ? ["exception"] : []),
    ])
  ) {
    errors.push("baseline must use the exact status, source, goals, and exception schema");
  }
  if (policy.baseline.status !== "provisional" && policy.baseline.status !== "measured") {
    errors.push("baseline status must be provisional or measured");
  }
  if (
    !exactKeys(policy.baseline.sourceRun, [
      "candidateSha",
      "measuredOn",
      "nonSkippedJobs",
      "runId",
      "runnerMinutes",
      "wallMinutes",
    ])
  ) {
    errors.push("baseline source run must use the exact measured schema");
  }
  if (!/^[1-9][0-9]*$/u.test(policy.baseline.sourceRun.runId)) {
    errors.push("baseline run id must be a positive GitHub Actions run id");
  }
  if (!SHA_PATTERN.test(policy.baseline.sourceRun.candidateSha)) {
    errors.push("baseline candidate must be an exact commit SHA");
  }
  if (!validDate(policy.baseline.sourceRun.measuredOn)) {
    errors.push("baseline measurement date must be YYYY-MM-DD");
  }
  for (const [name, value] of Object.entries({
    wallMinutes: policy.baseline.sourceRun.wallMinutes,
    runnerMinutes: policy.baseline.sourceRun.runnerMinutes,
    nonSkippedJobs: policy.baseline.sourceRun.nonSkippedJobs,
  })) {
    if (!positiveNumber(value)) errors.push(`baseline ${name} must be positive`);
  }
  if (
    !exactKeys(policy.baseline.goals, [
      "nightlyRunnerMinutes",
      "nightlyWallMinutes",
      "prWallMinutes",
      "weeklyWallMinutes",
    ])
  ) {
    errors.push("baseline goals must use the exact PR, nightly, and weekly schema");
  }
  if (policy.baseline.goals.prWallMinutes > 15) {
    errors.push("PR wall-time goal must be 15 minutes or less");
  }
  if (policy.baseline.goals.nightlyWallMinutes > 20) {
    errors.push("nightly wall-time goal must be 20 minutes or less");
  }
  if (policy.baseline.goals.nightlyRunnerMinutes >= 300) {
    errors.push("nightly runner-minute goal must be below 300");
  }
  if (policy.baseline.goals.weeklyWallMinutes > 45) {
    errors.push("weekly wall-time goal must be 45 minutes or less");
  }
  validateException(
    errors,
    "provisional baseline",
    policy.baseline.exception,
    today,
    policy.baseline.status === "provisional",
  );

  const registryIds = new Set(inventory.registryTargetIds);
  const workflowIds = new Set(inventory.workflowTargetIds);
  const expectedIds = new Set([...registryIds, ...workflowIds]);
  const policyIds = policy.coverage.map((entry) => entry.id);
  for (const duplicate of duplicates(policyIds))
    errors.push(`policy repeats coverage id ${duplicate}`);
  for (const id of [...expectedIds].sort()) {
    if (!policyIds.includes(id))
      errors.push(`live coverage is missing runtime policy metadata: ${id}`);
  }
  for (const id of [...new Set(policyIds)].sort()) {
    if (!expectedIds.has(id)) errors.push(`runtime policy contains unknown live coverage: ${id}`);
  }

  for (const entry of policy.coverage) {
    const expectedKind = registryIds.has(entry.id)
      ? "registry-target"
      : workflowIds.has(entry.id)
        ? "workflow-target"
        : undefined;
    validateEntry(errors, entry, expectedKind, { repoRoot, today });
  }

  const nightly = policy.coverage.filter(
    (entry) => entry.tier === "pr" || entry.tier === "nightly",
  );
  const pr = policy.coverage.filter((entry) => entry.tier === "pr");
  if (pr.length < 1 || pr.length > 3) {
    errors.push("PR tier must contain one to three canonical retained live journeys");
  }
  if (nightly.length < 10 || nightly.length > 15) {
    errors.push("PR and nightly tiers must contain 10 to 15 retained live journeys");
  }
  const nightlyRunnerMinutes = nightly.reduce(
    (total, entry) => total + entry.expectedRunnerMinutes,
    0,
  );
  if (nightlyRunnerMinutes >= policy.baseline.goals.nightlyRunnerMinutes) {
    errors.push(
      `planned nightly runner consumption ${nightlyRunnerMinutes} must remain below ${policy.baseline.goals.nightlyRunnerMinutes}`,
    );
  }

  return errors;
}

export function assertLiveE2ERuntimePolicy(
  policy: LiveE2ERuntimePolicy = LIVE_E2E_RUNTIME_POLICY,
  options: ValidateLiveE2ERuntimePolicyOptions = {},
): void {
  const errors = validateLiveE2ERuntimePolicy(policy, options);
  if (errors.length > 0) {
    throw new Error(`${E2E_RUNTIME_POLICY_ERROR_PREFIX}:\n- ${errors.join("\n- ")}`);
  }
}

function main(): void {
  try {
    assertLiveE2ERuntimePolicy();
    const nightly = LIVE_E2E_RUNTIME_POLICY.coverage.filter(
      (entry) => entry.tier === "pr" || entry.tier === "nightly",
    );
    const runnerMinutes = nightly.reduce((total, entry) => total + entry.expectedRunnerMinutes, 0);
    console.log(
      `E2E runtime policy validation passed: ${LIVE_E2E_RUNTIME_POLICY.coverage.length} coverage items, ${nightly.length} PR/nightly items, ${runnerMinutes} planned runner-minutes.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
