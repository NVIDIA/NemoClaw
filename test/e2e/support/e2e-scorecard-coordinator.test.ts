// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import type {
  ScorecardInput,
  ScorecardResult,
} from "../../../scripts/scorecard/coordinate-scorecard.mts";

const require = createRequire(import.meta.url);
const coordinator = require("../../../scripts/scorecard/coordinate-scorecard.mts") as {
  buildScorecard: (input: ScorecardInput) => ScorecardResult;
  deriveRunMode: (
    eventName: string,
    rawJobs: string,
    rawTargets: string,
  ) => { runMode: string; isDispatch: boolean; isSelectiveDispatch: boolean };
  parseSelectors: (value: string) => string[];
  validateSlackData: (data: unknown) => boolean;
};

function coordinatorInput(overrides: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    eventName: "schedule",
    actor: "",
    serverUrl: "https://github.com",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    runId: 123,
    rawJobs: "",
    rawTargets: "",
    rawExplicitOnly: "",
    needs: {},
    apiJobs: null,
    trace: { traceTimingLine: "Trace: none", traceSummaryLines: [] },
    today: "Jul 16",
    ...overrides,
  };
}

describe("scorecard coordinator selectors and run mode", () => {
  it("keeps only safe comma-separated selectors and drops the rest", () => {
    expect(coordinator.parseSelectors("cloud-onboard, bad selector!, live_1 ,")).toEqual([
      "cloud-onboard",
      "live_1",
    ]);
    expect(coordinator.parseSelectors("")).toEqual([]);
    expect(coordinator.parseSelectors("   ")).toEqual([]);
  });

  it("maps event and selectors to the scheduled, full, and selective run modes", () => {
    expect(coordinator.deriveRunMode("schedule", "", "")).toEqual({
      runMode: "Scheduled E2E",
      isDispatch: false,
      isSelectiveDispatch: false,
    });
    expect(coordinator.deriveRunMode("workflow_dispatch", "", "")).toEqual({
      runMode: "Manual full run",
      isDispatch: true,
      isSelectiveDispatch: false,
    });
    expect(coordinator.deriveRunMode("workflow_dispatch", "cloud-onboard", "")).toEqual({
      runMode: "Selective dispatch",
      isDispatch: true,
      isSelectiveDispatch: true,
    });
    expect(coordinator.deriveRunMode("workflow_dispatch", "", "hermes-slack").runMode).toBe(
      "Selective dispatch",
    );
  });
});

