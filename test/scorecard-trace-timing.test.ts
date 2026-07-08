// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { ONBOARD_TRACE_PHASE_NAMES } from "../src/lib/onboard/tracing";

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
  exceedsThreshold: (...args: any[]) => boolean;
  formatTopPhaseChanges: (...args: any[]) => string;
  readOnboardPerformanceBudget: () => unknown;
  readValidatedTraceSummaryZip: (
    zipPath: string,
    warn?: (message: string) => void,
  ) => string | null;
  redactSensitiveTraceText: (value: string) => string;
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
        "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED); z.write(sys.argv[2], sys.argv[3]); z.close()",
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

function zipEntries(entries: Record<string, string>): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-trace-summary-zip-"));
  const zipPath = path.join(tempDir, "artifact.zip");
  const payload = JSON.stringify(entries);
  execFileSync(
    "python3",
    [
      "-c",
      "import json, sys, zipfile; entries=json.loads(sys.argv[2]); z=zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED); [z.writestr(name, text) for name, text in entries.items()]; z.close()",
      zipPath,
      payload,
    ],
    { encoding: "utf8" },
  );
  return zipPath;
}

function zipSymlink(entryName: string, target: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-trace-summary-symlink-"));
  const zipPath = path.join(tempDir, "artifact.zip");
  execFileSync(
    "python3",
    [
      "-c",
      "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], 'w'); i=zipfile.ZipInfo(sys.argv[2]); i.create_system=3; i.external_attr=(0o120777 << 16); z.writestr(i, sys.argv[3]); z.close()",
      zipPath,
      entryName,
      target,
    ],
    { encoding: "utf8" },
  );
  return zipPath;
}

