// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { E2E_TEARDOWN_PHASE } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-progress-outcome.fixture.test.ts";

describe("automatic E2E phase outcomes", () => {
  it.each([
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
    (
      mode,
      status,
      slug,
      phaseLabel,
      expectedOutcome,
      expectedTeardownOutcome,
      minimumDurationMs,
    ) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-outcome-"));
      try {
        const result = spawnSync(
          process.execPath,
          [VITEST, "run", "--project", "e2e-support", FIXTURE, "--reporter=default"],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 20_000,
            env: {
              ...process.env,
              E2E_ARTIFACT_DIR: artifactDir,
              NEMOCLAW_E2E_PROGRESS_OUTCOME_FIXTURE: mode,
              NEMOCLAW_RUN_LIVE_E2E: "1",
            },
          },
        );

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
    30_000,
  );
});
