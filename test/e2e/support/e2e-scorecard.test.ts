// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ScorecardData } from "../../../scripts/scorecard/build-slack-blocks.ts";
import type { JobSummary, SummarizeJobsInput } from "../../../scripts/scorecard/summarize-jobs.ts";

const require = createRequire(import.meta.url);
const slack = require("../../../scripts/scorecard/build-slack-blocks.ts") as {
  buildBlocks: (data: ScorecardData) => Array<{
    elements?: Array<{ text?: { text?: string }; url?: string }>;
    text?: { text: string };
    type: string;
  }>;
  buildFallbackText: (data: ScorecardData) => string;
  getSlackChannel: (data: ScorecardData) => string;
};
const trace = require("../../../scripts/scorecard/analyze-trace-timing.ts") as {
  buildPhaseRows: (
    current: Record<string, number>,
    previous: Record<string, number>,
  ) => Array<{ label: string }>;
  buildTraceSummaryLines: (
    current: { totalMs: number },
    previous: { totalMs: number },
    tag: { name: string },
    rows: Array<{ label: string }>,
  ) => string[];
  buildTraceTimingResult: (
    deps: { context: { runId: number }; github: unknown },
    services?: {
      findLatestCompletedE2eRunForReleaseTag: (
        deps: unknown,
        tag: { name: string; sha: string },
      ) => Promise<{ id: number } | null>;
      readTraceSummaryFromRun: (deps: unknown, runId: number) => Promise<TraceSummary | null>;
      resolvePriorReleaseTag: (deps: unknown) => Promise<{
        major: number;
        minor: number;
        name: string;
        patch: number;
        sha: string;
      } | null>;
    },
  ) => Promise<{ traceSummaryLines: string[]; traceTimingLine: string }>;
  findLatestCompletedE2eRunForReleaseTag: (
    deps: GitHubTraceDeps,
    tag: { major: number; minor: number; name: string; patch: number; sha: string },
  ) => Promise<{ id: number } | null>;
  formatTopPhaseChanges: (rows: Array<{ label: string }>) => string;
  readTraceSummaryFromRun: (deps: GitHubTraceDeps, runId: number) => Promise<TraceSummary | null>;
  resolvePriorReleaseTag: (
    deps: GitHubTraceDeps,
  ) => Promise<{ major: number; minor: number; name: string; patch: number; sha: string } | null>;
  selectOnboardTrace: (texts: string[]) => { totalMs: number } | null;
};
const scorecardJobs = require("../../../scripts/scorecard/summarize-jobs.ts") as {
  isSelectiveDispatch: (eventName: string, rawJobs?: string, rawTargets?: string) => boolean;
  loadWorkflowRunJobs: (deps: {
    context: { repo: { owner: string; repo: string }; runId: number };
    core: { warning: (message: string) => void };
    github: {
      paginate: (method: unknown, parameters: Record<string, unknown>) => Promise<unknown[]>;
      rest: { actions: { listJobsForWorkflowRun: unknown } };
    };
  }) => Promise<SummarizeJobsInput["apiJobs"]>;
  summarizeJobs: (input: SummarizeJobsInput) => JobSummary;
};
const SANITIZER = "scripts/e2e/sanitize-trace-timing.py";

type TraceSummary = {
  artifact: Record<string, unknown>;
  phases: Record<string, number>;
  totalMs: number;
};

type GitHubTraceDeps = {
  context: { ref?: string; repo: { owner: string; repo: string }; runId: number };
  github: {
    paginate: (method: unknown, parameters: Record<string, unknown>) => Promise<any[]>;
    rest: {
      actions: {
        downloadArtifact?: unknown;
        listWorkflowRunArtifacts: unknown;
        listWorkflowRuns: (...args: any[]) => Promise<any>;
      };
      repos: { listTags: unknown };
    };
  };
};

