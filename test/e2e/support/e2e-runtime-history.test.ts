// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeAuditRow } from "../../../scripts/audit-test-runtime.mts";
import {
  buildRuntimeHistory,
  createRuntimeSummary,
  formatRuntimeHistory,
  loadPriorNightlySummaries,
  normalizeRuntimeSummary,
} from "../../../scripts/scorecard/analyze-runtime-history.mts";

function runtimeRow(overrides: Partial<RuntimeAuditRow> = {}): RuntimeAuditRow {
  const medianMs = overrides.medianMs ?? 120_000;
  const p95Ms = overrides.p95Ms ?? medianMs;
  const maxMs = overrides.maxMs ?? p95Ms;
  return {
    target: "rebuild-hermes",
    scenario: "rebuild Hermes from source",
    runs: 1,
    medianMs,
    p95Ms,
    maxMs,
    variabilityMs: overrides.variabilityMs ?? p95Ms - medianMs,
    passedRuns: 1,
    failedRuns: 0,
    skippedRuns: 0,
    slowestPhase: "build Hermes image",
    slowestPhaseMs: 90_000,
    slowestPhaseOutcome: "passed",
    ...overrides,
  };
}

describe("E2E rolling runtime history", () => {
  it("compares current semantic-test timing with prior scheduled summaries", () => {
    const current = runtimeRow({ medianMs: 150_000, p95Ms: 150_000 });
    const prior = [
      createRuntimeSummary(1, "2026-07-20T00:00:00.000Z", [runtimeRow({ medianMs: 100_000 })]),
      createRuntimeSummary(2, "2026-07-21T00:00:00.000Z", [
        runtimeRow({ medianMs: 120_000, passedRuns: 0, failedRuns: 1 }),
      ]),
    ];

    const markdown = formatRuntimeHistory([current], prior);

    expect(markdown).toContain("| rebuild-hermes | rebuild Hermes from source | 2 |");
    expect(markdown).toContain("150.0s | 110.0s | 120.0s | +40.0s (+36.4%)");
    expect(markdown).toContain("50% (1/2) | passed |");
  });

  it("writes the current bounded summary even when history is unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-history-"));
    const output = path.join(directory, "e2e-runtime-summary.json");
    const warning = vi.fn();
    try {
      const markdown = await buildRuntimeHistory(
        {
          github: {},
          context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
          core: { warning },
        },
        [runtimeRow()],
        output,
        { loadPriorNightlySummaries: vi.fn().mockRejectedValue(new Error("unavailable")) },
        new Date("2026-07-22T00:00:00.000Z"),
      );

      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
        schemaVersion: "nemoclaw.e2e_runtime_summary.v1",
        runId: 123,
      });
      expect(markdown).toContain("this run starts the history");
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects outcome counts that do not match the bounded run count", () => {
    const summary = createRuntimeSummary(1, "2026-07-22T00:00:00.000Z", [runtimeRow()]);
    summary.rows[0]!.failedRuns = 2;
    expect(normalizeRuntimeSummary(summary)).toBeNull();
  });

  it("queries only prior completed scheduled runs and tolerates missing artifacts", async () => {
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: { workflow_runs: [{ id: 123 }, { id: 122 }] },
    });
    const paginate = vi.fn().mockResolvedValue([]);
    const summaries = await loadPriorNightlySummaries({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
      github: {
        paginate,
        rest: {
          actions: {
            downloadArtifact: vi.fn(),
            listWorkflowRunArtifacts: {},
            listWorkflowRuns,
          },
        },
      },
    });

    expect(summaries).toEqual([]);
    expect(listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({ event: "schedule", status: "completed", workflow_id: "e2e.yaml" }),
    );
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.[1]).toMatchObject({ run_id: 122 });
  });
});
