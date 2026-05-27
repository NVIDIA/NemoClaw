// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builder for the nightly scorecard Slack payload. Consumed by the
 * `Post scorecard to Slack` step in `.github/workflows/nightly-e2e.yaml`
 * and exercised by `test/scorecard-blocks.test.ts`.
 */

/**
 * @typedef {Object} ScorecardData
 * @property {string} today             Display date, e.g. "May 25".
 * @property {string} runMode           "Scheduled full nightly" | "Manual full run" | "Selective dispatch".
 * @property {boolean} isSelectiveDispatch
 * @property {string[]} requestedJobs   Populated only when isSelectiveDispatch is true.
 * @property {number} total             Total jobs considered (excludes meta jobs).
 * @property {number} ran               total - skipped.
 * @property {number} success
 * @property {number} failure
 * @property {number} cancelled
 * @property {number} skipped
 * @property {boolean} perfect          ran > 0 && failure === 0 && cancelled === 0.
 * @property {string[]} failedJobs      Sorted list of failed job names.
 * @property {string} trendLine         Pre-rendered trend line, prefixed with "Trend: ".
 * @property {string} runUrl            Direct link to the current run.
 */

/**
 * @param {ScorecardData} data
 * @returns {Array<object>} Slack Block Kit blocks
 */
function buildBlocks(data) {
  // Title is rendered outside the attachment via buildFallbackText so the
  // attachment stays under Slack's truncation threshold.
  const blocks = [];

  const contextElements = [{ type: "mrkdwn", text: `*Run mode:* ${data.runMode}` }];
  if (data.isSelectiveDispatch && data.requestedJobs.length > 0) {
    const jobList = data.requestedJobs.map((name) => `\`${name}\``).join(", ");
    contextElements.push({ type: "mrkdwn", text: `*Requested:* ${jobList}` });
  }
  blocks.push({ type: "context", elements: contextElements });

  const statsLine = [
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
    const list = data.failedJobs.map((name) => `• \`${name}\``).join("\n");
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
 *
 * @param {ScorecardData} data
 * @returns {string}
 */
function buildFallbackText(data) {
  return `🌅 *NemoClaw Nightly Scorecard — ${data.today}*`;
}

/**
 * Slack attachment color for the left-edge bar:
 *   "good"    → green   (perfect)
 *   "danger"  → red     (any failure)
 *   "warning" → yellow  (incomplete)
 *
 * @param {ScorecardData} data
 * @returns {"good" | "danger" | "warning"}
 */
function getStatusColor(data) {
  if (data.failure > 0) return "danger";
  if (data.perfect) return "good";
  return "warning";
}

module.exports = { buildBlocks, buildFallbackText, getStatusColor };
