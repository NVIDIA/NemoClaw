// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, type TestContext, vi } from "vitest";
import { E2E_TEARDOWN_PHASE } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-progress-outcome.fixture.test.ts";

type RunFixtureResult = {
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

function runFixture(
  env: NodeJS.ProcessEnv,
  owner: Pick<TestContext, "onTestFinished" | "signal">,
  timeoutMs = 20_000,
): Promise<RunFixtureResult> {
  let finish: (result: RunFixtureResult) => void = () => undefined;
  const resultPromise = new Promise<RunFixtureResult>((resolve) => {
    finish = resolve;
  });
  const child = execFile(
    process.execPath,
    [VITEST, "run", "--project", "e2e-support", FIXTURE, "--reporter=default"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      signal: owner.signal,
      timeout: timeoutMs,
    },
    (error, stdout, stderr) => {
      const signal =
        child.signalCode ?? error?.signal ?? (error?.code === "ABORT_ERR" ? "SIGKILL" : null);
      finish({
        signal,
        status: signal ? null : Number(error?.code) || (error ? -1 : 0),
        stderr,
        stdout,
      });
    },
  );
  owner.onTestFinished(async () => {
    child.kill("SIGKILL");
    await resultPromise;
  });
  return resultPromise;
}

vi.setConfig({ maxConcurrency: 7, testTimeout: 30_000 });

describe.concurrent("automatic E2E phase outcomes", () => {
  it("redacts target identities and explicit progress events before console output", async (context) => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-redaction-"));
    const secret = "progress-event-secret-value";
    try {
      const result = await runFixture(
        {
          ...process.env,
          E2E_ARTIFACT_DIR: artifactDir,
          E2E_TARGET_ID: `redaction-target-${secret}`,
          NEMOCLAW_E2E_PROGRESS_EVENT_SECRET: secret,
          NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE: "redacted-event",
          NEMOCLAW_RUN_LIVE_E2E: "1",
        },
        context,
      );

      const output = `${result.stdout}\n${result.stderr}`;
      const { expect } = context;
      expect(result.status, output).toBe(0);
      expect(output).not.toContain(secret);
      expect(output).toContain('target="redaction-target-[REDACTED]"');
      expect(output).toContain("event: retry cleanup for [REDACTED]");
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it(
    "reports the signal when a nested fixture exceeds its deadline",
    { timeout: 15_000 },
    async (context) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-signal-"));
      const timeoutReady = path.join(artifactDir, "timeout-ready");
      const deadline = new AbortController();
      const resultPromise = runFixture(
        {
          ...process.env,
          E2E_ARTIFACT_DIR: artifactDir,
          NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE: "cleanup-stalled",
          NEMOCLAW_E2E_PROGRESS_TIMEOUT_READY: timeoutReady,
          NEMOCLAW_RUN_LIVE_E2E: "1",
        },
        {
          onTestFinished: (handler) => context.onTestFinished(handler),
          signal: AbortSignal.any([context.signal, deadline.signal]),
        },
      );
      try {
        await vi.waitFor(() => context.expect(fs.existsSync(timeoutReady)).toBe(true), {
          interval: 10,
          timeout: 10_000,
        });
        deadline.abort();
        const result = await resultPromise;
        context.expect(result.status).toBeNull();
        context.expect(result.signal).toBe("SIGKILL");
      } finally {
        deadline.abort();
        await resultPromise;
        fs.rmSync(artifactDir, { recursive: true, force: true });
      }
    },
  );

  it.for([
    [
      "failed",
      1,
      "records-failed-phase-outcome",
      "raise deterministic assertion",
      "failed",
      "passed",
      0,
    ],
    [
      "skipped",
      0,
      "records-skipped-phase-outcome",
      "request runtime E2E skip",
      "skipped",
      "passed",
      0,
    ],
    [
      "cleanup-failed",
      1,
      "records-cleanup-failure-phase-outcome",
      E2E_TEARDOWN_PHASE,
      "failed",
      "failed",
      20,
    ],
    ["incomplete", 1, "rejects-incomplete-phase-plan", E2E_TEARDOWN_PHASE, "failed", "failed", 0],
    [
      "soft-failed",
      1,
      "records-soft-failure-on-its-originating-phase",
      "record a soft assertion failure",
      "failed",
      "passed",
      0,
    ],
  ] as const)(
    "records a real Vitest %s result on the originating phase",
    { timeout: 30_000 },
    async (
      [mode, status, slug, phaseLabel, expectedOutcome, expectedTeardownOutcome, minimumDurationMs],
      context,
    ) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-outcome-"));
      try {
        const result = await runFixture(
          {
            ...process.env,
            E2E_ARTIFACT_DIR: artifactDir,
            NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE: mode,
            NEMOCLAW_RUN_LIVE_E2E: "1",
          },
          context,
        );

        const { expect } = context;
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
        const summary = JSON.parse(
          fs.readFileSync(path.join(artifactDir, slug, "test-progress.json"), "utf8"),
        ) as ProgressSummary;
        const phase = summary.phases.find((candidate) => candidate.label === phaseLabel);
        expect(phase).toMatchObject({ outcome: expectedOutcome });
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          `${phaseLabel} — ${expectedOutcome} in`,
        );
        expect(summary.phases.at(-1)).toMatchObject({
          label: E2E_TEARDOWN_PHASE,
          outcome: expectedTeardownOutcome,
        });
        expect(phase?.durationMs).toBeGreaterThanOrEqual(minimumDurationMs);
      } finally {
        fs.rmSync(artifactDir, { recursive: true, force: true });
      }
    },
  );
});
