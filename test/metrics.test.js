// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);

// Save and restore original HOME so this test file doesn't pollute other tests.
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = path.join(os.tmpdir(), `nemoclaw-metrics-test-${Date.now()}`);

function loadMetrics() {
  process.env.HOME = TEST_HOME;
  delete require.cache[require.resolve("../bin/lib/metrics")];
  return require("../bin/lib/metrics");
}

function cleanup() {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {}
}

const metrics = loadMetrics();

describe("metrics", () => {
  beforeEach(() => {
    cleanup();
  });

  afterAll(() => {
    cleanup();
    process.env.HOME = ORIGINAL_HOME;
  });

  it("recordEvent creates the metrics file", () => {
    metrics.recordEvent("test_event", { sandbox: "s1" });
    expect(fs.existsSync(metrics.metricsPath())).toBe(true);
  });

  it("loadEvents returns recorded events", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "alpha" });
    metrics.recordEvent("sandbox_connect", { sandbox: "beta" });
    metrics.recordEvent("policy_apply", { sandbox: "alpha", preset: "slack" });

    const all = metrics.loadEvents();
    expect(all).toHaveLength(3);
    expect(all[0].type).toBe("sandbox_connect");
    expect(all[0].sandbox).toBe("alpha");
  });

  it("loadEvents filters by sandbox", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "a" });
    metrics.recordEvent("sandbox_connect", { sandbox: "b" });

    const filtered = metrics.loadEvents({ sandbox: "a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sandbox).toBe("a");
  });

  it("loadEvents filters by type", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "a" });
    metrics.recordEvent("policy_apply", { sandbox: "a", preset: "slack" });

    const filtered = metrics.loadEvents({ type: "policy_apply" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].preset).toBe("slack");
  });

  it("getStats computes aggregates", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("policy_apply", { sandbox: "s1", preset: "slack" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s2" });
    metrics.recordEvent("sandbox_destroy", { sandbox: "s2" });

    const stats = metrics.getStats();
    expect(stats.totalEvents).toBe(5);
    expect(stats.byType["sandbox_connect"]).toBe(3);
    expect(stats.byType["policy_apply"]).toBe(1);
    expect(stats.byType["sandbox_destroy"]).toBe(1);
    expect(stats.bySandbox["s1"].events).toBe(3);
    expect(stats.bySandbox["s2"].events).toBe(2);
    expect(stats.firstEvent).toBeTruthy();
    expect(stats.lastEvent).toBeTruthy();
  });

  it("getStats scoped to sandbox", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    metrics.recordEvent("sandbox_connect", { sandbox: "s2" });

    const stats = metrics.getStats("s1");
    expect(stats.totalEvents).toBe(1);
  });

  it("getStats returns empty stats when no events", () => {
    const stats = metrics.getStats();
    expect(stats.totalEvents).toBe(0);
    expect(stats.firstEvent).toBeNull();
  });

  it("resetMetrics clears all events", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    expect(metrics.loadEvents()).toHaveLength(1);

    metrics.resetMetrics();
    expect(metrics.loadEvents()).toHaveLength(0);
  });

  it("handles malformed lines gracefully", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    fs.appendFileSync(metrics.metricsPath(), "not-valid-json\n");
    metrics.recordEvent("sandbox_destroy", { sandbox: "s1" });

    const events = metrics.loadEvents();
    expect(events).toHaveLength(2);
  });

  it("reserved keys (ts, type) cannot be overwritten by caller data", () => {
    metrics.recordEvent("sandbox_connect", { sandbox: "s1", ts: "FAKE", type: "FAKE" });

    const events = metrics.loadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("sandbox_connect");
    expect(events[0].ts).not.toBe("FAKE");
    expect(events[0].sandbox).toBe("s1");
  });

  it("refuses to write when metrics file is a symlink", () => {
    const metricsDir = path.join(TEST_HOME, ".nemoclaw");
    fs.mkdirSync(metricsDir, { recursive: true, mode: 0o700 });

    const target = path.join(TEST_HOME, "attack-target");
    fs.writeFileSync(target, "", { mode: 0o600 });
    fs.symlinkSync(target, metrics.metricsPath());

    metrics.recordEvent("sandbox_connect", { sandbox: "evil" });
    const targetContent = fs.readFileSync(target, "utf-8");
    expect(targetContent).toBe("");
  });

  it("is a no-op when HOME is unset", () => {
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    delete require.cache[require.resolve("../bin/lib/metrics")];
    const noHomeMetrics = require("../bin/lib/metrics");

    expect(noHomeMetrics.metricsPath()).toBeNull();
    // Should not throw
    noHomeMetrics.recordEvent("sandbox_connect", { sandbox: "s1" });
    expect(noHomeMetrics.loadEvents()).toEqual([]);

    process.env.HOME = savedHome;
    delete require.cache[require.resolve("../bin/lib/metrics")];
  });

  it("stats command exits 0 via CLI", () => {
    const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
    const result = execSync(`node "${CLI}" stats`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: TEST_HOME },
    });
    expect(result).toContain("NemoClaw Metrics");
  });
});
