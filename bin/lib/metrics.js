// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Lightweight metrics collection for NemoClaw.
// Events are stored as newline-delimited JSON (JSONL) at ~/.nemoclaw/metrics.jsonl.
// No external dependencies — uses only Node.js built-ins.

const fs = require("fs");
const path = require("path");

// Refuse to write metrics if HOME is unset — never fall back to /tmp on shared
// machines where the file would be world-readable.
const HOME = process.env.HOME;
const METRICS_DIR = HOME ? path.join(HOME, ".nemoclaw") : null;
const METRICS_FILE = METRICS_DIR ? path.join(METRICS_DIR, "metrics.jsonl") : null;

// Reserved keys that callers must not override via the data spread.
const RESERVED_KEYS = new Set(["ts", "type"]);

/**
 * Return true if `filePath` exists and is a regular file (not a symlink).
 * Prevents symlink-following attacks where an attacker points the metrics
 * file at an arbitrary target to get JSONL content written there.
 */
function isSafeFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile();
  } catch (err) {
    // ENOENT is fine — file will be created fresh.
    if (err.code === "ENOENT") return true;
    return false;
  }
}

/**
 * Record a timestamped event.
 *
 * @param {string} type    Event type (e.g. "sandbox_connect", "policy_apply")
 * @param {object} [data]  Arbitrary metadata attached to the event
 */
function recordEvent(type, data = {}) {
  try {
    if (!METRICS_FILE) return;
    if (!isSafeFile(METRICS_FILE)) return;

    // Strip reserved keys so callers cannot overwrite ts/type.
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (!RESERVED_KEYS.has(k)) cleaned[k] = v;
    }

    fs.mkdirSync(METRICS_DIR, { recursive: true, mode: 0o700 });
    const event = {
      ...cleaned,
      ts: new Date().toISOString(),
      type,
    };
    fs.appendFileSync(METRICS_FILE, JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {
    // Metrics are best-effort — never crash the CLI.
  }
}

/**
 * Load all recorded events, optionally filtered.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.sandbox]  Only events for this sandbox
 * @param {string}  [opts.type]     Only events of this type
 * @param {string}  [opts.since]    ISO timestamp lower bound
 * @returns {object[]}
 */
function loadEvents(opts = {}) {
  if (!METRICS_FILE || !fs.existsSync(METRICS_FILE)) return [];

  const lines = fs.readFileSync(METRICS_FILE, "utf-8").trim().split("\n").filter(Boolean);
  let events = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }

  if (opts.sandbox) {
    events = events.filter((e) => e.sandbox === opts.sandbox);
  }
  if (opts.type) {
    events = events.filter((e) => e.type === opts.type);
  }
  if (opts.since) {
    events = events.filter((e) => e.ts >= opts.since);
  }

  return events;
}

/**
 * Compute aggregate statistics from recorded events.
 *
 * @param {string} [sandboxName]  Scope stats to a single sandbox
 * @returns {object}
 */
function getStats(sandboxName) {
  const events = sandboxName ? loadEvents({ sandbox: sandboxName }) : loadEvents();

  if (events.length === 0) {
    return { totalEvents: 0, byType: {}, bySandbox: {}, firstEvent: null, lastEvent: null };
  }

  const byType = {};
  const bySandbox = {};

  for (const e of events) {
    // Count by type
    byType[e.type] = (byType[e.type] || 0) + 1;

    // Count by sandbox
    if (e.sandbox) {
      if (!bySandbox[e.sandbox]) {
        bySandbox[e.sandbox] = { events: 0, byType: {} };
      }
      bySandbox[e.sandbox].events += 1;
      bySandbox[e.sandbox].byType[e.type] = (bySandbox[e.sandbox].byType[e.type] || 0) + 1;
    }
  }

  return {
    totalEvents: events.length,
    byType,
    bySandbox,
    firstEvent: events[0].ts,
    lastEvent: events[events.length - 1].ts,
  };
}

/**
 * Delete all recorded metrics.
 */
function resetMetrics() {
  try {
    if (METRICS_FILE && fs.existsSync(METRICS_FILE)) {
      fs.unlinkSync(METRICS_FILE);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Return the path to the metrics file (null when HOME is unset).
 */
function metricsPath() {
  return METRICS_FILE;
}

module.exports = {
  recordEvent,
  loadEvents,
  getStats,
  resetMetrics,
  metricsPath,
};
