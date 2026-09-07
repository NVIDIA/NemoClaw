// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import type { ScorecardData } from "../../../scripts/scorecard/build-slack-blocks.mts";
import type { JobSummary, SummarizeJobsInput } from "../../../scripts/scorecard/summarize-jobs.mts";

const require = createRequire(import.meta.url);
const slack = require("../../../scripts/scorecard/build-slack-blocks.mts") as {
  buildBlocks: (data: ScorecardData) => Array<{
    elements?: Array<{ text?: { text?: string }; url?: string }>;
    text?: { text: string };
    type: string;
  }>;
  buildFallbackText: (data: ScorecardData) => string;
  getSlackChannel: (data: ScorecardData) => string;
};
const trace = require("../../../scripts/scorecard/analyze-trace-timing.mts") as {
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
const scorecardJobs = require("../../../scripts/scorecard/summarize-jobs.mts") as {
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

function scorecardData(overrides: Partial<ScorecardData> = {}): ScorecardData {
  return {
    today: "Jun 29",
    runMode: "Main push",
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
      for (const file of [
        'analyze-runtime-history.mts',
        'analyze-trace-timing.mts',
        'summarize-jobs.mts',
        'build-slack-blocks.mts',
        'coordinate-scorecard.mts',
      ]) {
        const loaded = require(path.join(process.env.GITHUB_WORKSPACE, 'scripts/scorecard', file));
        if (Object.keys(loaded).length === 0) process.exit(2);
      }
      const runtimeAudit = require(path.join(process.env.GITHUB_WORKSPACE, 'scripts/audit-test-runtime.mts'));
      if (Object.keys(runtimeAudit).length === 0) process.exit(2);
      const artifactZip = require(path.join(process.env.GITHUB_WORKSPACE, 'scripts/lib/read-artifact-zip.mts'));
      if (Object.keys(artifactZip).length === 0) process.exit(2);
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

  it("keeps every failed-job section within Slack's 3000-character limit", () => {
    const failedJobs = Array.from({ length: 61 }, (_, index) => ({
      name: `failure-${index}-${"x".repeat(80)}`,
      url: `https://github.com/NVIDIA/NemoClaw/actions/runs/31962084507/job/${95201570000 + index}`,
    }));
    const failedJobSections = slack
      .buildBlocks(scorecardData({ failure: failedJobs.length, perfect: false, failedJobs }))
      .filter(
        (block): block is typeof block & { type: "section"; text: { text: string } } =>
          block.type === "section" && block.text?.text.includes("Failed jobs") === true,
      );

    expect(failedJobSections.length).toBeGreaterThan(1);
    expect(failedJobSections.every((block) => block.text.text.length <= 3_000)).toBe(true);
    const rendered = failedJobSections.map((block) => block.text.text).join("\n");
    expect(failedJobs.every((job) => rendered.includes(`<${job.url}|${job.name}>`))).toBe(true);
  });

  it("bounds one oversized failed-job label without dropping its job link", () => {
    const url = "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/456";
    const failedJobSections = slack
      .buildBlocks(
        scorecardData({
          failure: 1,
          perfect: false,
          failedJobs: [{ name: `failure-${"x".repeat(4_000)}`, url }],
        }),
      )
      .filter(
        (block): block is typeof block & { type: "section"; text: { text: string } } =>
          block.type === "section" && block.text?.text.includes("Failed jobs") === true,
      );

    expect(failedJobSections).toHaveLength(1);
    expect(failedJobSections[0]?.text.text.length).toBeLessThanOrEqual(3_000);
    expect(failedJobSections[0]?.text.text).toContain(`<${url}|failure-`);
    expect(failedJobSections[0]?.text.text).toContain("…>");
  });

  it("replaces an oversized job URL with the valid run link", () => {
    const runUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
    const oversizedUrl = `https://example.test/${"x".repeat(4_000)}`;
    const failedJobSection = slack
      .buildBlocks(
        scorecardData({
          failure: 1,
          perfect: false,
          failedJobs: [{ name: "failure", url: oversizedUrl }],
          runUrl,
        }),
      )
      .find((block) => block.type === "section" && block.text?.text.includes("Failed jobs"));

    expect(failedJobSection?.text?.text.length).toBeLessThanOrEqual(3_000);
    expect(failedJobSection?.text?.text).toContain(`<${runUrl}|failure>`);
    expect(failedJobSection?.text?.text).not.toContain(oversizedUrl);
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
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 2.0s (no prior release tag found)",
      ),
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        findLatestCompletedE2eRunForReleaseTag: vi.fn().mockResolvedValue(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 2.0s (no e2e.yaml run found for v0.0.69)",
      ),
    });
    await expect(
      trace.buildTraceTimingResult(deps, {
        ...baseServices,
        readTraceSummaryFromRun: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(null),
      }),
    ).resolves.toMatchObject({
      traceTimingLine: expect.stringContaining(
        "Trace: cloud-onboard total 2.0s (no timing summary found for v0.0.69)",
      ),
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
            name: "mcp-bridge-dev",
            status: "completed",
          },
          { conclusion: "success", name: "report-to-pr", status: "completed" },
        ],
        explicitOnlyJobNames: ["jetson-nvmap-gpu", "mcp-bridge-dev"],
        explicitlySelected: ["mcp-bridge-dev"],
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
      timingRows: [],
      total: 4,
    });
  });

  it("keeps every matrix execution eligible for the timing ranking", () => {
    const summary = scorecardJobs.summarizeJobs({
      apiJobs: [
        {
          completed_at: "2026-07-24T00:00:20Z",
          conclusion: "success",
          created_at: "2026-07-24T00:00:00Z",
          labels: ["ubuntu-latest"],
          name: "matrix / fast",
          started_at: "2026-07-24T00:00:05Z",
          status: "completed",
        },
        {
          completed_at: "2026-07-24T00:02:00Z",
          conclusion: "success",
          created_at: "2026-07-24T00:00:00Z",
          labels: ["ubuntu-latest"],
          name: "matrix / slow",
          started_at: "2026-07-24T00:00:10Z",
          status: "completed",
        },
      ],
      explicitOnlyJobNames: [],
      explicitlySelected: [],
      metaJobNames: [],
      needs: {},
    });

    expect(summary).toMatchObject({ success: 1, total: 1 });
    expect(summary.timingRows.map(({ name }) => name)).toEqual(["matrix / slow", "matrix / fast"]);
  });

  it("falls back to needs without counting jobs omitted from the run", () => {
    expect(
      scorecardJobs.summarizeJobs({
        apiJobs: null,
        explicitOnlyJobNames: ["jetson-nvmap-gpu", "mcp-bridge-dev"],
        explicitlySelected: ["jetson-nvmap-gpu"],
        metaJobNames: ["generate-matrix", "report-to-pr", "scorecard"],
        needs: {
          "generate-matrix": { result: "success" },
          cloud: { result: "success" },
          malformed: { result: "timed_out" },
          "jetson-nvmap-gpu": { result: "skipped" },
          "mcp-bridge-dev": { result: "skipped" },
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
      timingRows: [],
      total: 3,
    });
  });

});
