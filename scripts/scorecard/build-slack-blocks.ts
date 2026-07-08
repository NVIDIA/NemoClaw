// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure Slack payload builder for the consolidated E2E scorecard. */

type ScorecardRunMode = "Scheduled E2E" | "Manual full run" | "Selective dispatch" | (string & {});

type ScorecardData = {
  today: string;
  runMode: ScorecardRunMode;
  actor?: string;
  isSelectiveDispatch: boolean;
  requestedJobs: string[];
  requestedTargets: string[];
  total: number;
  ran: number;
  success: number;
  failure: number;
  cancelled: number;
  skipped: number;
  perfect: boolean;
  failedJobs: { name: string; url: string | null }[];
  traceTimingLine?: string;
  runUrl: string;
};

type SlackMrkdwnText = { type: "mrkdwn"; text: string };
type SlackPlainText = { type: "plain_text"; text: string; emoji?: boolean };
type SlackContextBlock = { type: "context"; elements: SlackMrkdwnText[] };
type SlackSectionBlock = { type: "section"; text: SlackMrkdwnText };
type SlackButtonElement = {
  type: "button";
  text: SlackPlainText;
  url: string;
  style?: "primary" | "danger";
};
type SlackActionsBlock = { type: "actions"; elements: SlackButtonElement[] };
type SlackBlock = SlackActionsBlock | SlackContextBlock | SlackSectionBlock;

function buildBlocks(data: ScorecardData): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const showActor = data.runMode !== "Scheduled E2E" && Boolean(data.actor);
  const runModeText = showActor ? `${data.runMode} (by *${data.actor}*)` : data.runMode;
  const contextElements: SlackMrkdwnText[] = [
    { type: "mrkdwn", text: `*Run mode:* ${runModeText}` },
  ];
  if (data.isSelectiveDispatch) {
    const selectors = [
      ...data.requestedJobs.map((name) => `job:\`${name}\``),
      ...data.requestedTargets.map((name) => `target:\`${name}\``),
    ];
    if (selectors.length > 0) {
      contextElements.push({ type: "mrkdwn", text: `*Requested:* ${selectors.join(", ")}` });
    }
  }
  blocks.push({ type: "context", elements: contextElements });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*Total ran:* ${data.ran}/${data.total}`,
        `:white_check_mark: *Passed:* ${data.success}`,
        `:x: *Failed:* ${data.failure}`,
        `:no_entry_sign: *Cancelled:* ${data.cancelled}`,
        `:fast_forward: *Skipped:* ${data.skipped}`,
      ].join("  ·  "),
    },
  });

  if (data.perfect) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":tada: *All jobs passed!*" },
    });
  } else if (data.failedJobs.length > 0) {
    const list = data.failedJobs
      .map((job) => (job.url ? `• <${job.url}|${job.name}>` : `• \`${job.name}\``))
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Failed jobs (${data.failedJobs.length}):*\n${list}`,
      },
    });
  }

  if (data.traceTimingLine) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: data.traceTimingLine.replace(/^Trace:\s*/, "*Trace:* "),
      },
    });
  }

  const workflowUrl = data.runUrl.replace(/\/runs\/\d+$/, "/workflows/e2e.yaml");
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View this run", emoji: true },
        url: data.runUrl,
        style: data.perfect ? "primary" : "danger",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "All E2E runs", emoji: true },
        url: workflowUrl,
      },
    ],
  });
  return blocks;
}

function buildFallbackText(data: ScorecardData): string {
  let modeSegment: string;
  switch (data.runMode) {
    case "Scheduled E2E":
      modeSegment = "🗓️ DAILY";
      break;
    case "Manual full run":
      modeSegment = data.actor ? `🛠 Manual full by ${data.actor}` : "🛠 Manual full";
      break;
    case "Selective dispatch":
      modeSegment = data.actor ? `🛠 Selective by ${data.actor}` : "🛠 Selective";
      break;
    default:
      modeSegment = data.runMode;
  }
  return `🌅 *NemoClaw E2E Scorecard · ${modeSegment} · ${data.today}*`;
}

type SlackStatusColor = "danger" | "good" | "warning";

function getStatusColor(data: ScorecardData): SlackStatusColor {
  if (data.failure > 0) return "danger";
  if (data.perfect) return "good";
  return "warning";
}

type SlackChannel = "daily" | "fullrun" | "preview";

function getSlackChannel(data: ScorecardData): SlackChannel {
  if (data.runMode === "Scheduled E2E") return "daily";
  if (data.runMode === "Manual full run") return "fullrun";
  return "preview";
}

module.exports = {
  buildBlocks,
  buildFallbackText,
  getSlackChannel,
  getStatusColor,
};

export type { ScorecardData, SlackBlock, SlackChannel, SlackStatusColor };
