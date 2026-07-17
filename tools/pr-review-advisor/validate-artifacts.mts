#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

type ArtifactValidationInput = {
  repository: string;
  prNumber: string;
  expectedHeadSha: string;
  expectedBaseSha: string;
  trustedWorkflowSha: string;
  primaryArtifactDir: string;
  secondaryArtifactDir: string;
  secondaryArtifactOutcome: string;
  maxResultBytes: number;
  maxSummaryBytes: number;
};

type ArtifactValidationOptions = {
  fetchLivePull?: (repository: string, prNumber: string) => { headSha: string; baseSha: string };
  appendOutput?: (key: string, value: string) => void;
};

type GhApiRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "inherit"] },
) => string;

const DECIMAL_PATTERN = /^[0-9]+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RESULT_SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.json");
const resultSchemaValidator = compileResultSchema();

export class ValidateAdvisorArtifactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateAdvisorArtifactsError";
  }
}

function fail(message: string): never {
  throw new ValidateAdvisorArtifactsError(message);
}

function positiveInt(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value) fail(`${name} is required`);
  return value;
}

export function fetchLivePullFromGh(
  repository: string,
  prNumber: string,
  runGhApi: GhApiRunner = (command, args, options) => execFileSync(command, args, options),
): { headSha: string; baseSha: string } {
  const pull = JSON.parse(
    runGhApi("gh", ["api", `repos/${repository}/pulls/${prNumber}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as { head?: { sha?: unknown }; base?: { sha?: unknown } };
  if (typeof pull.head?.sha !== "string" || typeof pull.base?.sha !== "string") {
    fail("Live PR response did not include head and base SHAs");
  }
  return { headSha: pull.head.sha, baseSha: pull.base.sha };
}

function inputFromEnv(env = process.env): ArtifactValidationInput {
  const outcome = required(env.SECONDARY_ARTIFACT_OUTCOME, "SECONDARY_ARTIFACT_OUTCOME");
  if (outcome !== "success" && outcome !== "failure") {
    fail("Invalid secondary advisor artifact outcome");
  }
  return {
    repository: required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    prNumber: required(env.PR_NUMBER, "PR_NUMBER"),
    expectedHeadSha: required(env.EXPECTED_HEAD_SHA, "EXPECTED_HEAD_SHA"),
    expectedBaseSha: required(env.PR_BASE_SHA, "PR_BASE_SHA"),
    trustedWorkflowSha: required(env.TRUSTED_WORKFLOW_SHA, "TRUSTED_WORKFLOW_SHA"),
    primaryArtifactDir: required(env.PUBLISH_ARTIFACT_DIR, "PUBLISH_ARTIFACT_DIR"),
    secondaryArtifactDir: required(
      env.SECONDARY_PUBLISH_ARTIFACT_DIR,
      "SECONDARY_PUBLISH_ARTIFACT_DIR",
    ),
    secondaryArtifactOutcome: outcome,
    maxResultBytes: positiveInt(
      env.PR_REVIEW_ADVISOR_MAX_RESULT_BYTES,
      "PR_REVIEW_ADVISOR_MAX_RESULT_BYTES",
    ),
    maxSummaryBytes: positiveInt(
      env.PR_REVIEW_ADVISOR_MAX_SUMMARY_BYTES,
      "PR_REVIEW_ADVISOR_MAX_SUMMARY_BYTES",
    ),
  };
}

export function validateAdvisorArtifacts(
  input = inputFromEnv(),
  options: ArtifactValidationOptions = {},
): void {
  validateIdentity(input);
  const primary = artifactPaths(input.primaryArtifactDir);
  validateLane(
    primary,
    input.maxResultBytes,
    input.maxSummaryBytes,
    input.expectedHeadSha,
    "primary advisor",
  );

  let secondaryArtifactValidated = false;
  if (input.secondaryArtifactOutcome === "success") {
    try {
      const secondary = artifactPaths(input.secondaryArtifactDir);
      validateLane(
        secondary,
        input.maxResultBytes,
        input.maxSummaryBytes,
        input.expectedHeadSha,
        "secondary advisor",
      );
      secondaryArtifactValidated = true;
    } catch {
      console.error(
        "::warning::Secondary advisor artifact failed validation; publishing the primary review without it",
      );
    }
  }

  const fetchLivePull = options.fetchLivePull ?? fetchLivePullFromGh;
  const live = fetchLivePull(input.repository, input.prNumber);
  if (live.headSha !== input.expectedHeadSha) {
    fail("PR head changed after analysis; refusing to publish a stale review");
  }
  if (live.baseSha !== input.expectedBaseSha) {
    fail("PR base changed after analysis; refusing to publish a stale review");
  }

  const appendOutput =
    options.appendOutput ??
    ((key: string, value: string): void => {
      const target = process.env.GITHUB_OUTPUT;
      if (!target) fail("GITHUB_OUTPUT is not set");
      fs.appendFileSync(target, `${key}=${value}\n`);
    });
  appendOutput("secondary_artifact_validated", String(secondaryArtifactValidated));
}

function validateIdentity(input: ArtifactValidationInput): void {
  if (
    !DECIMAL_PATTERN.test(input.prNumber) ||
    !SHA_PATTERN.test(input.expectedHeadSha) ||
    !SHA_PATTERN.test(input.expectedBaseSha) ||
    !SHA_PATTERN.test(input.trustedWorkflowSha)
  ) {
    fail("Invalid target-event publication identity");
  }
  if (
    input.secondaryArtifactOutcome !== "success" &&
    input.secondaryArtifactOutcome !== "failure"
  ) {
    fail("Invalid secondary advisor artifact outcome");
  }
}

function artifactPaths(rootDir: string): {
  rootDir: string;
  analysisResultPath: string;
  resultPath: string;
  summaryPath: string;
} {
  return {
    rootDir,
    analysisResultPath: path.join(rootDir, "pr-review-advisor-result.json"),
    resultPath: path.join(rootDir, "pr-review-advisor-final-result.json"),
    summaryPath: path.join(rootDir, "pr-review-advisor-summary.md"),
  };
}

function requireBoundedRegularFile(
  rootDir: string,
  file: string,
  maxBytes: number,
  label: string,
): void {
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`${label} artifact root must be a regular non-symlink directory`);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    fail(`${label} size ${stat.size} is outside 1..${maxBytes} bytes`);
  }
  const root = `${fs.realpathSync(rootDir)}${path.sep}`;
  const real = fs.realpathSync(file);
  if (!real.startsWith(root)) fail(`${label} escapes the artifact directory`);
}

function readJson(file: string, label: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function compileResultSchema(): ValidateFunction {
  const schema = JSON.parse(fs.readFileSync(RESULT_SCHEMA_PATH, "utf8")) as AnySchema;
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

function validateAgainstResultSchema(result: Record<string, unknown>, label: string): void {
  if (!resultSchemaValidator(result)) {
    const errors =
      resultSchemaValidator.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "schema error"}`)
        .join("; ") ?? "unknown schema error";
    fail(`${label} does not match the committed advisor result schema: ${errors}`);
  }
}

function validateFinalResult(
  result: Record<string, unknown>,
  expectedHeadSha: string,
  label: string,
): void {
  validateAgainstResultSchema(result, label);
  if (result.version !== 1) fail(`${label} version must be 1`);
  if (result.headSha !== expectedHeadSha) {
    fail(`${label} head SHA does not match the triggering PR head`);
  }
  const summary = result.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    fail(`${label} summary must be an object`);
  }
  if (
    !["low", "medium", "high"].includes(String((summary as Record<string, unknown>).confidence))
  ) {
    fail(`${label} summary confidence must be low, medium, or high`);
  }
  if (!Array.isArray(result.findings)) fail(`${label} findings must be an array`);
  for (const finding of result.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      fail(`${label} findings must contain JSON objects`);
    }
    if (
      !["blocker", "warning", "suggestion"].includes(
        String((finding as Record<string, unknown>).severity),
      )
    ) {
      fail(`${label} finding severity must be blocker, warning, or suggestion`);
    }
  }
  const e2e = result.e2e;
  if (!e2e || typeof e2e !== "object" || Array.isArray(e2e)) {
    fail(`${label} e2e must be an object`);
  }
  const e2eRecord = e2e as Record<string, unknown>;
  if (
    !e2eRecord.coverage ||
    typeof e2eRecord.coverage !== "object" ||
    Array.isArray(e2eRecord.coverage)
  ) {
    fail(`${label} e2e.coverage must be an object`);
  }
  if (
    !e2eRecord.targets ||
    typeof e2eRecord.targets !== "object" ||
    Array.isArray(e2eRecord.targets)
  ) {
    fail(`${label} e2e.targets must be an object`);
  }
}

