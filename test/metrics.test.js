// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Point HOME to an isolated temp directory so tests never touch real metrics.
const TEST_HOME = path.join(os.tmpdir(), `nemoclaw-metrics-test-${Date.now()}`);
process.env.HOME = TEST_HOME;

// Re-require after setting HOME so the module picks up the test directory.
delete require.cache[require.resolve("../bin/lib/metrics")];
const metrics = require("../bin/lib/metrics");

function cleanup() {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {}
}

describe("metrics", () => {
  beforeEach(() => {
    cleanup();
  });

  it("recordEvent creates the metrics file", () => {
    metrics.recordEvent("test_event", { sandbox: "s1" });
    assert.ok(fs.existsSync(metrics.metricsPath()));
  });

  it("loadEvents returns recorded events", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "alpha" });
    metrics.recordEvent("sandbox_connect", { sandbox: "beta" });
    metrics.recordEvent("policy_apply", { sandbox: "alpha", preset: "slack" });

    const all = metrics.loadEvents();
    assert.equal(all.length, 3);
    assert.equal(all[0].type, "sandbox_connect");
    assert.equal(all[0].sandbox, "alpha");
  });

  it("loadEvents filters by sandbox", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "a" });
    metrics.recordEvent("sandbox_connect", { sandbox: "b" });

    const filtered = metrics.loadEvents({ sandbox: "a" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sandbox, "a");
  });

  it("loadEvents filters by type", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "a" });
    metrics.recordEvent("policy_apply", { sandbox: "a", preset: "slack" });

    const filtered = metrics.loadEvents({ type: "policy_apply" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].preset, "slack");
  });

  it("getStats computes aggregates", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("policy_apply", { sandbox: "s1", preset: "slack" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s2" });
    metrics.recordEvent("sandbox_destroy", { sandbox: "s2" });

    const stats = metrics.getStats();
    assert.equal(stats.totalEvents, 5);
    assert.equal(stats.byType["sandbox_connect"], 3);
    assert.equal(stats.byType["policy_apply"], 1);
    assert.equal(stats.byType["sandbox_destroy"], 1);
    assert.equal(stats.bySandbox["s1"].events, 3);
    assert.equal(stats.bySandbox["s2"].events, 2);
    assert.ok(stats.firstEvent);
    assert.ok(stats.lastEvent);
  });

  it("getStats scoped to sandbox", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s2" });

    const stats = metrics.getStats("s1");
    assert.equal(stats.totalEvents, 1);
  });

  it("getStats returns empty stats when no events", () => {
    const stats = metrics.getStats();
    assert.equal(stats.totalEvents, 0);
    assert.equal(stats.firstEvent, null);
  });

  it("resetMetrics clears all events", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    assert.equal(metrics.loadEvents().length, 1);

    metrics.resetMetrics();
    assert.equal(metrics.loadEvents().length, 0);
  });

  it("handles malformed lines gracefully", () => {
    // Write a valid event then corrupt a line
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    fs.appendFileSync(metrics.metricsPath(), "not-valid-json\n");
    metrics.recordEvent("sandbox_destroy", { sandbox: "s1" });

    const events = metrics.loadEvents();
    assert.equal(events.length, 2, "should skip malformed line");
  });

  it("stats command exits 0 via CLI", () => {
    const { execSync } = require("child_process");
    const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");
    const result = execSync(`node "${CLI}" stats`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: TEST_HOME },
    });
    assert.ok(result.includes("NemoClaw Metrics"), "should show metrics header");
  });
});
