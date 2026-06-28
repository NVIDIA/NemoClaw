// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

type TraceTimingAnalyzer = {
  ONBOARD_PHASE_ORDER: readonly string[];
  TRACE_SUMMARY_FILE: string;
  buildPhaseRows: (...args: any[]) => Array<{
    label: string;
    currentMs: number;
    priorMs: number;
    deltaAbsMs: number;
    deltaMs?: number;
  }>;
  buildTraceTimingResult: (...args: any[]) => Promise<any>;
  buildTraceSummaryLines: (...args: any[]) => string[];
  evaluateOnboardPerformanceBudget: (...args: any[]) => any;
  formatTopPhaseChanges: (...args: any[]) => string;
  readOnboardPerformanceBudget: (rootDir?: string) => unknown;
  selectOnboardTrace: (
    ...args: any[]
  ) => { totalMs: number; phases: Record<string, number> } | null;
};

const require = createRequire(import.meta.url);
const traceTiming: TraceTimingAnalyzer = require("../scripts/scorecard/analyze-trace-timing.ts");
const TRACE_SUMMARY_FILE = "cloud-onboard-trace-timing-summary.json";

function timingSummary(
  phases: Record<string, number> = { "nemoclaw.onboard.phase.preflight": 1000 },
): string {
  return JSON.stringify({
    schema_version: "nemoclaw.trace_timing.v1",
    total_duration_ms: Object.values(phases).reduce((total, value) => total + value, 0) || 1000,
    phases,
  });
}

