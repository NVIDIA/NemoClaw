// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import {
  E2E_TEARDOWN_PHASE,
  resourcePhaseLabel,
  runnerComparisonProgressOptions,
  runnerComparisonSampleIntervalMs,
} from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-progress.fixture.test.ts";
const ARTIFACT_SLUG = "automatic-progress-fixture-writes-completed-target-and-shard-evidence";

it.each([
  "rebuild-hermes",
  "rebuild-hermes-stale-base",
])("samples runner pressure every 15 seconds for %s (#7144)", (targetId) => {
  expect(runnerComparisonSampleIntervalMs(targetId)).toBe(15_000);
});

it.each([
  "hermes-e2e",
  "hermes-discord",
  null,
])("keeps the 60-second runner-pressure cadence for %s (#7144)", (targetId) => {
  expect(runnerComparisonSampleIntervalMs(targetId)).toBe(60_000);
});

it.each([
  ["rebuild-hermes", 15_000],
  ["rebuild-hermes-stale-base", 15_000],
  ["hermes-e2e", 60_000],
] as const)("wires the live %s comparison cadence into progress options (#7144)", (targetId, intervalMs) => {
  const samples: Array<{ kind: string; phase: string }> = [];
  const options = runnerComparisonProgressOptions(
    {
      E2E_ARTIFACT_DIR: "artifacts",
      E2E_TARGET_ID: targetId,
      NEMOCLAW_RUN_LIVE_E2E: "1",
    },
    (phase, kind) => {
      samples.push({ kind, phase });
      return true;
    },
  );

  expect(options.resourceSampleIntervalMs).toBe(intervalMs);
  expect(options.recordResourceSample?.("build Hermes image", "periodic")).toBe(true);
  expect(samples).toEqual([
    {
      kind: "periodic",
      phase: resourcePhaseLabel(targetId, "build Hermes image"),
    },
  ]);
});

it.each([
  [{ E2E_ARTIFACT_DIR: "artifacts", E2E_TARGET_ID: "rebuild-hermes" }],
  [
    {
      E2E_ARTIFACT_DIR: "artifacts",
      E2E_TARGET_ID: "rebuild-hermes",
      NEMOCLAW_RUN_LIVE_E2E: "0",
    },
  ],
  [{ E2E_TARGET_ID: "rebuild-hermes", NEMOCLAW_RUN_LIVE_E2E: "1" }],
])("keeps comparison progress disabled outside a qualifying live environment (#7144)", (environment) => {
  expect(runnerComparisonProgressOptions(environment)).toEqual({});
});


it("writes completed target and shard evidence through the automatic progress fixture", () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-fixture-"));
  try {
    const result = spawnSync(
      process.execPath,
      [VITEST, "run", "--project", "e2e-support", FIXTURE, "--reporter=default"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 20_000,
        env: {
          ...process.env,
          E2E_ARTIFACT_DIR: artifactRoot,
          E2E_TARGET_ID: "",
          GITHUB_JOB: "fixture-progress-target",
          NEMOCLAW_E2E_PROGRESS_FIXTURE: "identity",
          NEMOCLAW_E2E_SHARD: "fixture-progress-shard",
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const summary = JSON.parse(
      fs.readFileSync(path.join(artifactRoot, ARTIFACT_SLUG, "test-progress.json"), "utf8"),
    ) as ProgressSummary;
    expect(summary).toMatchObject({
      version: 1,
      scenario: "automatic progress fixture writes completed target and shard evidence",
      targetId: "fixture-progress-target",
      shardId: "fixture-progress-shard",
    });
    expect(summary.finishedAtMs).not.toBeNull();
    expect(summary.durationMs).not.toBeNull();
    expect(
      summary.phases.find((phase) => phase.label === "record final fixture phase"),
    ).toMatchObject({ outcome: "passed" });
    expect(summary.phases.at(-1)).toMatchObject({
      label: E2E_TEARDOWN_PHASE,
      outcome: "passed",
    });
  } finally {
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  }
});
