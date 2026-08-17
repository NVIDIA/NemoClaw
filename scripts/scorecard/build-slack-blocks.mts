// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure Slack payload builder for the consolidated E2E scorecard. */

type ScorecardRunMode = "Main push" | "Manual full run" | "Selective dispatch" | (string & {});

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

const SLACK_SECTION_TEXT_LIMIT = 3_000;
const FAILED_JOBS_CONTINUED_HEADING = "*Failed jobs (continued):*";

function truncateSlackLabel(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function buildFailedJobEntry(
  job: ScorecardData["failedJobs"][number],
  runUrl: string,
  maxLength: number,
): string {
  if (!job.url) {
    const prefix = "• `";
    const suffix = "`";
    return `${prefix}${truncateSlackLabel(job.name, maxLength - prefix.length - suffix.length)}${suffix}`;
  }

  const directLinkOverhead = `• <${job.url}|>`.length;
  const linkUrl = directLinkOverhead < maxLength ? job.url : runUrl;
  const prefix = `• <${linkUrl}|`;
  const suffix = ">";
  const labelLength = maxLength - prefix.length - suffix.length;
  if (labelLength < 1) throw new Error("scorecard run URL exceeds Slack section text limit");
  return `${prefix}${truncateSlackLabel(job.name, labelLength)}${suffix}`;
}

function buildFailedJobBlocks(data: ScorecardData): SlackSectionBlock[] {
  const initialHeading = `*Failed jobs (${data.failedJobs.length}):*`;
  const maxEntryLength =
    SLACK_SECTION_TEXT_LIMIT -
    Math.max(initialHeading.length, FAILED_JOBS_CONTINUED_HEADING.length) -
    1;
  const entries = data.failedJobs.map((job) =>
    buildFailedJobEntry(job, data.runUrl, maxEntryLength),
  );
  const blocks: SlackSectionBlock[] = [];
  let heading = initialHeading;
  let lines: string[] = [];

  for (const entry of entries) {
    const candidate = [heading, ...lines, entry].join("\n");
    if (candidate.length > SLACK_SECTION_TEXT_LIMIT && lines.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: [heading, ...lines].join("\n") },
      });
      heading = FAILED_JOBS_CONTINUED_HEADING;
      lines = [entry];
    } else {
      lines.push(entry);
    }
  }

  if (lines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: [heading, ...lines].join("\n") },
    });
  }
  return blocks;
}

function buildBlocks(data: ScorecardData): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const showActor = data.runMode !== "Main push" && Boolean(data.actor);
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
    blocks.push(...buildFailedJobBlocks(data));
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
    case "Main push":
      modeSegment = "🚀 MAIN PUSH";
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
  if (data.runMode === "Main push") return "daily";
  if (data.runMode === "Manual full run") return "fullrun";
  return "preview";
}

export type { ScorecardData, SlackBlock, SlackChannel, SlackStatusColor };
export { buildBlocks, buildFallbackText, getSlackChannel, getStatusColor };
