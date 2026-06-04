// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builder for the nightly scorecard Slack payload. Consumed by the
 * `Post scorecard to Slack` step in `.github/workflows/nightly-e2e.yaml`
 * and exercised by `test/scorecard-blocks.test.ts`.
 */

type ScorecardRunMode =
  | "Scheduled full nightly"
  | "Manual full run"
  | "Selective dispatch"
  | (string & {});

type ScorecardData = {
  /** Display date, e.g. "May 25". */
  today: string;
  runMode: ScorecardRunMode;
  /** GitHub actor (username) who triggered the run. Empty/undefined for schedule. */
  actor?: string;
  isSelectiveDispatch: boolean;
  /** Populated only when isSelectiveDispatch is true. */
  requestedJobs: string[];
  /** Total jobs considered (excludes meta jobs). */
  total: number;
  /** total - skipped. */
  ran: number;
  success: number;
  failure: number;
  cancelled: number;
  skipped: number;
  /** ran > 0 && failure === 0 && cancelled === 0. */
  perfect: boolean;
  /** Sorted failed jobs with optional html_url. */
  failedJobs: { name: string; url: string | null }[];
  /** Pre-rendered trend line, prefixed with "Trend: ". */
  trendLine: string;
  /** Direct link to the current run. */
  runUrl: string;
};

type SlackMrkdwnText = {
  type: "mrkdwn";
  text: string;
};

type SlackPlainText = {
  type: "plain_text";
  text: string;
  emoji?: boolean;
};

type SlackContextBlock = {
  type: "context";
  elements: SlackMrkdwnText[];
};

type SlackSectionBlock = {
  type: "section";
  text: SlackMrkdwnText;
};

type SlackButtonElement = {
  type: "button";
  text: SlackPlainText;
  url: string;
  style?: "primary" | "danger";
};

type SlackActionsBlock = {
  type: "actions";
  elements: SlackButtonElement[];
};

type SlackBlock = SlackActionsBlock | SlackContextBlock | SlackSectionBlock;

/**
 * Build Slack Block Kit blocks.
 */
function buildBlocks(data: ScorecardData): SlackBlock[] {
  // Title is rendered outside the attachment via buildFallbackText so the
  // attachment stays under Slack's truncation threshold.
  const blocks: SlackBlock[] = [];

  // Append actor suffix for dispatch-based runs (manual full / selective).
  // Schedule runs skip the suffix because github.actor there is the workflow
  // file author, not a meaningful trigger.
  const showActor = data.runMode !== "Scheduled full nightly" && Boolean(data.actor);
  const runModeText = showActor ? `${data.runMode} (by *${data.actor}*)` : data.runMode;
  const contextElements: SlackMrkdwnText[] = [
    { type: "mrkdwn", text: `*Run mode:* ${runModeText}` },
  ];
  if (data.isSelectiveDispatch && data.requestedJobs.length > 0) {
    const jobList = data.requestedJobs.map((name) => `\`${name}\``).join(", ");
    contextElements.push({ type: "mrkdwn", text: `*Requested:* ${jobList}` });
  }
  blocks.push({ type: "context", elements: contextElements });

  const statsLine = [
    `*Total ran:* ${data.ran}/${data.total}`,
    `:white_check_mark: *Passed:* ${data.success}`,
    `:x: *Failed:* ${data.failure}`,
    `:no_entry_sign: *Cancelled:* ${data.cancelled}`,
    `:fast_forward: *Skipped:* ${data.skipped}`,
  ].join("  ·  ");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: statsLine },
  });

  if (data.perfect) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ":tada: *All jobs passed!*" },
    });
  } else if (data.failedJobs.length > 0) {
    // Slack mrkdwn hyperlink: <url|text>. Bare name as link text (Slack
    // doesn't render backticks-inside-link, so plain underlined text wins).
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

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: data.trendLine.replace(/^Trend:\s*/, "*Trend:* "),
      },
    ],
  });

  const workflowUrl = data.runUrl.replace(/\/runs\/\d+$/, "/workflows/nightly-e2e.yaml");
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
        text: { type: "plain_text", text: "All nightly-e2e runs", emoji: true },
        url: workflowUrl,
      },
    ],
  });

  return blocks;
}

/**
 * Title rendered outside the Slack attachment. Doubles as the fallback
 * text for notification previews and screen readers (required by Slack
 * — missing `text` triggers a warning).
 */
function buildFallbackText(data: ScorecardData): string {
  let modeSegment: string;
  switch (data.runMode) {
    case "Scheduled full nightly":
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
  return `🌅 *NemoClaw Nightly Scorecard · ${modeSegment} · ${data.today}*`;
}

type SlackStatusColor = "danger" | "good" | "warning";

/**
 * Slack attachment color for the left-edge bar:
 *   "good"    → green   (perfect)
 *   "danger"  → red     (any failure)
 *   "warning" → yellow  (incomplete)
 */
function getStatusColor(data: ScorecardData): SlackStatusColor {
  if (data.failure > 0) return "danger";
  if (data.perfect) return "good";
  return "warning";
}

type SlackChannel = "daily" | "fullrun" | "preview";

/**
 * Routes the Slack post to a channel based on run mode. Production runs
 * always land in one of the first two channels:
 *   "Scheduled full nightly" → "daily"   (daily ops alerts)
 *   "Manual full run"        → "fullrun" (team-wide CI channel)
 *
 * Selective dispatch returns "preview", reserved for dev testing only.
 *
 * The caller maps the returned tag to a webhook URL secret.
 */
function getSlackChannel(data: ScorecardData): SlackChannel {
  if (data.runMode === "Scheduled full nightly") return "daily";
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
