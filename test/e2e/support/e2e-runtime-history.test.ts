// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeHistorySample } from "../../../scripts/audit-test-runtime.mts";
import {
  evaluateFirstTurnLatencyRecurrence,
  type FirstTurnLatencySample,
} from "../../../scripts/scorecard/analyze-first-turn-latency.mts";
import type { SandboxPhaseTailSample } from "../../../scripts/scorecard/analyze-sandbox-phase-tail.mts";
import {
  buildRuntimeHistory,
  createRuntimeSummary,
  formatRuntimeHistory,
  loadPriorPushHistory,
  loadPriorPushSummaries,
  normalizeRuntimeSummary,
  RUNTIME_SUMMARY_ARTIFACT,
  RUNTIME_SUMMARY_FILE,
} from "../../../scripts/scorecard/analyze-runtime-history.mts";
import { artifactZip } from "../../helpers/artifact-zip";

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

function firstTurnSample(anomaly: boolean): FirstTurnLatencySample {
  return {
    anomaly,
    budgetMs: 14_000,
    cohort: {
      agent: "openclaw",
      inferenceMode: "agent-thinking-off",
      model: "nvidia/nemotron-3-super-120b-a12b",
      promptContract: "sentinel-v1",
      provider: "NVIDIA",
    },
    measurementMs: anomaly ? 14_500 : 8_000,
    overageMs: anomaly ? 500 : 0,
  };
}

