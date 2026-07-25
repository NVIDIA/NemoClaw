// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { TestModule, Vitest } from "vitest/node";
import type { Reporter, TestRunEndReason } from "vitest/reporters";
import {
  classifyLiveTestOutcome,
  configuredLiveTestOutcomeFile,
  type LiveTestOutcome,
  writeLiveTestOutcome,
} from "../../tools/e2e/live-test-outcome.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "../../tools/e2e/private-file.mts";
import type { E2eRiskSignal } from "../../tools/e2e/risk-signal.ts";

export const RISK_SIGNAL_FILE = "risk-signal.json";

export type RiskSignalEnvironment = {
  artifactDir: string;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  planHash: string;
  correlationId: string;
};

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;

function checkedOutSha(workspace: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

export function configuredEnvironment(
  env: NodeJS.ProcessEnv,
  resolveHead: (workspace: string) => string = checkedOutSha,
): RiskSignalEnvironment | null {
  if (!env.NEMOCLAW_E2E_EXPECTED_SHA) return null;
  const values = {
    artifactDir: env.E2E_ARTIFACT_DIR ?? "",
    jobId: env.E2E_TARGET_ID ?? "",
    shardId: env.NEMOCLAW_E2E_SHARD ?? "",
    expectedSha: env.NEMOCLAW_E2E_EXPECTED_SHA,
    planHash: env.NEMOCLAW_E2E_PLAN_HASH ?? "",
    correlationId: env.NEMOCLAW_E2E_CORRELATION_ID ?? "",
  };
  if (!values.artifactDir) throw new Error("risk signal requires E2E_ARTIFACT_DIR");
  if (!JOB_PATTERN.test(values.jobId)) throw new Error("risk signal requires a safe E2E_TARGET_ID");
  if (!SHARD_PATTERN.test(values.shardId)) {
    throw new Error("risk signal requires a safe shard id");
  }
  if (!SHA_PATTERN.test(values.expectedSha)) {
    throw new Error("risk signal requires a 40-character lowercase expected SHA");
  }
  if (!HASH_PATTERN.test(values.planHash)) {
    throw new Error("risk signal requires a 64-character lowercase plan hash");
  }
  if (!CORRELATION_PATTERN.test(values.correlationId)) {
    throw new Error("risk signal requires a lowercase UUIDv4 correlation id");
  }
  const testedSha = resolveHead(env.GITHUB_WORKSPACE ?? process.cwd());
  if (!SHA_PATTERN.test(testedSha) || testedSha !== values.expectedSha) {
    throw new Error("risk signal checked-out HEAD does not match the expected SHA");
  }
  return { ...values, testedSha };
}

function matchesNamePattern(fullName: string, pattern: RegExp | undefined): boolean {
  if (!pattern) return true;
  const stablePattern = new RegExp(pattern.source, pattern.flags);
  // Vitest joins suite names with spaces when it applies testNamePattern.
  return stablePattern.test(fullName.replaceAll(" > ", " "));
}

function counts(testModules: ReadonlyArray<TestModule>, testNamePattern?: RegExp) {
  const result = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      if (!matchesNamePattern(test.fullName, testNamePattern)) continue;
      result[test.result().state] += 1;
    }
  }
  return result;
}

function failedTestErrors(testModules: ReadonlyArray<TestModule>): unknown[] {
  const errors: unknown[] = [];
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
      const result = test.result();
      if (result.state === "failed") errors.push(...result.errors);
    }
  }
  return errors;
}

export function outcomeForRun(
  testModules: ReadonlyArray<TestModule>,
  unhandledErrors: ReadonlyArray<unknown>,
  runReason: TestRunEndReason,
  processTimedOut = false,
): LiveTestOutcome {
  const summary = counts(testModules);
  return classifyLiveTestOutcome({
    failedTests: summary.failed,
    unhandledErrors,
    testErrors: failedTestErrors(testModules),
    runReason,
    processTimedOut,
  });
}

function mergeSignal(previous: E2eRiskSignal | null, current: E2eRiskSignal): E2eRiskSignal {
  if (!previous) return current;
  if (
    previous.version !== current.version ||
    previous.jobId !== current.jobId ||
    previous.shardId !== current.shardId ||
    previous.expectedSha !== current.expectedSha ||
    previous.testedSha !== current.testedSha ||
    previous.planHash !== current.planHash ||
    previous.correlationId !== current.correlationId
  ) {
    throw new Error("risk signal metadata changed between Vitest invocations");
  }
  // Each call represents a separate Vitest command in the same job/shard;
  // Vitest has already collapsed retries inside that command. Summing keeps
  // failures sticky, because any failed or unhandled count makes the gate red.
  return {
    ...current,
    passed: previous.passed + current.passed,
    failed: previous.failed + current.failed,
    skipped: previous.skipped + current.skipped,
    pending: previous.pending + current.pending,
    unhandledErrors: previous.unhandledErrors + current.unhandledErrors,
    runReason:
      previous.runReason === "failed" || current.runReason === "failed"
        ? "failed"
        : previous.runReason === "interrupted" || current.runReason === "interrupted"
          ? "interrupted"
          : "passed",
  };
}

function readPrevious(file: string): E2eRiskSignal | null {
  const contents = readPrivateRegularFile(file, { allowMissing: true, maxBytes: 64 * 1024 });
  return contents === null ? null : (JSON.parse(contents) as E2eRiskSignal);
}

export function writeRiskSignal(
  environment: RiskSignalEnvironment,
  testModules: ReadonlyArray<TestModule>,
  unhandledErrors: ReadonlyArray<unknown>,
  runReason: TestRunEndReason,
  testNamePattern?: RegExp,
): E2eRiskSignal {
  const signal: E2eRiskSignal = {
    version: 1,
    jobId: environment.jobId,
    shardId: environment.shardId,
    expectedSha: environment.expectedSha,
    testedSha: environment.testedSha,
    planHash: environment.planHash,
    correlationId: environment.correlationId,
    ...counts(testModules, testNamePattern),
    unhandledErrors: unhandledErrors.length,
    runReason,
  };
  fs.mkdirSync(environment.artifactDir, { recursive: true });
  const file = path.join(environment.artifactDir, RISK_SIGNAL_FILE);
  const merged = mergeSignal(readPrevious(file), signal);
  writePrivateRegularFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export default class E2eRiskSignalReporter implements Reporter {
  private readonly environment: RiskSignalEnvironment | null;
  private readonly outcomeFile: string | null;
  private testNamePattern: RegExp | undefined;
  private processTimedOut = false;

  constructor() {
    this.environment = configuredEnvironment(process.env);
    this.outcomeFile = configuredLiveTestOutcomeFile(process.env);
  }

  onInit(vitest: Vitest): void {
    this.testNamePattern = vitest.config.testNamePattern;
  }

  onTestRunStart(): void {
    this.processTimedOut = false;
    if (!this.outcomeFile) return;
    fs.mkdirSync(path.dirname(this.outcomeFile), { recursive: true });
    writeLiveTestOutcome(this.outcomeFile, "none");
  }

  onProcessTimeout(): void {
    this.processTimedOut = true;
    if (!this.outcomeFile) return;
    writeLiveTestOutcome(this.outcomeFile, "timeout");
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    if (this.environment) {
      writeRiskSignal(this.environment, testModules, unhandledErrors, reason, this.testNamePattern);
    }
    if (this.outcomeFile) {
      writeLiveTestOutcome(
        this.outcomeFile,
        outcomeForRun(testModules, unhandledErrors, reason, this.processTimedOut),
      );
    }
  }
}
