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
import {
  configuredRiskSignalEnvironment,
  type E2eRiskSignal,
  RISK_SIGNAL_FILE,
  type RiskSignalCounts,
  type RiskSignalEnvironment,
  writeRiskSignalCounts,
} from "../../tools/e2e/risk-signal.ts";

export { RISK_SIGNAL_FILE, type RiskSignalEnvironment };

export function configuredEnvironment(
  env: NodeJS.ProcessEnv,
  resolveHead?: (workspace: string) => string,
): RiskSignalEnvironment | null {
  return configuredRiskSignalEnvironment(env, resolveHead);
}

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

function writeSelectedRiskSignal(
  environment: RiskSignalEnvironment,
  selectedCounts: RiskSignalCounts,
  unhandledErrors: ReadonlyArray<unknown>,
  runReason: TestRunEndReason,
): E2eRiskSignal {
  // Each call represents a separate Vitest command in the same job/shard;
  // Vitest has already collapsed retries inside that command. The shared
  // writer sums invocations and keeps failures sticky.
  return writeRiskSignalCounts(environment, selectedCounts, unhandledErrors.length, runReason);
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
export function writeRiskSignal(
  environment: RiskSignalEnvironment,
  testModules: ReadonlyArray<TestModule>,
  unhandledErrors: ReadonlyArray<unknown>,
  runReason: TestRunEndReason,
  testNamePattern?: RegExp,
): E2eRiskSignal {
  return writeSelectedRiskSignal(
    environment,
    counts(testModules, testNamePattern),
    unhandledErrors,
    runReason,
  );
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
    const selectedCounts = counts(testModules, this.testNamePattern);
    const selectorMatchedNothing =
      this.testNamePattern !== undefined &&
      selectedCounts.passed +
        selectedCounts.failed +
        selectedCounts.skipped +
        selectedCounts.pending ===
        0;
    const effectiveReason: TestRunEndReason = selectorMatchedNothing ? "failed" : reason;

    if (selectorMatchedNothing) {
      console.error(
        `E2E test selector ${String(this.testNamePattern)} matched no tests; failing closed.`,
      );
      process.exitCode = 1;
    }
    if (this.environment) {
      writeSelectedRiskSignal(this.environment, selectedCounts, unhandledErrors, effectiveReason);
    }
    if (this.outcomeFile) {
      writeLiveTestOutcome(
        this.outcomeFile,
        outcomeForRun(testModules, unhandledErrors, effectiveReason, this.processTimedOut),
      );
    }
  }
}
