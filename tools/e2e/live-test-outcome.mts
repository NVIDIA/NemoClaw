// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.mts";

export const LIVE_TEST_OUTCOME_FILE = "live-test-outcome.json";
const OUTCOME_FILE_MAX_BYTES = 128;

export const LIVE_TEST_OUTCOMES = ["none", "assertion", "timeout"] as const;
export type LiveTestOutcome = (typeof LIVE_TEST_OUTCOMES)[number];

const TIMEOUT_MESSAGE_PATTERNS = [
  /^(?:Test|Hook) timed out in [1-9][0-9]*ms\.\nIf this is a long-running (?:hook|test),/u,
  /^The (?:setup|teardown) phase of "[^"\r\n]{1,256}" hook timed out after [1-9][0-9]*ms\.$/u,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configuredLiveTestOutcomeFile(env: NodeJS.ProcessEnv): string | null {
  const configured = env.E2E_TEST_OUTCOME_FILE;
  if (!configured) return null;
  const artifactDir = env.E2E_ARTIFACT_DIR;
  if (!artifactDir) {
    throw new Error("E2E_TEST_OUTCOME_FILE requires E2E_ARTIFACT_DIR");
  }
  const expected = path.join(path.resolve(artifactDir), LIVE_TEST_OUTCOME_FILE);
  if (path.resolve(configured) !== expected) {
    throw new Error(
      `E2E_TEST_OUTCOME_FILE must name ${LIVE_TEST_OUTCOME_FILE} in E2E_ARTIFACT_DIR`,
    );
  }
  return expected;
}

export function renderLiveTestOutcome(outcome: LiveTestOutcome): string {
  return `${JSON.stringify({ v: 1, outcome })}\n`;
}

export function parseLiveTestOutcome(contents: string): LiveTestOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("live test outcome artifact must contain canonical JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "outcome,v") {
    throw new Error("live test outcome artifact has an unsupported shape");
  }
  if (parsed.v !== 1 || !(LIVE_TEST_OUTCOMES as readonly unknown[]).includes(parsed.outcome)) {
    throw new Error("live test outcome artifact has an unsupported value");
  }
  return parsed.outcome as LiveTestOutcome;
}

export function readLiveTestOutcome(file: string): LiveTestOutcome {
  const contents = readPrivateRegularFile(file, { maxBytes: OUTCOME_FILE_MAX_BYTES });
  if (contents === null) {
    throw new Error("live test outcome artifact is missing");
  }
  return parseLiveTestOutcome(contents);
}

export function writeLiveTestOutcome(file: string, outcome: LiveTestOutcome): void {
  writePrivateRegularFile(file, renderLiveTestOutcome(outcome));
}

export function isVitestTimeoutError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.message !== "string") return false;
  const message = error.message;
  return TIMEOUT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyLiveTestOutcome(input: {
  failedTests: number;
  unhandledErrors: ReadonlyArray<unknown>;
  testErrors: ReadonlyArray<unknown>;
  runReason: "passed" | "interrupted" | "failed";
  processTimedOut?: boolean;
}): LiveTestOutcome {
  if (
    input.processTimedOut === true ||
    input.testErrors.some(isVitestTimeoutError) ||
    input.unhandledErrors.some(isVitestTimeoutError)
  ) {
    return "timeout";
  }
  if (input.failedTests > 0 || input.unhandledErrors.length > 0 || input.runReason === "failed") {
    return "assertion";
  }
  return "none";
}
