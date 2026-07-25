// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import {
  classifyLiveTestOutcome,
  configuredLiveTestOutcomeFile,
  isVitestTimeoutError,
  LIVE_TEST_OUTCOME_FILE,
  parseLiveTestOutcome,
  readLiveTestOutcome,
  writeLiveTestOutcome,
} from "../tools/e2e/live-test-outcome.mts";
import {
  configuredEnvironment,
  default as E2eRiskSignalReporter,
  outcomeForRun,
  RISK_SIGNAL_FILE,
  type RiskSignalEnvironment,
  writeRiskSignal,
} from "./e2e/risk-signal-reporter.ts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "a".repeat(40)),
}));

const EXPECTED_SHA = "a".repeat(40);
const PLAN_HASH = "b".repeat(64);
const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";

function moduleWithStates(states: Array<"passed" | "failed" | "skipped" | "pending">): TestModule {
  return {
    children: {
      *allTests() {
        for (const [index, state] of states.entries()) {
          yield { fullName: `test ${index}`, result: () => ({ state }) };
        }
      },
    },
  } as unknown as TestModule;
}

function moduleWithNamedStates(
  tests: Array<{
    fullName: string;
    state: "passed" | "failed" | "skipped" | "pending";
  }>,
): TestModule {
  return {
    children: {
      *allTests() {
        for (const { fullName, state } of tests) {
          yield { fullName, result: () => ({ state }) };
        }
      },
    },
  } as unknown as TestModule;
}

function moduleWithFailedError(error: unknown): TestModule {
  return {
    children: {
      *allTests() {
        yield { fullName: "failed test", result: () => ({ state: "failed", errors: [error] }) };
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
        [moduleWithStates(["passed", "failed", "skipped", "pending"])],
        [new Error("unhandled")],
        "failed",
      );

      expect(signal).toMatchObject({
        passed: 1,
        failed: 1,
        skipped: 1,
        pending: 1,
        unhandledErrors: 1,
        runReason: "failed",
      });
      expect(fs.statSync(path.join(dir, RISK_SIGNAL_FILE)).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates multiple Vitest invocations for one workflow job", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      writeRiskSignal(environment(dir), [moduleWithStates(["passed"])], [], "passed");
      const signal = writeRiskSignal(
        environment(dir),
        [moduleWithStates(["passed", "skipped"])],
        [],
        "passed",
      );

      expect(signal).toMatchObject({ passed: 2, skipped: 1, failed: 0, pending: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the configured name pattern through the reporter lifecycle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      vi.stubEnv("E2E_ARTIFACT_DIR", dir);
      vi.stubEnv("E2E_TARGET_ID", "network-policy");
      vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", EXPECTED_SHA);
      vi.stubEnv("NEMOCLAW_E2E_PLAN_HASH", PLAN_HASH);
      vi.stubEnv("NEMOCLAW_E2E_CORRELATION_ID", CORRELATION_ID);
      vi.stubEnv("NEMOCLAW_E2E_SHARD", "live-probes");

      const reporter = new E2eRiskSignalReporter();
      reporter.onInit({
        config: { testNamePattern: /^network-policy:.+probes$/u },
      } as Vitest);
      reporter.onTestRunEnd(
        [
          moduleWithNamedStates([
            {
              fullName: "network-policy: restricted sandbox enforces live allow/deny policy probes",
              state: "passed",
            },
            {
              fullName:
                "network-policy: default restricted OpenClaw onboard leaves policy-list with zero active presets",
              state: "skipped",
            },
          ]),
        ],
        [],
        "passed",
      );

      const signal = JSON.parse(
        fs.readFileSync(path.join(dir, RISK_SIGNAL_FILE), "utf8"),
      ) as Record<string, unknown>;
      expect(signal).toMatchObject({ passed: 1, failed: 0, skipped: 0, pending: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a selected test that skips", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      const signal = writeRiskSignal(
        environment(dir),
        [
          moduleWithNamedStates([
            {
              fullName: "network-policy: restricted sandbox enforces live allow/deny policy probes",
              state: "skipped",
            },
            {
              fullName:
                "network-policy: default restricted OpenClaw onboard leaves policy-list with zero active presets",
              state: "skipped",
            },
          ]),
        ],
        [],
        "passed",
        /^network-policy:.+probes$/u,
      );

      expect(signal).toMatchObject({ passed: 0, failed: 0, skipped: 1, pending: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits no passing evidence when the name pattern matches no tests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-signal-"));
    try {
      const signal = writeRiskSignal(
        environment(dir),
        [moduleWithNamedStates([{ fullName: "selected elsewhere", state: "skipped" }])],
        [],
        "passed",
        /^missing test$/u,
      );

      expect(signal).toMatchObject({ passed: 0, failed: 0, skipped: 0, pending: 0 });
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

describe("trusted live-test outcome reporter (#7146)", () => {
  it("pins the configured outcome file to the E2E artifact directory", () => {
    const artifactDir = "/tmp/nemoclaw-live-outcome";
    const expected = path.join(artifactDir, LIVE_TEST_OUTCOME_FILE);
    expect(
      configuredLiveTestOutcomeFile({
        E2E_ARTIFACT_DIR: artifactDir,
        E2E_TEST_OUTCOME_FILE: expected,
      }),
    ).toBe(expected);
    expect(() =>
      configuredLiveTestOutcomeFile({
        E2E_ARTIFACT_DIR: artifactDir,
        E2E_TEST_OUTCOME_FILE: "/tmp/outside.json",
      }),
    ).toThrow(/must name live-test-outcome\.json/u);
  });

  it("derives assertion and timeout only from the trusted Vitest result objects", () => {
    const timeout = new Error(
      'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    );
    expect(isVitestTimeoutError(timeout)).toBe(true);
    expect(
      outcomeForRun([moduleWithFailedError(new Error("expected true to be false"))], [], "failed"),
    ).toBe("assertion");
    expect(outcomeForRun([moduleWithFailedError(timeout)], [], "failed")).toBe("timeout");
    expect(
      classifyLiveTestOutcome({
        failedTests: 0,
        unhandledErrors: [],
        testErrors: [],
        runReason: "interrupted",
        processTimedOut: true,
      }),
    ).toBe("timeout");
  });

  it.each([
    "assertion",
    "timeout",
  ] as const)("writes and strictly reads a private %s artifact", (outcome) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-outcome-"));
    const file = path.join(dir, LIVE_TEST_OUTCOME_FILE);
    try {
      writeLiveTestOutcome(file, outcome);
      expect(readLiveTestOutcome(file)).toBe(outcome);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => parseLiveTestOutcome('{"v":1,"outcome":"assertion","token":"secret"}')).toThrow(
        /unsupported shape/u,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
