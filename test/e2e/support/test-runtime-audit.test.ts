// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditTestRuntime, formatRuntimeAudit } from "../../../scripts/audit-test-runtime.mts";

function writeProgress(
  root: string,
  run: string,
  scenario: string,
  durationMs: number,
  phase: string,
  phaseDurationMs: number,
): void {
  const directory = path.join(root, run, scenario);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "test-progress.json"),
    `${JSON.stringify({
      version: 1,
      targetId: `${scenario}-target`,
      scenario,
      startedAtMs: 1_000,
      finishedAtMs: 1_000 + durationMs,
      durationMs,
      phases: [
        {
          label: phase,
          startedAtMs: 1_000,
          finishedAtMs: 1_000 + phaseDurationMs,
          durationMs: phaseDurationMs,
          outputEvents: 1,
          lastOutputAtMs: 1_500,
        },
      ],
    })}\n`,
    "utf8",
  );
}

describe("test runtime audit", () => {
  it("ranks repeated artifact summaries by p95 and identifies the slowest phase", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-audit-"));
    try {
      writeProgress(root, "run-1", "variable test", 10_000, "install", 8_000);
      writeProgress(root, "run-2", "variable test", 50_000, "inference", 40_000);
      writeProgress(root, "run-1", "steady test", 20_000, "sandbox", 15_000);

      const rows = auditTestRuntime([root]);

      expect(rows).toEqual([
        {
          target: "variable test-target",
          scenario: "variable test",
          runs: 2,
          medianMs: 30_000,
          p95Ms: 50_000,
          maxMs: 50_000,
          variabilityMs: 20_000,
          slowestPhase: "inference",
          slowestPhaseMs: 40_000,
        },
        {
          target: "steady test-target",
          scenario: "steady test",
          runs: 1,
          medianMs: 20_000,
          p95Ms: 20_000,
          maxMs: 20_000,
          variabilityMs: 0,
          slowestPhase: "sandbox",
          slowestPhaseMs: 15_000,
        },
      ]);
      expect(formatRuntimeAudit(rows)).toContain(
        "| variable test-target | variable test | 2 | 30.0s | 50.0s | 50.0s | 20.0s | inference (40.0s) |",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed progress artifacts instead of producing a misleading ranking", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-audit-invalid-"));
    try {
      fs.writeFileSync(path.join(root, "test-progress.json"), '{"version":1}\n', "utf8");
      expect(() => auditTestRuntime([root])).toThrow(/invalid test progress summary/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