function makeRawTrace(totalMs = 1200, preflightMs = 500): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            spans: [
              { name: "nemoclaw.onboard", duration_ms: totalMs },
              {
                name: "nemoclaw.onboard.phase.preflight",
                duration_ms: preflightMs,
                attributes: { api_key: "nvapi-should-never-appear" },
                events: [{ name: "prompt", attributes: { value: "secret" } }],
              },
              {
                name: "nemoclaw.onboard.phase.nvapi-attacker-controlled",
                duration_ms: 900,
              },
            ],
          },
        ],
      },
    ],
    summary: {
      trace_id: "0123456789abcdef0123456789abcdef",
      total_duration_ms: totalMs,
      output_path: "/tmp/raw-trace.json",
      slowest_spans: [
        {
          name: "nemoclaw.onboard.phase.preflight",
          duration_ms: preflightMs,
          status: "OK",
        },
      ],
    },
  };
}

function runSanitizer(source: string, output: string) {
  return spawnSync("python3", [SANITIZER, source, output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function scorecardData(overrides: Partial<ScorecardData> = {}): ScorecardData {
  return {
    today: "Jun 29",
    runMode: "Scheduled E2E",
    actor: "",
    isSelectiveDispatch: false,
    requestedJobs: [],
    requestedTargets: [],
    total: 58,
    ran: 58,
    success: 58,
    failure: 0,
    cancelled: 0,
    skipped: 0,
    perfect: true,
    failedJobs: [],
    traceTimingLine: "Trace: cloud-onboard total 2m 1.0s",
    runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    ...overrides,
  };
}

describe("E2E scorecard", () => {
  it("classifies malformed non-empty dispatch selectors as selective", () => {
    expect(scorecardJobs.isSelectiveDispatch("schedule", "cloud-onboard")).toBe(false);
    expect(scorecardJobs.isSelectiveDispatch("workflow_dispatch", "  ", "")).toBe(false);
    expect(scorecardJobs.isSelectiveDispatch("workflow_dispatch", "bad selector!", "")).toBe(true);
    expect(scorecardJobs.isSelectiveDispatch("workflow_dispatch", "", "cloud-onboard")).toBe(true);
  });

  it("loads typed scorecard helpers through the native github-script require boundary", () => {
    const script = `
      const path = require('node:path');
      for (const file of ['analyze-trace-timing.ts', 'summarize-jobs.ts', 'build-slack-blocks.ts']) {
        const loaded = require(path.join(process.env.GITHUB_WORKSPACE, 'scripts/scorecard', file));
        if (Object.keys(loaded).length === 0) process.exit(2);
      }
    `;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GITHUB_WORKSPACE: process.cwd() },
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("routes scheduled, full, and opt-in selective summaries to distinct Slack channels", () => {
    expect(slack.getSlackChannel(scorecardData())).toBe("daily");
    expect(slack.getSlackChannel(scorecardData({ runMode: "Manual full run" }))).toBe("fullrun");
    expect(
      slack.getSlackChannel(
        scorecardData({
          runMode: "Selective dispatch",
          isSelectiveDispatch: true,
          requestedJobs: ["cloud-onboard"],
        }),
      ),
    ).toBe("preview");
  });

  it("links Slack summaries to the consolidated workflow", () => {
    const data = scorecardData();
    const actions = slack.buildBlocks(data).find((block) => block.type === "actions");
    expect(actions?.elements?.[1]?.url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/workflows/e2e.yaml",
    );
    expect(slack.buildFallbackText(data)).toContain("NemoClaw E2E Scorecard");

    const failureUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/456";
    const failureSection = slack
      .buildBlocks(
        scorecardData({
          failure: 1,
          perfect: false,
          failedJobs: [{ name: "live (openclaw-nvidia)", url: failureUrl }],
        }),
      )
      .find((block) => block.text?.text.includes("Failed jobs"));
    expect(failureSection?.text?.text).toContain(`<${failureUrl}|live (openclaw-nvidia)>`);
  });

  it("compares only allowlisted onboard timing phases", () => {
    const rows = trace.buildPhaseRows(
      {
        "nemoclaw.onboard.phase.preflight": 1_000,
        "nemoclaw.onboard.phase.gateway": 5_000,
        "nemoclaw.onboard.phase.future": 100_000,
      },
      {
        "nemoclaw.onboard.phase.preflight": 2_000,
        "nemoclaw.onboard.phase.gateway": 3_000,
        "nemoclaw.onboard.phase.future": 1,
      },
    );
    expect(rows.map((row) => row.label)).toEqual(["preflight", "gateway"]);
    expect(trace.formatTopPhaseChanges(rows)).toBe("gateway +2.0s; preflight -1.0s");
    expect(
      trace
        .buildTraceSummaryLines({ totalMs: 6_000 }, { totalMs: 5_000 }, { name: "v0.0.69" }, rows)
        .join("\n"),
    ).toContain("latest completed `e2e.yaml` run");
  });

  it("accepts only the trusted timing-summary schema", () => {
    const good = JSON.stringify({
      schema_version: "nemoclaw.trace_timing.v1",
      total_duration_ms: 1000,
      phases: { "nemoclaw.onboard.phase.preflight": 500 },
    });
    const rawTrace = JSON.stringify({
      summary: { total_duration_ms: 9999 },
      resource_spans: [{ scope_spans: [{ spans: [] }] }],
    });
    expect(trace.selectOnboardTrace([rawTrace])).toBeNull();
    expect(trace.selectOnboardTrace([good])?.totalMs).toBe(1000);
    expect(
      trace.selectOnboardTrace([
        good,
        JSON.stringify({
          schema_version: "nemoclaw.trace_timing.v1",
          total_duration_ms: 2000,
          phases: { "nemoclaw.onboard.phase.preflight": 1000 },
        }),
      ])?.totalMs,
    ).toBe(2000);
  });

  it("keeps trace comparison fallbacks explicit and non-fatal", async () => {
    const current: TraceSummary = {
      artifact: {},
      phases: { "nemoclaw.onboard.phase.preflight": 1_000 },
      totalMs: 2_000,
    };
    const prior: TraceSummary = {
      artifact: {},
      phases: { "nemoclaw.onboard.phase.preflight": 500 },
      totalMs: 1_000,
    };
    const tag = { major: 0, minor: 0, name: "v0.0.69", patch: 69, sha: "abc" };
    const deps = { context: { runId: 123 }, github: {} };
    const baseServices = {
      findLatestCompletedE2eRunForReleaseTag: vi.fn().mockResolvedValue({ id: 99 }),
      readTraceSummaryFromRun: vi.fn().mockResolvedValue(current),
      resolvePriorReleaseTag: vi.fn().mockResolvedValue(tag),
    };

    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi.fn().mockResolvedValue(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: "Trace: ⊘ e2e-cloud-onboard timing summary not found",
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        resolvePriorReleaseTag: vi.fn().mockResolvedValue(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: "Trace: cloud-onboard total 2.0s (no prior release tag found)",
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        findLatestCompletedE2eRunForReleaseTag: vi.fn().mockResolvedValue(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: "Trace: cloud-onboard total 2.0s (no e2e.yaml run found for v0.0.69)",
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: "Trace: cloud-onboard total 2.0s (no timing summary found for v0.0.69)",
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi.fn().mockRejectedValue(new Error("artifact unavailable")),
      }),
    ).resolves.toMatchObject({ traceTimingLine: "Trace: ⊘ comparison unavailable" });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(prior),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining("increased +1.0s (+100.0%) vs v0.0.69"),
      traceSummaryLines: expect.arrayContaining(["## Cloud Onboard Trace Timing"]),
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce({ ...prior, totalMs: 0 }),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining("increased +2.0s (n/a) vs v0.0.69"),
    });
  });

  it("returns null at missing release-run and trace-artifact boundaries", async () => {
    const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: [] } });
    const deps: GitHubTraceDeps = {
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
      github: {
        paginate: vi.fn().mockResolvedValue([]),
        rest: {
          actions: { listWorkflowRunArtifacts: {}, listWorkflowRuns },
          repos: { listTags: {} },
        },
      },
    };

    await expect(trace.resolvePriorReleaseTag(deps)).resolves.toBeNull();
    await expect(
      trace.findLatestCompletedE2eRunForReleaseTag(deps, {
        major: 0,
        minor: 0,
        name: "v0.0.69",
        patch: 69,
        sha: "abc",
      }),
    ).resolves.toBeNull();
    await expect(trace.readTraceSummaryFromRun(deps, 99)).resolves.toBeNull();
  });

  it("falls back to needs when the GitHub jobs API is unavailable", async () => {
    const warning = vi.fn();
    const apiJobs = await scorecardJobs.loadWorkflowRunJobs({
      context: { repo: { owner: "NVIDIA", repo: "NemoClaw" }, runId: 123 },
      core: { warning },
      github: {
        paginate: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("temporary outage"), { status: 503 })),
        rest: { actions: { listJobsForWorkflowRun: {} } },
      },
    });

    expect(apiJobs).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("status 503); falling back to needs context"),
    );
    expect(
      scorecardJobs.summarizeJobs({
        apiJobs,
        explicitOnlyJobNames: [],
        explicitlySelected: [],
        metaJobNames: ["generate-matrix"],
        needs: {
          "generate-matrix": { result: "success" },
          live: { result: "success" },
        },
      }),
    ).toMatchObject({ failure: 0, ran: 1, success: 1, total: 1 });
  });

  it("uses canonical API jobs, latest reruns, and direct failure links", () => {
    expect(
      scorecardJobs.summarizeJobs({
        apiJobs: [
          { conclusion: "success", name: "generate-matrix", status: "completed" },
          {
            completed_at: "2026-06-29T00:00:00Z",
            conclusion: "failure",
            html_url: "https://example.test/old",
            name: "live (openclaw)",
            run_attempt: 1,
            status: "completed",
          },
          {
            completed_at: "2026-06-29T01:00:00Z",
            conclusion: "success",
            html_url: "https://example.test/new",
            name: "live (openclaw)",
            run_attempt: 2,
            status: "completed",
          },
          {
            conclusion: "timed_out",
            html_url: "https://example.test/hermes",
            name: "live (hermes)",
            status: "completed",
          },
          { conclusion: "success", name: "cloud / inner", status: "completed" },
          { conclusion: "skipped", name: "jetson-nvmap-gpu", status: "completed" },
          {
            conclusion: "success",
            name: "sandbox-rlimits-connect",
            status: "completed",
          },
          { conclusion: "success", name: "report-to-pr", status: "completed" },
        ],
        explicitOnlyJobNames: ["jetson-nvmap-gpu", "sandbox-rlimits-connect"],
        explicitlySelected: ["sandbox-rlimits-connect"],
        metaJobNames: ["generate-matrix", "report-to-pr", "scorecard"],
        needs: {},
      }),
    ).toEqual({
      cancelled: 0,
      failedJobs: [{ name: "live (hermes)", url: "https://example.test/hermes" }],
      failure: 1,
      ran: 4,
      skipped: 0,
      success: 3,
      total: 4,
    });
  });

  it("falls back to needs without counting unselected explicit-only jobs", () => {
    expect(
      scorecardJobs.summarizeJobs({
        apiJobs: null,
        explicitOnlyJobNames: ["jetson-nvmap-gpu", "sandbox-rlimits-connect"],
        explicitlySelected: ["jetson-nvmap-gpu"],
        metaJobNames: ["generate-matrix", "report-to-pr", "scorecard"],
        needs: {
          "generate-matrix": { result: "success" },
          cloud: { result: "success" },
          malformed: { result: "timed_out" },
          "jetson-nvmap-gpu": { result: "skipped" },
          "sandbox-rlimits-connect": { result: "skipped" },
          "report-to-pr": { result: "success" },
        },
      }),
    ).toEqual({
      cancelled: 0,
      failedJobs: [{ name: "malformed", url: null }],
      failure: 1,
      ran: 2,
      skipped: 1,
      success: 1,
      total: 3,
    });
  });

  it("sanitizes raw traces into a timing-only artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-sanitize-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    const rawPath = join(source, "trace.json");
    try {
      mkdirSync(source);
      mkdirSync(output);
      writeFileSync(join(output, "existing-artifact.log"), "preserve me\n");
      writeFileSync(rawPath, JSON.stringify(makeRawTrace()));
      writeFileSync(join(source, "environment.txt"), "NVIDIA_API_KEY=nvapi-secret\n");
      writeFileSync(
        join(source, "malicious.json"),
        JSON.stringify({ summary: { total_duration_ms: 9999 }, token: "ghp_secret" }),
      );
      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      const summaryPath = join(output, "cloud-onboard-trace-timing-summary.json");
      const summary = readFileSync(summaryPath, "utf8");
      expect(readFileSync(join(output, "existing-artifact.log"), "utf8")).toBe("preserve me\n");
      expect(JSON.parse(summary)).toEqual({
        phases: { "nemoclaw.onboard.phase.preflight": 500 },
        schema_version: "nemoclaw.trace_timing.v1",
        slowest_spans: [
          { duration_ms: 500, name: "nemoclaw.onboard.phase.preflight", status: "OK" },
        ],
        total_duration_ms: 1200,
        trace_id: "0123456789abcdef0123456789abcdef",
      });
      expect(summary).not.toMatch(/api_key|nvapi|ghp_|attributes|events|output_path|raw-trace/u);
      expect(lstatSync(summaryPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("emits no timing summary for malformed or non-onboard traces", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-invalid-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    try {
      mkdirSync(source);
      writeFileSync(join(source, "malformed.json"), "{not-json");
      writeFileSync(
        join(source, "not-onboard.json"),
        JSON.stringify({ resource_spans: [], summary: { total_duration_ms: 1 } }),
      );
      writeFileSync(
        join(source, "missing-total.json"),
        JSON.stringify({
          ...makeRawTrace(),
          summary: { trace_id: "0123456789abcdef0123456789abcdef" },
        }),
      );
      writeFileSync(
        join(source, "missing-phase.json"),
        JSON.stringify({
          resource_spans: [
            { scope_spans: [{ spans: [{ name: "nemoclaw.onboard", duration_ms: 1 }] }] },
          ],
          summary: { total_duration_ms: 1 },
        }),
      );
      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps only allowlisted candidate fields from onboard trace summaries", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-candidate-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    try {
      mkdirSync(source);
      writeFileSync(
        join(source, "trace.json"),
        JSON.stringify({
          ...makeRawTrace(1234.5678, 321.9876),
          summary: {
            trace_id: "not-a-trace-id",
            total_duration_ms: 1234.5678,
            slowest_spans: [
              {
                name: "nemoclaw.onboard.phase.preflight",
                duration_ms: 321.9876,
                status: "NOT_A_STATUS",
                attributes: { secret: "nvapi-secret" },
              },
              {
                name: "nemoclaw.onboard.phase.inference",
                duration_ms: 200,
                status: "ERROR",
              },
              {
                name: "nemoclaw.onboard.phase.attacker-controlled",
                duration_ms: 999,
                status: "ERROR",
              },
            ],
          },
        }),
      );

      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(output, "cloud-onboard-trace-timing-summary.json"), "utf8")),
      ).toEqual({
        phases: { "nemoclaw.onboard.phase.preflight": 321.988 },
        schema_version: "nemoclaw.trace_timing.v1",
        slowest_spans: [
          {
            duration_ms: 321.988,
            name: "nemoclaw.onboard.phase.preflight",
            status: "UNSET",
          },
          {
            duration_ms: 200,
            name: "nemoclaw.onboard.phase.inference",
            status: "ERROR",
          },
        ],
        total_duration_ms: 1234.568,
        trace_id: null,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("directly extracts only timing fields from the source TraceArtifact shape", () => {
    const script = String.raw`
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sanitize_trace_timing",
    Path("scripts/e2e/sanitize-trace-timing.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
artifact = {
    "resource_spans": [{
        "resource": {"attributes": {"service.name": "nemoclaw"}},
        "scope_spans": [{
            "scope": {"name": "nemoclaw.onboard", "version": "1.0.0"},
            "spans": [
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000001",
                    "name": "nemoclaw.onboard",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "1",
                    "duration_ms": 42,
                    "status": {"code": "OK", "message": "secret detail"},
                    "attributes": {"api_key": "nvapi-secret"},
                    "events": [{"name": "prompt", "attributes": {"value": "secret"}}],
                },
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000002",
                    "parent_span_id": "0000000000000001",
                    "name": "nemoclaw.onboard.phase.gateway",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "2",
                    "duration_ms": 7.1234,
                    "status": {"code": "ERROR", "message": "raw error"},
                    "attributes": {"endpoint": "https://example.test/token"},
                    "events": [],
                },
            ],
        }],
    }],
    "summary": {
        "trace_id": "0123456789abcdef0123456789abcdef",
        "generated_at": "2026-07-02T00:00:00.000Z",
        "total_duration_ms": 42.9876,
        "slowest_spans": [{
            "name": "nemoclaw.onboard.phase.gateway",
            "duration_ms": 7.1234,
            "status": "ERROR",
        }],
        "output_path": "/tmp/raw-trace.json",
    },
}
print(json.dumps(module.extract_candidate(artifact), sort_keys=True))
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      phases: { "nemoclaw.onboard.phase.gateway": 7.123 },
      schema_version: "nemoclaw.trace_timing.v1",
      slowest_spans: [
        { duration_ms: 7.123, name: "nemoclaw.onboard.phase.gateway", status: "ERROR" },
      ],
      total_duration_ms: 42.988,
      trace_id: "0123456789abcdef0123456789abcdef",
    });
    expect(result.stdout).not.toMatch(/api_key|attributes|events|output_path|raw error|secret/u);
  });

  it("bounds trace input count and file size before parsing", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-bounds-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    try {
      mkdirSync(source);
      writeFileSync(join(source, "000-valid.json"), JSON.stringify(makeRawTrace(1_200)));
      for (let index = 1; index < 100; index += 1) {
        writeFileSync(join(source, `${String(index).padStart(3, "0")}-invalid.json`), "{}");
      }
      writeFileSync(join(source, "100-ignored.json"), JSON.stringify(makeRawTrace(9_999)));
      writeFileSync(join(source, "101-oversized.json"), " ".repeat(2 * 1024 * 1024 + 1));

      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(output, "cloud-onboard-trace-timing-summary.json"), "utf8")),
      ).toMatchObject({ total_duration_ms: 1_200 });

      rmSync(output, { force: true, recursive: true });
      rmSync(join(source, "000-valid.json"));
      for (let index = 1; index < 100; index += 1) {
        rmSync(join(source, `${String(index).padStart(3, "0")}-invalid.json`));
      }
      rmSync(join(source, "100-ignored.json"));
      const oversizedOnly = runSanitizer(source, output);
      expect(oversizedOnly.status, oversizedOnly.stderr).toBe(0);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects symlinked trace sources and trusted output paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-symlink-"));
    const source = join(directory, "raw");
    const sourceLink = join(directory, "raw-link");
    const outputTarget = join(directory, "target-controlled");
    const outputLink = join(directory, "trusted-link");
    try {
      mkdirSync(source);
      mkdirSync(outputTarget);
      writeFileSync(join(source, "trace.json"), JSON.stringify(makeRawTrace()));
      writeFileSync(join(outputTarget, "secret.txt"), "do not overwrite\n");
      symlinkSync(source, sourceLink, "dir");
      symlinkSync(outputTarget, outputLink, "dir");

      const sourceResult = runSanitizer(sourceLink, join(directory, "trusted"));
      expect(sourceResult.status).toBe(2);
      expect(sourceResult.stderr).toContain("trace source must not be a symlink");

      const outputResult = runSanitizer(source, outputLink);
      expect(outputResult.status).toBe(2);
      expect(outputResult.stderr).toContain("trusted output must be a real directory");
      expect(readFileSync(join(outputTarget, "secret.txt"), "utf8")).toBe("do not overwrite\n");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses to follow a pre-created timing-summary symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-file-symlink-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    const target = join(directory, "target-controlled.txt");
    try {
      mkdirSync(source);
      mkdirSync(output);
      writeFileSync(join(source, "trace.json"), JSON.stringify(makeRawTrace()));
      writeFileSync(target, "do not overwrite\n");
      symlinkSync(target, join(output, "cloud-onboard-trace-timing-summary.json"));

      const result = runSanitizer(source, output);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("trusted timing summary must not be a symlink");
      expect(readFileSync(target, "utf8")).toBe("do not overwrite\n");
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