function validateAnalysisResult(
  analysisResult: Record<string, unknown>,
  finalResult: Record<string, unknown>,
  label: string,
): void {
  const statusCount = [
    analysisResult.version === 1,
    analysisResult.failed === true,
    analysisResult.skipped === true,
  ].filter(Boolean).length;
  if (statusCount !== 1) fail(`${label} must report one analysis status`);
  if (analysisResult.version === 1) {
    if (!isDeepStrictEqual(analysisResult, finalResult)) {
      fail(`${label} completed analysis result must match its final result`);
    }
    return;
  }
  if (analysisResult.failed === true) {
    if (typeof analysisResult.reason !== "string" || !analysisResult.reason.trim()) {
      fail(`${label} failed analysis must include a reason`);
    }
    const findings = finalResult.findings as unknown[];
    if (analysisResult.partial === true) {
      if (
        !Number.isInteger(analysisResult.findingCount) ||
        analysisResult.findingCount !== findings.length
      ) {
        fail(`${label} partial finding count must match its final result`);
      }
    } else if (findings.length !== 0) {
      fail(`${label} failed analysis without a partial marker must not publish findings`);
    }
    return;
  }
  if (analysisResult.skipped === true) {
    if (typeof analysisResult.reason !== "string" || !analysisResult.reason.trim()) {
      fail(`${label} skipped analysis must include a reason`);
    }
    if ((finalResult.findings as unknown[]).length !== 0) {
      fail(`${label} skipped analysis must not publish findings`);
    }
    return;
  }
  fail(`${label} must report completed, failed, or skipped analysis status`);
}

function validateLane(
  paths: ReturnType<typeof artifactPaths>,
  maxResultBytes: number,
  maxSummaryBytes: number,
  expectedHeadSha: string,
  label: string,
): void {
  requireBoundedRegularFile(
    paths.rootDir,
    paths.analysisResultPath,
    maxResultBytes,
    `${label} analysis result`,
  );
  requireBoundedRegularFile(
    paths.rootDir,
    paths.resultPath,
    maxResultBytes,
    `${label} final result`,
  );
  requireBoundedRegularFile(paths.rootDir, paths.summaryPath, maxSummaryBytes, `${label} summary`);
  const analysisResult = readJson(paths.analysisResultPath, `${label} analysis result`);
  const finalResult = readJson(paths.resultPath, `${label} final result`);
  validateFinalResult(finalResult, expectedHeadSha, `${label} final result`);
  validateAnalysisResult(analysisResult, finalResult, label);
}

function main(): void {
  try {
    validateAdvisorArtifacts();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