function sandboxPhaseSample(anomaly: boolean): SandboxPhaseTailSample {
  return {
    anomaly,
    budgetMs: 208_000,
    cohort: {
      agent: "openclaw",
      baseBuildMode: "published-base",
      platform: "linux",
      setupMode: "source-install",
      workloadKind: "legacy-dockerfile",
    },
    measurementMs: anomaly ? 208_136 : 201_808,
    overageMs: anomaly ? 136 : 0,
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
    expect(markdown).toContain("### Push flake watch");
    expect(markdown).toContain(
      "| rebuild-hermes | rebuild Hermes from source | 4 | 1/3/0 | 75% | 1 | 3 | build Hermes image (3) |",
    );
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

  it("bounds the flake watch and excludes consistently passing or failing tests", () => {
    const intermittent = Array.from({ length: 6 }, (_, index) =>
      runtimeSample({
        target: `target-${index}`,
        scenario: `scenario-${index}`,
        outcome: "failed",
      }),
    );
    const current = [
      ...intermittent,
      runtimeSample({ target: "always-fails", scenario: "broken", outcome: "failed" }),
      runtimeSample({ target: "always-passes", scenario: "healthy" }),
    ];
    const prior = [
      createRuntimeSummary(
        1,
        "2026-07-23T00:00:00.000Z",
        current.map((row) => ({
          ...row,
          outcome: row.target === "always-fails" ? "failed" : "passed",
        })),
      ),
    ];

    const flakeWatch = formatRuntimeHistory(current, prior).split(
      "### Push flake watch\n",
    )[1] as string;

    for (let index = 0; index < 5; index += 1) {
      expect(flakeWatch).toContain(`| target-${index} | scenario-${index} |`);
    }
    expect(flakeWatch).not.toContain("| target-5 | scenario-5 |");
    expect(flakeWatch).not.toContain("always-fails");
    expect(flakeWatch).not.toContain("always-passes");
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
        { loadPriorPushHistory: vi.fn().mockRejectedValue(new Error("unavailable")) },
        new Date("2026-07-24T00:00:00.000Z"),
      );

      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
        schemaVersion: "nemoclaw.e2e_runtime_summary.v3",
        firstTurnLatency: null,
        sandboxPhaseTail: null,
        runId: 123,
      });
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect(markdown).toContain("this run starts the history");
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("saves current latency evidence and fails a corroborated 12-sample recurrence (#6660)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-history-"));
    const output = path.join(directory, "e2e-runtime-summary.json");
    const setFailed = vi.fn();
    const prior = Array.from({ length: 11 }, (_, index) =>
      createRuntimeSummary(
        index + 1,
        new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
        [runtimeSample()],
        firstTurnSample(index === 0),
      ),
    );
    try {
      const markdown = await buildRuntimeHistory(
        {
          github: {},
          context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
          core: { setFailed },
        },
        [runtimeSample()],
        output,
        {
          currentFirstTurnLatency: firstTurnSample(true),
          loadPriorPushHistory: vi.fn().mockResolvedValue({
            summaries: prior,
            unavailableRuns: 0,
          }),
        },
        new Date("2026-07-24T00:00:00.000Z"),
      );

      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
        firstTurnLatency: { anomaly: true, overageMs: 500 },
      });
      expect(markdown).toContain("## Hosted First-Turn Latency");
      expect(setFailed).toHaveBeenCalledWith(
        expect.stringContaining("2 anomalies in 12 eligible same-cohort samples"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("saves one sandbox anomaly after four passing same-cohort samples (#6660)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-history-"));
    const output = path.join(directory, "e2e-runtime-summary.json");
    const setFailed = vi.fn();
    const prior = Array.from({ length: 4 }, (_, index) =>
      createRuntimeSummary(
        index + 1,
        new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
        [runtimeSample()],
        null,
        sandboxPhaseSample(false),
      ),
    );
    try {
      const markdown = await buildRuntimeHistory(
        {
          github: {},
          context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
          core: { setFailed },
        },
        [runtimeSample({ target: "full-e2e", scenario: "cold onboard" })],
        output,
        {
          currentSandboxPhaseTail: sandboxPhaseSample(true),
          loadPriorPushHistory: vi.fn().mockResolvedValue({
            summaries: prior,
            unavailableRuns: 0,
          }),
        },
        new Date("2026-08-21T00:00:00.000Z"),
      );

      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
        sandboxPhaseTail: { anomaly: true, overageMs: 136 },
      });
      expect(markdown).toContain("## Sandbox Phase Latency");
      expect(setFailed).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when one sandbox anomaly has no readable history (#6660)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-history-"));
    const output = path.join(directory, "e2e-runtime-summary.json");
    const setFailed = vi.fn();
    try {
      await buildRuntimeHistory(
        {
          github: {},
          context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
          core: { setFailed, warning: vi.fn() },
        },
        [runtimeSample({ target: "full-e2e", scenario: "cold onboard" })],
        output,
        {
          currentSandboxPhaseTail: sandboxPhaseSample(true),
          loadPriorPushHistory: vi.fn().mockRejectedValue(new Error("unavailable")),
        },
        new Date("2026-08-21T00:00:00.000Z"),
      );

      expect(setFailed).toHaveBeenCalledWith(
        expect.stringContaining("one or more prior push summaries are unavailable"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate identities, duplicate phases, and extra fields", () => {
    const summary = createRuntimeSummary(1, "2026-07-24T00:00:00.000Z", [runtimeSample()]);
    const { firstTurnLatency: _, sandboxPhaseTail: __, ...legacy } = summary;
    expect(
      normalizeRuntimeSummary({
        ...legacy,
        schemaVersion: "nemoclaw.e2e_runtime_summary.v1",
      }),
    ).toMatchObject({ firstTurnLatency: null });
    const { sandboxPhaseTail: ___, ...previous } = summary;
    expect(
      normalizeRuntimeSummary({
        ...previous,
        schemaVersion: "nemoclaw.e2e_runtime_summary.v2",
      }),
    ).toMatchObject({ sandboxPhaseTail: null });
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

  it("queries only prior completed push runs and tolerates missing artifacts", async () => {
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: { workflow_runs: [{ id: 123 }, { id: 122 }] },
    });
    const paginate = vi.fn().mockResolvedValue([]);
    const history = await loadPriorPushHistory({
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

    expect(history).toEqual({ summaries: [], unavailableRuns: 1 });
    expect(listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "push",
        status: "completed",
        workflow_id: "e2e.yaml",
      }),
    );
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.[1]).toMatchObject({ run_id: 122 });
  });

  it("loads older eligible samples after recent summaries without cohort evidence (#6660)", async () => {
    const runIds = Array.from({ length: 12 }, (_, index) => 200 - index);
    const summaries = new Map(
      runIds.map((runId, index) => [
        runId,
        createRuntimeSummary(
          runId,
          new Date(Date.UTC(2026, 6, 20 - index)).toISOString(),
          [runtimeSample()],
          index === 0 ? null : firstTurnSample(index === runIds.length - 1),
        ),
      ]),
    );
    const loaded = await loadPriorPushSummaries({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 999 },
      github: {
        paginate: vi.fn(
          async (
            _method: unknown,
            options: { run_id: number },
          ): Promise<Array<{ expired: boolean; id: number; name: string }>> => [
            {
              expired: false,
              id: options.run_id + 1_000,
              name: RUNTIME_SUMMARY_ARTIFACT,
            },
          ],
        ),
        rest: {
          actions: {
            downloadArtifact: vi.fn(
              async (options: { artifact_id: number }): Promise<{ data: Buffer }> => ({
                data: artifactZip([
                  {
                    name: RUNTIME_SUMMARY_FILE,
                    contents: JSON.stringify(summaries.get(options.artifact_id - 1_000)),
                  },
                ]),
              }),
            ),
            listWorkflowRunArtifacts: {},
            listWorkflowRuns: vi.fn().mockResolvedValue({
              data: { workflow_runs: runIds.map((id) => ({ id })) },
            }),
          },
        },
      },
    });

    expect(loaded).toHaveLength(12);
    expect(evaluateFirstTurnLatencyRecurrence(firstTurnSample(true), loaded)).toMatchObject({
      anomalyCount: 2,
      eligibleSamples: 12,
      passed: false,
    });
  });

  it("rejects a runtime summary whose embedded run ID does not match its workflow run", async () => {
    const summary = createRuntimeSummary(121, "2026-07-23T00:00:00.000Z", [runtimeSample()]);
    const downloadArtifact = vi.fn().mockResolvedValue({
      data: artifactZip([{ name: RUNTIME_SUMMARY_FILE, contents: JSON.stringify(summary) }]),
    });
    const summaries = await loadPriorPushSummaries({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
      github: {
        paginate: vi
          .fn()
          .mockResolvedValue([{ expired: false, id: 456, name: RUNTIME_SUMMARY_ARTIFACT }]),
        rest: {
          actions: {
            downloadArtifact,
            listWorkflowRunArtifacts: {},
            listWorkflowRuns: vi.fn().mockResolvedValue({
              data: { workflow_runs: [{ id: 122 }] },
            }),
          },
        },
      },
    });

    expect(summaries).toEqual([]);
    expect(downloadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifact_id: 456, archive_format: "zip" }),
    );
  });
});
