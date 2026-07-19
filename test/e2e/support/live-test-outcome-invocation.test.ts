// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

describe("live-test outcome invocation contract (#7146)", () => {
  it.each([
    "assertion",
    "timeout",
  ] as const)("carries a real Vitest %s into terminal classification", (outcome) => {
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
      const vitest = spawnSync(
        "npx",
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
          cwd: ROOT,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            E2E_ARTIFACT_DIR: artifactDir,
            E2E_TEST_OUTCOME_FILE: outcomeFile,
            NEMOCLAW_E2E_OUTCOME_FIXTURE: outcome,
          },
        },
      );
      expect(vitest.status, `${vitest.stdout}\n${vitest.stderr}`).toBe(1);
      expect(readLiveTestOutcome(outcomeFile)).toBe(outcome);

      const classified = spawnSync(
        process.execPath,
        ["--experimental-strip-types", CLASSIFIER, "classify"],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            E2E_RESOURCE_BASELINE_FILE: baselineFile,
            E2E_TEST_OUTCOME_FILE: outcomeFile,
          },
        },
      );
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
  }, 30_000);
});
