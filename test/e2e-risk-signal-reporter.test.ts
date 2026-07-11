// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { TestModule } from "vitest/node";
import {
  configuredEnvironment,
  RISK_SIGNAL_FILE,
  type RiskSignalEnvironment,
  writeRiskSignal,
} from "./e2e/risk-signal-reporter.ts";

const EXPECTED_SHA = "a".repeat(40);
const PLAN_HASH = "b".repeat(64);
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";

type TestState = "passed" | "failed" | "skipped" | "pending";

function moduleWithStates(
  states: Array<TestState | { state: TestState; evidence: "optional" }>,
): TestModule {
  return {
    children: {
      *allTests() {
        for (const entry of states) {
          const state = typeof entry === "string" ? entry : entry.state;
          const evidence = typeof entry === "string" ? undefined : entry.evidence;
          yield {
            meta: () => (evidence ? { e2eEvidence: evidence } : {}),
            result: () => ({ state }),
          };
        }
      },
    },
  } as unknown as TestModule;
}

function environment(artifactDir: string): RiskSignalEnvironment {
  return {
    artifactDir,
    jobId: "onboard-resume",
    shardId: "default",
    expectedSha: EXPECTED_SHA,
    testedSha: EXPECTED_SHA,
    planHash: PLAN_HASH,
    correlationId: CORRELATION_ID,
  };
}

describe("E2E risk signal reporter", () => {
  it("stays disabled when no expected commit is configured", () => {
    expect(configuredEnvironment({})).toBeNull();
  });

  it("fails closed when run metadata is incomplete", () => {
    expect(() => configuredEnvironment({ NEMOCLAW_E2E_EXPECTED_SHA: EXPECTED_SHA })).toThrow(
      /E2E_ARTIFACT_DIR/u,
    );
  });

  it("attests the checked-out HEAD instead of echoing only the expected SHA", () => {
    const env = {
      E2E_ARTIFACT_DIR: "/tmp/e2e-risk-signal-test",
      E2E_TARGET_ID: "onboard-resume",
      GITHUB_WORKSPACE: "/workspace",
      NEMOCLAW_E2E_EXPECTED_SHA: EXPECTED_SHA,
      NEMOCLAW_E2E_PLAN_HASH: PLAN_HASH,
      NEMOCLAW_E2E_CORRELATION_ID: CORRELATION_ID,
      NEMOCLAW_E2E_SHARD: "default",
    };

    expect(configuredEnvironment(env, () => EXPECTED_SHA)?.testedSha).toBe(EXPECTED_SHA);
    expect(() => configuredEnvironment(env, () => "c".repeat(40))).toThrow(/checked-out HEAD/u);
  });

  it("writes pass, failure, skip, and pending counts for the tested commit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      const signal = writeRiskSignal(
        environment(dir),
        [
          moduleWithStates([
            "passed",
            { state: "failed", evidence: "optional" },
            "skipped",
            { state: "pending", evidence: "optional" },
          ]),
        ],
        [new Error("unhandled")],
        "failed",
      );

      expect(signal).toMatchObject({
        passed: 1,
        failed: 1,
        skipped: 1,
        optionalSkipped: 0,
        pending: 1,
        unhandledErrors: 1,
        runReason: "failed",
      });
      expect(fs.statSync(path.join(dir, RISK_SIGNAL_FILE)).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records deliberately optional skips without weakening required evidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      const signal = writeRiskSignal(
        environment(dir),
        [
          moduleWithStates([
            "passed",
            "passed",
            "passed",
            "passed",
            { state: "skipped", evidence: "optional" },
            { state: "skipped", evidence: "optional" },
            { state: "skipped", evidence: "optional" },
          ]),
        ],
        [],
        "passed",
      );

      expect(signal).toMatchObject({
        passed: 4,
        failed: 0,
        skipped: 3,
        optionalSkipped: 3,
        pending: 0,
        runReason: "passed",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates multiple Vitest invocations for one workflow job", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      writeRiskSignal(
        environment(dir),
        [moduleWithStates(["passed", { state: "skipped", evidence: "optional" }])],
        [],
        "passed",
      );
      const signal = writeRiskSignal(
        environment(dir),
        [moduleWithStates(["passed", "skipped", { state: "skipped", evidence: "optional" }])],
        [],
        "passed",
      );

      expect(signal).toMatchObject({
        passed: 2,
        skipped: 3,
        optionalSkipped: 2,
        failed: 0,
        pending: 0,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked prior signal without modifying its target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    const target = path.join(dir, "target.json");
    const signalFile = path.join(dir, RISK_SIGNAL_FILE);
    try {
      fs.writeFileSync(target, "protected\n");
      fs.symlinkSync(target, signalFile);

      expect(() =>
        writeRiskSignal(environment(dir), [moduleWithStates(["passed"])], [], "passed"),
      ).toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("protected\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a hardlinked prior signal before truncating its target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    const target = path.join(dir, "target.json");
    const signalFile = path.join(dir, RISK_SIGNAL_FILE);
    try {
      fs.writeFileSync(target, "protected\n");
      fs.linkSync(target, signalFile);

      expect(() =>
        writeRiskSignal(environment(dir), [moduleWithStates(["passed"])], [], "passed"),
      ).toThrow(/private regular file/u);
      expect(fs.readFileSync(target, "utf8")).toBe("protected\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
