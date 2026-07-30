// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { TestModule, TestSpecification, Vitest } from "vitest/node";
import type { Reporter, TestRunEndReason } from "vitest/reporters";
import {
  classifyLiveTestOutcome,
  configuredLiveTestOutcomeFile,
  type LiveTestOutcome,
  writeLiveTestOutcome,
} from "../../tools/e2e/live-test-outcome.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "../../tools/e2e/private-file.mts";
import {
  buildRiskSignal,
  configuredRiskSignalEnvironment,
  type E2eRiskSignal,
  RISK_SIGNAL_FILE,
  type RiskSignalEnvironment,
} from "../../tools/e2e/risk-signal.ts";

export { RISK_SIGNAL_FILE, type RiskSignalEnvironment };
export const configuredEnvironment = configuredRiskSignalEnvironment;

function matchesNamePattern(fullName: string, pattern: RegExp | undefined): boolean {
  if (!pattern) return true;
  const stablePattern = new RegExp(pattern.source, pattern.flags);
  // Vitest joins suite names with spaces when it applies testNamePattern.
  return stablePattern.test(fullName.replaceAll(" > ", " "));
}

function testNamePatternForRun(
  specifications: ReadonlyArray<TestSpecification>,
  globalTestNamePattern: RegExp | undefined,
): RegExp | undefined {
  const [first = globalTestNamePattern, ...rest] = specifications.map(
    (specification) => specification.testNamePattern ?? globalTestNamePattern,
  );
  if (
    rest.some((pattern) => pattern?.source !== first?.source || pattern?.flags !== first?.flags)
  ) {
    throw new Error("risk signal requires one test name pattern per Vitest run");
  }
  return first;
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
  const signal = buildRiskSignal(environment, {
    ...counts(testModules, testNamePattern),
    unhandledErrors: unhandledErrors.length,
    runReason,
  });
  fs.mkdirSync(environment.artifactDir, { recursive: true });
  const file = path.join(environment.artifactDir, RISK_SIGNAL_FILE);
  const merged = mergeSignal(readPrevious(file), signal);
  writePrivateRegularFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export default class E2eRiskSignalReporter implements Reporter {
  private readonly environment: RiskSignalEnvironment | null;
  private readonly outcomeFile: string | null;
  private globalTestNamePattern: RegExp | undefined;
  private testNamePattern: RegExp | undefined;
  private processTimedOut = false;

  constructor() {
    this.environment = configuredEnvironment(process.env);
    this.outcomeFile = configuredLiveTestOutcomeFile(process.env);
  }

  onInit(vitest: Vitest): void {
    this.globalTestNamePattern = vitest.getGlobalTestNamePattern();
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.processTimedOut = false;
    this.testNamePattern = testNamePatternForRun(specifications, this.globalTestNamePattern);
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
