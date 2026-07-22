// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, it, vi } from "vitest";
import { assertPhaseLabel, parseSnapshotLine } from "../../../tools/e2e/runner-pressure-core.mts";
import { E2E_TEARDOWN_PHASE, resourcePhaseLabel, test } from "../fixtures/e2e-test.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-progress-fixture-"));
const resourceSnapshots = path.join(artifactRoot, "runner-resource-snapshots.jsonl");
let progressArtifact = "";

const fixtureEnvironment = {
  E2E_ARTIFACT_DIR: artifactRoot,
  E2E_TARGET_ID: "fixture-progress-target",
  NEMOCLAW_E2E_SHARD: "fixture-progress-shard",
  E2E_RESOURCE_SNAPSHOTS_FILE: resourceSnapshots,
} as const;
const previousEnvironment = Object.fromEntries(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
) as Record<keyof typeof fixtureEnvironment, string | undefined>;
Object.assign(process.env, fixtureEnvironment);
fs.writeFileSync(resourceSnapshots, "", { mode: 0o600 });

afterAll(() => {
  try {
    const summary = JSON.parse(fs.readFileSync(progressArtifact, "utf8")) as ProgressSummary;
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
    ).toMatchObject({
      outcome: "passed",
    });
    expect(summary.phases.at(-1)).toMatchObject({
      label: E2E_TEARDOWN_PHASE,
      outcome: "passed",
    });
    const snapshots = fs
      .readFileSync(resourceSnapshots, "utf8")
      .trim()
      .split("\n")
      .map(parseSnapshotLine);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
      "fixture-progress-target.prepare-progress-artifact",
      "fixture-progress-target.record-final-fixture-phase",
      "fixture-progress-target.release-registered-e2e-resources",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  }
});

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

test("automatic progress fixture writes completed target and shard evidence", {
  meta: {
    e2ePhases: ["prepare progress artifact", "record final fixture phase"],
  },
}, async ({ artifacts, progress }) => {
  progressArtifact = artifacts.pathFor("test-progress.json");
  vi.stubEnv("E2E_TARGET_ID", "fixture-progress-target");
  vi.stubEnv("NEMOCLAW_E2E_SHARD", "fixture-progress-shard");
  progress.phase("record final fixture phase");
});
