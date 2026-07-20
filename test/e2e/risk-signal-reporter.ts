// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { TestModule } from "vitest/node";
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

function counts(testModules: ReadonlyArray<TestModule>) {
  const result = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const module of testModules) {
    for (const test of module.children.allTests()) {
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
export function writeRiskSignal(
  environment: RiskSignalEnvironment,
  testModules: ReadonlyArray<TestModule>,
  unhandledErrors: ReadonlyArray<unknown>,
  runReason: TestRunEndReason,
): E2eRiskSignal {
  // Each call represents a separate Vitest command in the same job/shard;
  // Vitest has already collapsed retries inside that command. The shared
  // writer sums invocations and keeps failures sticky.
  return writeRiskSignalCounts(environment, counts(testModules), unhandledErrors.length, runReason);
}

export default class E2eRiskSignalReporter implements Reporter {
  private readonly environment: RiskSignalEnvironment | null;
  private readonly outcomeFile: string | null;
  private processTimedOut = false;

  constructor() {
    this.environment = configuredEnvironment(process.env);
    this.outcomeFile = configuredLiveTestOutcomeFile(process.env);
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
      writeRiskSignal(this.environment, testModules, unhandledErrors, reason);
    }
    if (this.outcomeFile) {
      writeLiveTestOutcome(
        this.outcomeFile,
        outcomeForRun(testModules, unhandledErrors, reason, this.processTimedOut),
      );
    }
  }
}
