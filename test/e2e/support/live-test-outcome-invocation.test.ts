// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, type TestContext, vi } from "vitest";

import { superviseChild } from "../../helpers/process-supervisor.ts";

import {
  LIVE_TEST_OUTCOME_FILE,
  readLiveTestOutcome,
} from "../../../tools/e2e/live-test-outcome.mts";
import { RISK_SIGNAL_REPORTER } from "../../../tools/e2e/live-vitest-invocation.mts";
import {
  CLASSIFICATION_LINE_PREFIX,
  renderBaselineLine,
} from "../../../tools/e2e/runner-pressure-core.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = "test/e2e/support/fixtures/live-test-outcome.fixture.test.ts";
const CLASSIFIER = path.join(ROOT, "tools/e2e/runner-pressure.mts");
const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

type CommandResult = {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

async function runCommand(
  owner: Pick<TestContext, "onTestFinished" | "signal">,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  owner.signal.throwIfAborted();
  let stdout = "";
  let stderr = "";
  let outputError: Error | undefined;
  const finishController = new AbortController();
  const append = (current: string, chunk: string, stream: string): string => {
    const next = current + chunk;
    const limitError =
      !outputError && Buffer.byteLength(next, "utf8") > PROCESS_OUTPUT_LIMIT
        ? new Error(`${stream} exceeded the 1 MiB process output limit`)
        : undefined;
    outputError ??= limitError;
    void (limitError ? finishController.abort() : undefined);
    return outputError ? current : next;
  };
  const child = spawn("npx", [...args], {
    cwd: ROOT,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const resultPromise = superviseChild(child, {
    killGraceMs: 0,
    onStderr: (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    },
    onStdout: (chunk) => {
      stdout = append(stdout, chunk, "stdout");
    },
    signal: AbortSignal.any([owner.signal, finishController.signal]),
    timeoutMs: 20_000,
  });
  owner.onTestFinished(async () => {
    finishController.abort();
    await resultPromise;
  });
  const result = await resultPromise;
  const error =
    outputError ??
    result.spawnError ??
    result.cleanupError ??
    (result.timedOut ? new Error("Command exceeded the 20-second timeout") : undefined);
  return {
    ...(error ? { error } : {}),
    status: result.signal ? null : (result.exitCode ?? (error ? -1 : null)),
    stderr,
    stdout,
  };
}

vi.setConfig({ maxConcurrency: 2 });

describe("live-test outcome invocation contract (#7146)", () => {
  it.concurrent.for(["assertion", "timeout"] as const)(
    "carries a real Vitest %s into terminal classification",
    { timeout: 30_000 },
    async (outcome, context) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-outcome-invocation-"));
      const outcomeFile = path.join(artifactDir, LIVE_TEST_OUTCOME_FILE);
      const baselineFile = path.join(artifactDir, "baseline.jsonl");
      try {
        fs.writeFileSync(
          baselineFile,
          `${renderBaselineLine({
            phase: "outcome-fixture",
            at: "2026-07-18T00:00:00.000Z",
            cgroupOomKills: 0,
            kernelOomKillCount: 0,
            containerOomKilled: false,
          })}\n`,
          { mode: 0o600 },
        );
        const vitest = await runCommand(
          context,
          [
            "vitest",
            "run",
            "--project",
            "e2e-support",
            FIXTURE,
            "--reporter=default",
            `--reporter=${RISK_SIGNAL_REPORTER}`,
          ],
          {
            ...process.env,
            E2E_ARTIFACT_DIR: artifactDir,
            E2E_TEST_OUTCOME_FILE: outcomeFile,
            NEMOCLAW_E2E_OUTCOME_FIXTURE: outcome,
          },
        );
        expect(vitest.error).toBeUndefined();
        expect(vitest.status, `${vitest.stdout}\n${vitest.stderr}`).toBe(1);
        expect(readLiveTestOutcome(outcomeFile)).toBe(outcome);

        const classified = await runCommand(context, ["tsx", CLASSIFIER, "classify"], {
          ...process.env,
          E2E_RESOURCE_BASELINE_FILE: baselineFile,
          E2E_TEST_OUTCOME_FILE: outcomeFile,
        });
        expect(classified.error).toBeUndefined();
        expect(classified.status, classified.stderr).toBe(0);
        const line = classified.stdout
          .split("\n")
          .find((candidate) => candidate.startsWith(CLASSIFICATION_LINE_PREFIX));
        expect(line).toBeDefined();
        expect(JSON.parse(line!.slice(CLASSIFICATION_LINE_PREFIX.length)).classification).toBe(
          outcome,
        );
      } finally {
        fs.rmSync(artifactDir, { recursive: true, force: true });
      }
    },
  );
});