function zippedTimingSummary(text: string): Buffer {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-trace-summary-zip-"));
  try {
    writeFileSync(path.join(tempDir, TRACE_SUMMARY_FILE), text, "utf8");
    execFileSync(
      "python3",
      [
        "-c",
        "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], 'w'); z.write(sys.argv[2], sys.argv[3]); z.close()",
        path.join(tempDir, "artifact.zip"),
        path.join(tempDir, TRACE_SUMMARY_FILE),
        TRACE_SUMMARY_FILE,
      ],
      { encoding: "utf8" },
    );
    return readFileSync(path.join(tempDir, "artifact.zip"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function traceGithubFixture(options: {
  summariesByRunId?: Record<number, string>;
  tags?: Array<{ name: string; sha: string }>;
  runsByHeadSha?: Record<string, Array<{ id: number; status: string }>>;
}) {
  const artifactIdsByRunId = new Map<number, number>();
  const artifactDataById = new Map<number, Buffer>();
  let nextArtifactId = 100;
  for (const [runIdText, summary] of Object.entries(options.summariesByRunId ?? {})) {
    const runId = Number(runIdText);
    const artifactId = nextArtifactId++;
    artifactIdsByRunId.set(runId, artifactId);
    artifactDataById.set(artifactId, zippedTimingSummary(summary));
  }

  const listWorkflowRunArtifacts = Symbol("listWorkflowRunArtifacts");
  const listWorkflowRuns = Symbol("listWorkflowRuns");
  const listTags = Symbol("listTags");
  const paginateHandlers = new Map<symbol, (args: Record<string, any>) => unknown[]>([
    [
      listWorkflowRunArtifacts,
      (args) => {
        const artifactId = artifactIdsByRunId.get(Number(args.run_id));
        return artifactId === undefined ? [] : [{ id: artifactId, name: "cloud-onboard-traces" }];
      },
    ],
    [
      listTags,
      () =>
        (options.tags ?? []).map((tag) => ({
          name: tag.name,
          commit: { sha: tag.sha },
        })),
    ],
  ]);

  const github: any = {
    rest: {
      actions: {
        listWorkflowRunArtifacts,
        listWorkflowRuns,
        downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => ({
          data: artifactDataById.get(artifact_id) ?? Buffer.alloc(0),
        }),
      },
      repos: { listTags },
    },
    paginate: async (endpoint: symbol, args: Record<string, any>) => {
      const handler = paginateHandlers.get(endpoint);
      return (handler ?? (() => { throw new Error(`Unexpected paginate endpoint: ${String(endpoint)}`); }))(args);
    },
  };

  github.rest.actions.listWorkflowRuns = async ({ head_sha }: { head_sha: string }) => ({
    data: { workflow_runs: options.runsByHeadSha?.[head_sha] ?? [] },
  });

  return github;
}

describe("cloud onboard scorecard trace timing", () => {
  it("compares cloud onboard trace phases against the prior release commit run", () => {
    const phaseRows = traceTiming.buildPhaseRows(
      {
        "nemoclaw.onboard.phase.preflight": 1_000,
        "nemoclaw.onboard.phase.gateway": 5_000,
        "nemoclaw.onboard.phase.sandbox": 2_000,
        "nemoclaw.onboard.phase.renamed": 20_000,
      },
      {
        "nemoclaw.onboard.phase.preflight": 2_000,
        "nemoclaw.onboard.phase.gateway": 3_000,
        "nemoclaw.onboard.phase.sandbox": 10_000,
        "nemoclaw.onboard.phase.old": 20_000,
      },
    );
    const summaryLines = traceTiming.buildTraceSummaryLines(
      { totalMs: 8_000 },
      { totalMs: 15_000 },
      { name: "v0.0.56" },
      phaseRows,
    );

    expect(phaseRows.map((row) => row.label)).toEqual(["preflight", "gateway", "sandbox"]);
    expect(traceTiming.formatTopPhaseChanges(phaseRows)).toBe(
      "sandbox -8.0s; gateway +2.0s; preflight -1.0s",
    );
    expect(
      traceTiming.buildTraceSummaryLines({ totalMs: 1 }, { totalMs: 2 }, { name: "v0" }, []),
    ).toEqual([]);
    expect(summaryLines).toContain("## Cloud Onboard Trace Timing");
    expect(summaryLines).toContain("| Phase | Current | Previous | Delta |");
    expect(summaryLines.join("\n")).toContain("Baseline: latest completed `nightly-e2e.yaml` run");
  });

  it("evaluates cloud onboard timing against the advisory performance budget", () => {
    const budget = traceTiming.readOnboardPerformanceBudget();
    const phaseRows = traceTiming.buildPhaseRows(
      {
        "nemoclaw.onboard.phase.preflight": 90_000,
        "nemoclaw.onboard.phase.gateway": 60_000,
        "nemoclaw.onboard.phase.sandbox": 700_000,
      },
      {
        "nemoclaw.onboard.phase.preflight": 20_000,
        "nemoclaw.onboard.phase.gateway": 60_000,
        "nemoclaw.onboard.phase.sandbox": 500_000,
      },
    );

    const warning = traceTiming.evaluateOnboardPerformanceBudget({
      budget,
      currentTrace: { totalMs: 850_000 },
      priorTrace: { totalMs: 580_000 },
      phaseRows,
    });
    const ok = traceTiming.evaluateOnboardPerformanceBudget({
      budget,
      currentTrace: { totalMs: 100_000 },
      priorTrace: { totalMs: 95_000 },
      phaseRows: [],
    });

    expect(warning).toMatchObject({ exceeded: true });
    expect(warning?.summary).toContain("Budget: advisory warning");
    expect(warning?.warningMessage).toContain("performance budget exceeded");
    expect(warning?.summaryLines.join("\n")).toContain("total 14m 10.0s exceeds warm budget");
    expect(warning?.summaryLines.join("\n")).toContain("phase regressions");
    expect(ok).toMatchObject({ exceeded: false });
    expect(ok?.summary).toContain("Budget: advisory OK");
  });

  it("lists current slowest onboard phases when total budget is exceeded without a prior baseline", async () => {
    const result = await traceTiming.buildTraceTimingResult({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 1, ref: "refs/heads/main" },
      github: traceGithubFixture({
        summariesByRunId: {
          1: timingSummary({
            "nemoclaw.onboard.phase.preflight": 90_000,
            "nemoclaw.onboard.phase.gateway": 60_000,
            "nemoclaw.onboard.phase.provider_selection": 1_000,
            "nemoclaw.onboard.phase.inference": 10_000,
            "nemoclaw.onboard.phase.sandbox": 700_000,
          }),
        },
      }),
    });

    const summary = result.traceSummaryLines.join("\n");
    expect(result.budgetExceeded).toBe(true);
    expect(result.budgetWarningMessage).toContain("performance budget exceeded");
    expect(result.traceTimingLine).toContain("Budget: advisory warning");
    expect(summary).toContain("Current slowest phases:");
    expect(summary).toContain("- sandbox: 11m 40.0s");
    expect(summary).toContain("- preflight: 1m 30.0s");
    expect(summary).toContain("- gateway: 1m 0.0s");
  });

  it("lists current slowest onboard phases when total regression exceeds the advisory threshold but total remains under budget", () => {
    const budget = traceTiming.readOnboardPerformanceBudget();
    const warning = traceTiming.evaluateOnboardPerformanceBudget({
      budget,
      currentTrace: {
        totalMs: 300_000,
        phases: {
          "nemoclaw.onboard.phase.preflight": 20_000,
          "nemoclaw.onboard.phase.gateway": 80_000,
          "nemoclaw.onboard.phase.sandbox": 200_000,
        },
      },
      priorTrace: { totalMs: 200_000 },
      phaseRows: [],
    });

    const summary = warning?.summaryLines.join("\n") ?? "";
    expect(warning).toMatchObject({ exceeded: true });
    expect(warning?.summary).toContain("total regression");
    expect(summary).toContain("Current slowest phases:");
    expect(summary).toContain("- sandbox: 3m 20.0s");
    expect(summary).toContain("- gateway: 1m 20.0s");
    expect(summary).toContain("- preflight: 20.0s");
  });

  it("lists current slowest onboard phases when only phase regression exceeds the advisory threshold", () => {
    const budget = traceTiming.readOnboardPerformanceBudget();
    const phaseRows = traceTiming.buildPhaseRows(
      {
        "nemoclaw.onboard.phase.preflight": 20_000,
        "nemoclaw.onboard.phase.gateway": 80_000,
        "nemoclaw.onboard.phase.sandbox": 200_000,
      },
      {
        "nemoclaw.onboard.phase.preflight": 20_000,
        "nemoclaw.onboard.phase.gateway": 80_000,
        "nemoclaw.onboard.phase.sandbox": 100_000,
      },
    );
    const warning = traceTiming.evaluateOnboardPerformanceBudget({
      budget,
      currentTrace: {
        totalMs: 300_000,
        phases: {
          "nemoclaw.onboard.phase.preflight": 20_000,
          "nemoclaw.onboard.phase.gateway": 80_000,
          "nemoclaw.onboard.phase.sandbox": 200_000,
        },
      },
      priorTrace: { totalMs: 280_000 },
      phaseRows,
    });

    const summary = warning?.summaryLines.join("\n") ?? "";
    expect(warning).toMatchObject({ exceeded: true });
    expect(warning?.summary).toContain("phase regressions");
    expect(summary).toContain("Current slowest phases:");
    expect(summary).toContain("- sandbox: 3m 20.0s");
    expect(summary).toContain("- gateway: 1m 20.0s");
    expect(summary).toContain("- preflight: 20.0s");
  });

  it("scorecard warns budget config unavailable without saying performance budget exceeded", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-budget-config-"));
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    const restoreWorkspace =
      previousWorkspace === undefined
        ? () => {
            delete process.env.GITHUB_WORKSPACE;
          }
        : () => {
            process.env.GITHUB_WORKSPACE = previousWorkspace;
          };
    try {
      mkdirSync(path.join(tempRoot, "ci"));
      writeFileSync(
        path.join(tempRoot, "ci", "onboard-performance-budget.json"),
        "{not-json",
        "utf8",
      );
      process.env.GITHUB_WORKSPACE = tempRoot;

      const result = await traceTiming.buildTraceTimingResult({
        context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 1, ref: "refs/heads/main" },
        github: traceGithubFixture({ summariesByRunId: { 1: timingSummary() } }),
      });

      expect(result.budgetExceeded).toBe(true);
      expect(result.budgetWarningMessage).toContain("performance budget unavailable");
      expect(result.budgetWarningMessage).not.toContain("performance budget exceeded");
      expect(result.traceTimingLine).toContain("Trace: cloud-onboard total 1.0s");
      expect(result.traceTimingLine).toContain("Budget: advisory warning");
      expect(result.traceSummaryLines.join("\n")).toContain(
        "the budget config is invalid or unreadable",
      );
    } finally {
      restoreWorkspace();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps trace timing analysis limited to the trusted summary schema", () => {
    const goodSummary = JSON.stringify({
      schema_version: "nemoclaw.trace_timing.v1",
      total_duration_ms: 1000,
      phases: {
        "nemoclaw.onboard.phase.preflight": 500,
      },
    });
    const unknownPhaseSummary = JSON.stringify({
      schema_version: "nemoclaw.trace_timing.v1",
      total_duration_ms: 1000,
      phases: {
        "nemoclaw.onboard.phase.preflight": 500,
        "nemoclaw.onboard.phase.future": 500,
      },
    });
    const negativeDurationSummary = JSON.stringify({
      schema_version: "nemoclaw.trace_timing.v1",
      total_duration_ms: -1,
      phases: {
        "nemoclaw.onboard.phase.preflight": 500,
      },
    });

    expect(traceTiming.TRACE_SUMMARY_FILE).toBe("cloud-onboard-trace-timing-summary.json");
    expect(traceTiming.ONBOARD_PHASE_ORDER).toEqual([
      "nemoclaw.onboard.phase.preflight",
      "nemoclaw.onboard.phase.gateway",
      "nemoclaw.onboard.phase.provider_selection",
      "nemoclaw.onboard.phase.inference",
      "nemoclaw.onboard.phase.sandbox",
    ]);
    expect(traceTiming.selectOnboardTrace([goodSummary])?.totalMs).toBe(1000);
    expect(traceTiming.selectOnboardTrace([unknownPhaseSummary])).toMatchObject({
      totalMs: 1000,
      phases: { "nemoclaw.onboard.phase.preflight": 500 },
    });
    expect(traceTiming.selectOnboardTrace([negativeDurationSummary])).toBeNull();
  });

  it("does not expose raw comparison errors in trace timing output", async () => {
    const result = await traceTiming.buildTraceTimingResult({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 1 },
      github: {
        paginate: async () => {
          throw new Error("download failed with token=secret");
        },
      },
    });

    expect(result.traceTimingLine).toBe("Trace: ⊘ comparison unavailable");
    expect(result.traceTimingLine).not.toContain("secret");
  });

  it("covers trace timing fallback branches with mocked GitHub data", async () => {
    const context = {
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
      runId: 1,
      ref: "refs/heads/main",
    };

    await expect(
      traceTiming.buildTraceTimingResult({
        context,
        github: traceGithubFixture({}),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: "Trace: ⊘ cloud-onboard-traces artifact not found for this run",
    });

    await expect(
      traceTiming.buildTraceTimingResult({
        context,
        github: traceGithubFixture({ summariesByRunId: { 1: timingSummary() } }),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 1.0s (no prior release tag found)",
      ),
    });

    await expect(
      traceTiming.buildTraceTimingResult({
        context,
        github: traceGithubFixture({
          summariesByRunId: { 1: timingSummary() },
          tags: [{ name: "v0.0.1", sha: "prior-sha" }],
        }),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 1.0s (no nightly-e2e run found for v0.0.1)",
      ),
    });

    await expect(
      traceTiming.buildTraceTimingResult({
        context,
        github: traceGithubFixture({
          summariesByRunId: { 1: timingSummary() },
          tags: [{ name: "v0.0.1", sha: "prior-sha" }],
          runsByHeadSha: { "prior-sha": [{ id: 2, status: "completed" }] },
        }),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 1.0s (no cloud-onboard-traces artifact found for v0.0.1)",
      ),
    });

    await expect(
      traceTiming.buildTraceTimingResult({
        context,
        github: traceGithubFixture({
          summariesByRunId: { 1: timingSummary(), 2: "{not-json" },
          tags: [{ name: "v0.0.1", sha: "prior-sha" }],
          runsByHeadSha: { "prior-sha": [{ id: 2, status: "completed" }] },
        }),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 1.0s (no cloud-onboard-traces artifact found for v0.0.1)",
      ),
    });
  });

  it("keeps total trace comparison when phase names do not overlap", async () => {
    const result = await traceTiming.buildTraceTimingResult({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 1 },
      github: traceGithubFixture({
        summariesByRunId: {
          1: timingSummary({ "nemoclaw.onboard.phase.preflight": 1000 }),
          2: timingSummary({ "nemoclaw.onboard.phase.gateway": 2000 }),
        },
        tags: [{ name: "v0.0.1", sha: "prior-sha" }],
        runsByHeadSha: { "prior-sha": [{ id: 2, status: "completed" }] },
      }),
    });

    expect(result.traceTimingLine).toContain(
      "Trace: cloud-onboard total 1.0s, decreased -1.0s (-50.0%) vs v0.0.1.",
    );
    expect(result.traceSummaryLines.join("\n")).toContain("Onboard Performance Budget");
  });
});