describe("scorecard coordinator assembly", () => {
  it("routes a clean scheduled run to the daily channel with a perfect summary", () => {
    const { scorecardData, slackData, summaryMarkdown } = coordinator.buildScorecard(
      coordinatorInput({
        needs: { "cloud-onboard": { result: "success" }, "report-to-pr": { result: "success" } },
        trace: {
          traceTimingLine: "Trace: cloud-onboard total 2.0s",
          traceSummaryLines: ["- phase"],
        },
      }),
    );

    expect(scorecardData.runMode).toBe("Scheduled E2E");
    expect(scorecardData).toMatchObject({
      ran: 1,
      total: 1,
      success: 1,
      failure: 0,
      perfect: true,
    });
    expect(slackData.channel).toBe("daily");
    expect(slackData.payload.attachments[0].color).toBe("good");
    expect(summaryMarkdown).toContain("## 🌅 NemoClaw E2E Scorecard — Jul 16");
    expect(summaryMarkdown).toContain("**Run mode:** Scheduled E2E");
    expect(summaryMarkdown).toContain("🎉 **All jobs passed!**");
    expect(summaryMarkdown).toContain("Trace: cloud-onboard total 2.0s");
    expect(summaryMarkdown).toContain(
      "🔗 [Full run details](https://github.com/NVIDIA/NemoClaw/actions/runs/123)",
    );
  });

  it("routes an opt-in selective dispatch to preview and renders requested selectors", () => {
    const { scorecardData, slackData, summaryMarkdown } = coordinator.buildScorecard(
      coordinatorInput({
        eventName: "workflow_dispatch",
        actor: "octocat",
        rawJobs: "cloud-onboard",
        apiJobs: [
          {
            name: "cloud-onboard",
            conclusion: "success",
            status: "completed",
            html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/1",
          },
          {
            name: "live (openclaw-nvidia)",
            conclusion: "failure",
            status: "completed",
            html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/2",
          },
        ],
      }),
    );

    expect(scorecardData.runMode).toBe("Selective dispatch");
    expect(scorecardData.isSelectiveDispatch).toBe(true);
    expect(scorecardData).toMatchObject({
      ran: 2,
      total: 2,
      success: 1,
      failure: 1,
      perfect: false,
    });
    expect(slackData.channel).toBe("preview");
    expect(slackData.payload.attachments[0].color).toBe("danger");
    expect(summaryMarkdown).toContain("**Requested jobs:** `cloud-onboard`");
    expect(summaryMarkdown).toContain(
      "  - [live (openclaw-nvidia)](https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/2)",
    );
  });

  it("routes a manual full run to the fullrun channel", () => {
    const { slackData } = coordinator.buildScorecard(
      coordinatorInput({ eventName: "workflow_dispatch", actor: "octocat" }),
    );
    expect(slackData.channel).toBe("fullrun");
  });

  it("falls back to needs results when the jobs API is unavailable", () => {
    const { scorecardData } = coordinator.buildScorecard(
      coordinatorInput({
        needs: {
          "cloud-onboard": { result: "success" },
          "hermes-slack": { result: "failure" },
          "generate-matrix": { result: "success" },
        },
      }),
    );
    expect(scorecardData).toMatchObject({ total: 2, success: 1, failure: 1, perfect: false });
    expect(scorecardData.failedJobs).toEqual([{ name: "hermes-slack", url: null }]);
  });

  it("separates runner queue time from execution time without exposing runner labels", () => {
    const { summaryMarkdown } = coordinator.buildScorecard(
      coordinatorInput({
        apiJobs: [
          {
            completed_at: "2026-07-24T00:01:30Z",
            conclusion: "failure",
            created_at: "2026-07-24T00:00:00Z",
            labels: ["private-larger-runner-label"],
            name: "mcp-bridge",
            started_at: "2026-07-24T00:00:30Z",
            status: "completed",
          },
          {
            completed_at: "2026-07-24T00:00:25Z",
            conclusion: "success",
            created_at: "2026-07-24T00:00:00Z",
            labels: ["ubuntu-latest"],
            name: "cloud-onboard",
            started_at: "2026-07-24T00:00:05Z",
            status: "completed",
          },
          {
            completed_at: "2026-07-24T00:00:20Z",
            conclusion: "success",
            created_at: "invalid",
            labels: ["self-hosted", "ubuntu-latest", "Linux"],
            name: "jetson-nvmap-gpu",
            started_at: "2026-07-24T00:00:10Z",
            status: "completed",
          },
        ],
        rawExplicitOnly: "jetson-nvmap-gpu",
        rawJobs: "jetson-nvmap-gpu",
      }),
    );

    expect(summaryMarkdown).toContain("### Runner wait vs execution");
    expect(summaryMarkdown).toContain("| mcp-bridge | larger | failure | 30.0s | 60.0s |");
    expect(summaryMarkdown).toContain("| cloud-onboard | standard | success | 5.0s | 20.0s |");
    expect(summaryMarkdown).toContain("| jetson-nvmap-gpu | unknown | success | n/a | 10.0s |");
    expect(summaryMarkdown).not.toContain("private-larger-runner-label");
  });

  it("bounds the job timing table by combined queue and execution time", () => {
    const { summaryMarkdown } = coordinator.buildScorecard(
      coordinatorInput({
        apiJobs: Array.from({ length: 12 }, (_, index) => ({
          completed_at: new Date(
            Date.UTC(2026, 6, 24, 0, 0, index === 0 ? 21 : index + 1),
          ).toISOString(),
          conclusion: "success",
          created_at: "2026-07-24T00:00:00.000Z",
          labels: ["ubuntu-latest"],
          name: `job-${String(index + 1).padStart(2, "0")}`,
          started_at: index === 0 ? "2026-07-24T00:00:20.000Z" : "2026-07-24T00:00:00.000Z",
          status: "completed",
        })),
      }),
    );

    expect(summaryMarkdown).toContain("| job-01 | standard | success | 20.0s | 1.0s |");
    expect(summaryMarkdown).toContain("| job-12 | standard | success | 0.0s | 12.0s |");
    expect(summaryMarkdown).toContain("| job-04 | standard | success | 0.0s | 4.0s |");
    expect(summaryMarkdown).not.toContain("| job-03 |");
    expect(summaryMarkdown).not.toContain("| job-02 |");
  });
});

describe("scorecard coordinator Slack payload guard", () => {
  it("accepts a precomputed allowlisted channel and payload", () => {
    const { slackData } = coordinator.buildScorecard(coordinatorInput());
    expect(coordinator.validateSlackData(slackData)).toBe(true);
  });

  it("rejects an out-of-allowlist channel or malformed payload", () => {
    expect(coordinator.validateSlackData({ channel: "arbitrary", payload: {} })).toBe(false);
    expect(coordinator.validateSlackData({ channel: "daily" })).toBe(false);
    expect(coordinator.validateSlackData({ channel: "daily", payload: "text" })).toBe(false);
    expect(coordinator.validateSlackData(null)).toBe(false);
  });
});
