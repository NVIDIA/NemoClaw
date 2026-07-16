// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ScorecardData,
  SlackBlock,
  SlackChannel,
  SlackStatusColor,
} from "./build-slack-blocks.mts";
import {
  buildBlocks,
  buildFallbackText,
  getSlackChannel,
  getStatusColor,
} from "./build-slack-blocks.mts";
import type { JobSummary, SummarizeJobsInput } from "./summarize-jobs.mts";
import { isSelectiveDispatch, summarizeJobs } from "./summarize-jobs.mts";

const SELECTOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
const META_JOB_NAMES = ["generate-matrix", "report-to-pr", "scorecard"];
const SLACK_CHANNELS: readonly SlackChannel[] = ["daily", "fullrun", "preview"];

type RunMode = ScorecardData["runMode"];

type TraceTimingResult = { traceTimingLine: string; traceSummaryLines: string[] };

type SlackPayload = {
  text: string;
  attachments: { color: SlackStatusColor; blocks: SlackBlock[] }[];
};

export type SlackData = { channel: SlackChannel; payload: SlackPayload };

export type ScorecardInput = {
  eventName: string;
  actor: string;
  serverUrl: string;
  repo: { owner: string; repo: string };
  runId: number;
  rawJobs: string;
  rawTargets: string;
  rawExplicitOnly: string;
  needs: SummarizeJobsInput["needs"];
  apiJobs: SummarizeJobsInput["apiJobs"];
  trace: TraceTimingResult;
  today: string;
};

export type ScorecardResult = {
  summaryMarkdown: string;
  scorecardData: ScorecardData;
  slackData: SlackData;
};

function parseSelectors(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => SELECTOR_PATTERN.test(name));
}

function deriveRunMode(
  eventName: string,
  rawJobs: string,
  rawTargets: string,
): { runMode: RunMode; isDispatch: boolean; isSelectiveDispatch: boolean } {
  const isDispatch = eventName === "workflow_dispatch";
  const selective = isSelectiveDispatch(eventName, rawJobs, rawTargets);
  const runMode: RunMode = selective
    ? "Selective dispatch"
    : isDispatch
      ? "Manual full run"
      : "Scheduled E2E";
  return { runMode, isDispatch, isSelectiveDispatch: selective };
}

function renderSummaryLines(input: {
  today: string;
  runMode: RunMode;
  requestedJobs: string[];
  requestedTargets: string[];
  summary: JobSummary;
  perfect: boolean;
  trace: TraceTimingResult;
  runUrl: string;
}): string[] {
  const { summary } = input;
  const lines = [
    `## 🌅 NemoClaw E2E Scorecard — ${input.today}`,
    "",
    `**Run mode:** ${input.runMode}`,
  ];
  if (input.requestedJobs.length > 0) {
    lines.push(
      `**Requested jobs:** ${input.requestedJobs.map((name) => `\`${name}\``).join(", ")}`,
    );
  }
  if (input.requestedTargets.length > 0) {
    lines.push(
      `**Requested targets:** ${input.requestedTargets.map((name) => `\`${name}\``).join(", ")}`,
    );
  }
  lines.push(
    `**Jobs run:** ${summary.ran} of ${summary.total}`,
    `  ✅ ${summary.success} passed`,
    `  ❌ ${summary.failure} failed`,
    `  🚫 ${summary.cancelled} cancelled`,
    `  ⏭️ ${summary.skipped} skipped`,
  );
  if (summary.failedJobs.length > 0) {
    lines.push("", "**Failed jobs:**");
    for (const job of summary.failedJobs) {
      lines.push(job.url ? `  - [${job.name}](${job.url})` : `  - \`${job.name}\``);
    }
  }
  if (input.perfect) lines.push("", "🎉 **All jobs passed!**");
  lines.push(
    "",
    input.trace.traceTimingLine,
    ...input.trace.traceSummaryLines,
    "",
    `🔗 [Full run details](${input.runUrl})`,
  );
  return lines;
}

function buildSlackData(scorecardData: ScorecardData): SlackData {
  return {
    channel: getSlackChannel(scorecardData),
    payload: {
      text: buildFallbackText(scorecardData),
      attachments: [{ color: getStatusColor(scorecardData), blocks: buildBlocks(scorecardData) }],
    },
  };
}

function validateSlackData(data: unknown): data is SlackData {
  if (data === null || typeof data !== "object") return false;
  const candidate = data as { channel?: unknown; payload?: unknown };
  if (typeof candidate.channel !== "string") return false;
  if (!SLACK_CHANNELS.includes(candidate.channel as SlackChannel)) return false;
  if (candidate.payload === null || typeof candidate.payload !== "object") return false;
  const payload = candidate.payload as { text?: unknown; attachments?: unknown };
  if (typeof payload.text !== "string" || !Array.isArray(payload.attachments)) return false;
  return payload.attachments.every((attachment) => {
    if (attachment === null || typeof attachment !== "object") return false;
    const value = attachment as { color?: unknown; blocks?: unknown };
    return typeof value.color === "string" && Array.isArray(value.blocks);
  });
}

function buildScorecard(input: ScorecardInput): ScorecardResult {
  const requestedJobs = parseSelectors(input.rawJobs);
  const requestedTargets = parseSelectors(input.rawTargets);
  const explicitOnly = parseSelectors(input.rawExplicitOnly);
  const { runMode, isSelectiveDispatch: selective } = deriveRunMode(
    input.eventName,
    input.rawJobs,
    input.rawTargets,
  );
  const summary = summarizeJobs({
    apiJobs: input.apiJobs,
    explicitOnlyJobNames: explicitOnly,
    explicitlySelected: [...requestedJobs, ...requestedTargets],
    metaJobNames: META_JOB_NAMES,
    needs: input.needs,
  });
  const perfect = summary.ran > 0 && summary.failure === 0 && summary.cancelled === 0;
  const runUrl = `${input.serverUrl}/${input.repo.owner}/${input.repo.repo}/actions/runs/${input.runId}`;
  const scorecardData: ScorecardData = {
    today: input.today,
    runMode,
    actor: input.actor,
    isSelectiveDispatch: selective,
    requestedJobs,
    requestedTargets,
    total: summary.total,
    ran: summary.ran,
    success: summary.success,
    failure: summary.failure,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    perfect,
    failedJobs: summary.failedJobs,
    traceTimingLine: input.trace.traceTimingLine,
    runUrl,
  };
  const summaryMarkdown = renderSummaryLines({
    today: input.today,
    runMode,
    requestedJobs,
    requestedTargets,
    summary,
    perfect,
    trace: input.trace,
    runUrl,
  }).join("\n");
  return { summaryMarkdown, scorecardData, slackData: buildSlackData(scorecardData) };
}

export { buildScorecard, deriveRunMode, parseSelectors, validateSlackData };
