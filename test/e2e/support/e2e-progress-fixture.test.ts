// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import { assertPhaseLabel } from "../../../tools/e2e/runner-pressure-core.mts";
import { E2E_TEARDOWN_PHASE, resourcePhaseLabel } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-progress.fixture.test.ts";
const ARTIFACT_SLUG = "automatic-progress-fixture-writes-completed-target-and-shard-evidence";

it("bounds long resource phase labels without losing deterministic identity", () => {
  const target = "openshell-gateway-auth-contract";
  const phase = "confirm gateway and Docker prerequisites";
  const label = resourcePhaseLabel(target, phase);

  expect(label).toHaveLength(64);
  expect(label).toMatch(/\.[a-f0-9]{12}$/u);
  expect(assertPhaseLabel(label)).toBe(label);
  expect(resourcePhaseLabel(target, phase)).toBe(label);
  expect(resourcePhaseLabel(target, `${phase} again`)).not.toBe(label);
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
