// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeHistorySample } from "../../../scripts/audit-test-runtime.mts";
import {
  buildRuntimeHistory,
  createRuntimeSummary,
  formatRuntimeHistory,
  loadPriorNightlySummaries,
  normalizeRuntimeSummary,
} from "../../../scripts/scorecard/analyze-runtime-history.mts";

function runtimeSample(overrides: Partial<RuntimeHistorySample> = {}): RuntimeHistorySample {
  return {
    target: "rebuild-hermes",
    scenario: "rebuild Hermes from source",
    durationMs: 120_000,
    outcome: "passed",
    phases: [{ label: "build Hermes image", durationMs: 70_000, outcome: "passed" }],
    ...overrides,
  };
}

describe("E2E rolling runtime history", () => {
  it("reports runtime distribution, outcomes, failure streaks, and significant phase regressions", () => {
    const current = runtimeSample({
      durationMs: 180_000,
      outcome: "failed",
      phases: [{ label: "build Hermes image", durationMs: 120_000, outcome: "failed" }],
    });
    const prior = [
      createRuntimeSummary(1, "2026-07-23T00:00:00.000Z", [
        runtimeSample({
          durationMs: 100_000,
          outcome: "failed",
          phases: [{ label: "build Hermes image", durationMs: 60_000, outcome: "failed" }],
        }),
      ]),
      createRuntimeSummary(2, "2026-07-22T00:00:00.000Z", [
        runtimeSample({
          durationMs: 120_000,
          outcome: "failed",
          phases: [{ label: "build Hermes image", durationMs: 70_000, outcome: "failed" }],
        }),
      ]),
      createRuntimeSummary(3, "2026-07-21T00:00:00.000Z", [
        runtimeSample({
          durationMs: 110_000,
          phases: [{ label: "build Hermes image", durationMs: 65_000, outcome: "passed" }],
        }),
      ]),
    ];

    const markdown = formatRuntimeHistory([current], prior);

    expect(markdown).toContain("| rebuild-hermes | rebuild Hermes from source | 3 |");
    expect(markdown).toContain("180.0s | 110.0s | 120.0s | +70.0s (+63.6%)");
    expect(markdown).toContain("failed | 33%/67%/0% (1/2/0) | 3 |");
    expect(markdown).toContain("build Hermes image (3)");
    expect(markdown).toContain("⚠ total +70.0s (+63.6%); build Hermes image +55.0s (+84.6%)");
  });

  it("does not flag small changes that miss either regression threshold", () => {
    const current = runtimeSample({
      durationMs: 121_000,
      phases: [{ label: "build Hermes image", durationMs: 71_000, outcome: "passed" }],
    });
    const prior = [createRuntimeSummary(1, "2026-07-23T00:00:00.000Z", [runtimeSample()])];

    const markdown = formatRuntimeHistory([current], prior);

    expect(markdown).toContain("+1.0s (+0.8%)");
    expect(markdown).toContain("| — |");
    expect(markdown).not.toContain("⚠");
  });

  it("writes a private bounded current summary when prior history is unavailable", async () => {
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
        [runtimeSample()],
        output,
        { loadPriorNightlySummaries: vi.fn().mockRejectedValue(new Error("unavailable")) },
        new Date("2026-07-24T00:00:00.000Z"),
      );

      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
        schemaVersion: "nemoclaw.e2e_runtime_summary.v1",
        runId: 123,
      });
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect(markdown).toContain("this run starts the history");
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate identities, duplicate phases, and extra fields", () => {
    const summary = createRuntimeSummary(1, "2026-07-24T00:00:00.000Z", [runtimeSample()]);
    expect(normalizeRuntimeSummary({ ...summary, extra: true })).toBeNull();
    expect(
      normalizeRuntimeSummary({ ...summary, rows: [summary.rows[0], summary.rows[0]] }),
    ).toBeNull();
    expect(
      normalizeRuntimeSummary({
        ...summary,
        rows: [
          {
            ...summary.rows[0],
            phases: [summary.rows[0]!.phases[0], summary.rows[0]!.phases[0]],
          },
        ],
      }),
    ).toBeNull();
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
      expect.objectContaining({
        event: "schedule",
        status: "completed",
        workflow_id: "e2e.yaml",
      }),
    );
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.[1]).toMatchObject({ run_id: 122 });
  });
});