function zipDuplicateEntry(entryName: string, text: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-trace-summary-duplicate-"));
  const zipPath = path.join(tempDir, "artifact.zip");
  execFileSync(
    "python3",
    [
      "-c",
      "import sys, warnings, zipfile; warnings.filterwarnings('ignore'); z=zipfile.ZipFile(sys.argv[1], 'w'); z.writestr(sys.argv[2], sys.argv[3]); z.writestr(sys.argv[2], sys.argv[3]); z.close()",
      zipPath,
      entryName,
      text,
    ],
    { encoding: "utf8" },
  );
  return zipPath;
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
        return artifactId === undefined ? [] : [{ id: artifactId, name: "e2e-cloud-onboard" }];
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
      return (
        handler ??
        (() => {
          throw new Error(`Unexpected paginate endpoint: ${String(endpoint)}`);
        })
      )(args);
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
    expect(summaryLines.join("\n")).toContain("Baseline: latest completed `e2e.yaml` run");
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
    expect(result.traceTimingLine).toContain("no prior release tag found");
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

  it("reports budget config unavailable without saying performance budget exceeded", () => {
    const unavailable = traceTiming.evaluateOnboardPerformanceBudget({
      budget: { status: "unavailable", reason: "invalid" },
      currentTrace: { totalMs: 1_000, phases: { "nemoclaw.onboard.phase.preflight": 1_000 } },
    });

    expect(unavailable).toMatchObject({ exceeded: false, status: "config_unavailable" });
    expect(unavailable?.warningMessage).toContain("budget config unavailable");
    expect(unavailable?.warningMessage).not.toContain("performance budget exceeded");
    expect(unavailable?.summary).toContain("Budget: config unavailable");
    expect(unavailable?.summaryLines.join("\n")).toContain(
      "the budget config is invalid or unreadable",
    );
  });

  it("reads the budget only from the repository root", () => {
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    const outsideRepo = mkdtempSync(path.join(tmpdir(), "nemoclaw-budget-outside-"));
    const restoreWorkspace =
      previousWorkspace === undefined
        ? () => {
            delete process.env.GITHUB_WORKSPACE;
          }
        : () => {
            process.env.GITHUB_WORKSPACE = previousWorkspace;
          };
    mkdirSync(path.join(outsideRepo, "ci"));
    writeFileSync(path.join(outsideRepo, "ci", "onboard-performance-budget.json"), "{invalid");
    process.env.GITHUB_WORKSPACE = outsideRepo;
    try {
      expect(traceTiming.readOnboardPerformanceBudget()).toMatchObject({ status: "loaded" });
    } finally {
      rmSync(outsideRepo, { recursive: true, force: true });
      restoreWorkspace();
    }
  });

  it("requires both absolute and percentage thresholds for advisory regressions", () => {
    const threshold = { minDeltaMs: 100, minPercent: 30 };

    expect(traceTiming.exceedsThreshold(250, 100, threshold)).toBe(true);
    expect(traceTiming.exceedsThreshold(150, 100, threshold)).toBe(false);
    expect(traceTiming.exceedsThreshold(1120, 1000, threshold)).toBe(false);
    expect(traceTiming.exceedsThreshold(1050, 1000, threshold)).toBe(false);
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

  it("keeps onboard phase names aligned across emitter sanitizer and scorecard", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nemoclaw-phase-contract-"));
    const tracePath = path.join(tempDir, "trace.json");
    const outputDir = path.join(tempDir, "trusted");
    const emitted = Object.values(ONBOARD_TRACE_PHASE_NAMES).sort();
    writeFileSync(
      tracePath,
      JSON.stringify({
        resource_spans: [
          {
            scope_spans: [
              {
                spans: [
                  { name: "nemoclaw.onboard", duration_ms: emitted.length },
                  ...emitted.map((name) => ({ name, duration_ms: 1 })),
                ],
              },
            ],
          },
        ],
        summary: {
          trace_id: "0123456789abcdef0123456789abcdef",
          total_duration_ms: emitted.length,
          slowest_spans: [],
        },
      }),
    );
    try {
      execFileSync(
        "python3",
        [
          path.resolve(import.meta.dirname, "../scripts/e2e/sanitize-trace-timing.py"),
          tracePath,
          outputDir,
        ],
        { encoding: "utf8" },
      );
      const sanitized = JSON.parse(
        readFileSync(path.join(outputDir, TRACE_SUMMARY_FILE), "utf8"),
      ) as { phases: Record<string, number> };

      expect([...traceTiming.ONBOARD_PHASE_ORDER].sort()).toEqual(emitted);
      expect(Object.keys(sanitized.phases).sort()).toEqual(emitted);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logs sanitized comparison errors without exposing secrets", async () => {
    const warnings: string[] = [];
    const listWorkflowRunArtifacts = Symbol("listWorkflowRunArtifacts");
    const result = await traceTiming.buildTraceTimingResult({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 1 },
      core: { warning: (message: string) => warnings.push(message) },
      github: {
        rest: { actions: { listWorkflowRunArtifacts } },
        paginate: async () => {
          throw new Error(
            'download failed with token=secret Authorization: Bearer abc ghp_123 https://user:pass@example.invalid {"api_key":"abc"}',
          );
        },
      },
    });

    expect(result.traceTimingLine).toBe("Trace: ⊘ comparison unavailable");
    expect(result.traceTimingLine).not.toContain("secret");
    expect(warnings.join("\n")).not.toContain("Bearer abc");
    expect(warnings.join("\n")).not.toContain("ghp_123");
    expect(warnings.join("\n")).not.toContain("user:pass");
    expect(warnings.join("\n")).not.toContain('"abc"');
  });

  it("validates trace summary zip entries before extraction", () => {
    const validZip = zipEntries({ [TRACE_SUMMARY_FILE]: timingSummary() });
    const productionShapeEntries = Object.fromEntries(
      Array.from({ length: 61 }, (_value, index) => [`logs/diagnostic-${index}.txt`, "x"]),
    );
    productionShapeEntries[TRACE_SUMMARY_FILE] = timingSummary();
    const productionShapeZip = zipEntries(productionShapeEntries);
    const traversalZip = zipEntries({ [`../${TRACE_SUMMARY_FILE}`]: timingSummary() });
    const symlinkZip = zipSymlink(TRACE_SUMMARY_FILE, "/etc/passwd");
    const duplicateZip = zipDuplicateEntry(TRACE_SUMMARY_FILE, timingSummary());
    const corruptCrcZip = zipEntries({ [TRACE_SUMMARY_FILE]: timingSummary() });
    const unsupportedCreatorZip = zipEntries({ [TRACE_SUMMARY_FILE]: timingSummary() });
    const corruptCrcArchive = readFileSync(corruptCrcZip);
    const centralDirectoryOffset = corruptCrcArchive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralDirectoryOffset).toBeGreaterThanOrEqual(0);
    corruptCrcArchive[centralDirectoryOffset + 16] ^= 0xff;
    writeFileSync(corruptCrcZip, corruptCrcArchive);
    const unsupportedCreatorArchive = readFileSync(unsupportedCreatorZip);
    const unsupportedCreatorOffset = unsupportedCreatorArchive.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    expect(unsupportedCreatorOffset).toBeGreaterThanOrEqual(0);
    unsupportedCreatorArchive[unsupportedCreatorOffset + 5] = 10;
    writeFileSync(unsupportedCreatorZip, unsupportedCreatorArchive);
    const warnings: string[] = [];
    try {
      expect(traceTiming.readValidatedTraceSummaryZip(validZip)).toContain(
        "nemoclaw.trace_timing.v1",
      );
      expect(traceTiming.readValidatedTraceSummaryZip(productionShapeZip)).toContain(
        "nemoclaw.trace_timing.v1",
      );
      expect(traceTiming.readValidatedTraceSummaryZip(traversalZip)).toBeNull();
      expect(traceTiming.readValidatedTraceSummaryZip(symlinkZip)).toBeNull();
      expect(traceTiming.readValidatedTraceSummaryZip(duplicateZip)).toBeNull();
      expect(
        traceTiming.readValidatedTraceSummaryZip(corruptCrcZip, (message) =>
          warnings.push(message),
        ),
      ).toBeNull();
      expect(traceTiming.readValidatedTraceSummaryZip(unsupportedCreatorZip)).toBeNull();
      expect(warnings).toEqual([
        "Trace timing artifact ZIP validation failed; ignoring the malformed or unsupported archive.",
      ]);
    } finally {
      rmSync(path.dirname(validZip), { recursive: true, force: true });
      rmSync(path.dirname(productionShapeZip), { recursive: true, force: true });
      rmSync(path.dirname(traversalZip), { recursive: true, force: true });
      rmSync(path.dirname(symlinkZip), { recursive: true, force: true });
      rmSync(path.dirname(duplicateZip), { recursive: true, force: true });
      rmSync(path.dirname(corruptCrcZip), { recursive: true, force: true });
      rmSync(path.dirname(unsupportedCreatorZip), { recursive: true, force: true });
    }
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
      traceTimingLine: "Trace: ⊘ e2e-cloud-onboard timing summary not found",
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
        "Trace: cloud-onboard total 1.0s (no e2e.yaml run found for v0.0.1)",
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
        "Trace: cloud-onboard total 1.0s (no timing summary found for v0.0.1)",
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
        "Trace: cloud-onboard total 1.0s (no timing summary found for v0.0.1)",
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
