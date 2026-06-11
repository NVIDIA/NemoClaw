// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addTraceEvent,
  flushTrace,
  getTraceCollector,
  resetTraceForTests,
  TRACE_DIR_ENV,
  TRACE_ENABLED_ENV,
  TRACE_FILE_ENV,
  type TraceArtifact,
  withTraceSpan,
} from "./trace";

function withTraceFile<T>(fn: (traceFile: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-test-"));
  const traceFile = path.join(tmpDir, "trace.json");
  process.env[TRACE_FILE_ENV] = traceFile;
  resetTraceForTests();
  return fn(traceFile);
}

afterEach(() => {
  delete process.env[TRACE_ENABLED_ENV];
  delete process.env[TRACE_FILE_ENV];
  delete process.env[TRACE_DIR_ENV];
  resetTraceForTests();
});

describe("onboard trace artifacts", () => {
  it("writes OpenTelemetry-style spans and a slowest-span summary", () => {
    withTraceFile((traceFile) => {
      withTraceSpan("nemoclaw.onboard.phase.gateway", { provider: "nvidia-prod" }, () => {
        addTraceEvent("ready", { attempt: 1 });
      });

      expect(flushTrace()).toBe(traceFile);
      const artifact = JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
      const spans = artifact.resource_spans[0].scope_spans[0].spans;

      expect(artifact.resource_spans[0].scope_spans[0].scope.name).toBe("nemoclaw.onboard");
      expect(spans).toHaveLength(1);
      expect(spans[0].trace_id).toBe(artifact.summary.trace_id);
      expect(spans[0].span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(spans[0].duration_ms).toBeGreaterThanOrEqual(0);
      expect(spans[0].events[0]).toMatchObject({
        name: "ready",
        attributes: { attempt: 1 },
      });
      expect(artifact.summary.slowest_spans[0].name).toBe("nemoclaw.onboard.phase.gateway");
    });
  });

  it("creates a readable timestamped trace file when NEMOCLAW_TRACE is enabled", () => {
    const originalCwd = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-enabled-"));
    try {
      process.chdir(tmpDir);
      process.env[TRACE_ENABLED_ENV] = "1";
      resetTraceForTests();

      const collector = getTraceCollector();
      expect(collector?.outputPath).toMatch(
        /[/\\]\.e2e[/\\]traces[/\\]nemoclaw-trace-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}Z-pid-\d+\.json$/,
      );

      withTraceSpan("nemoclaw.onboard.phase.preflight", {}, () => undefined);
      const outputPath = flushTrace();
      expect(outputPath).toBe(collector?.outputPath);
      expect(fs.existsSync(String(outputPath))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("treats false-like NEMOCLAW_TRACE values as disabled", () => {
    process.env[TRACE_ENABLED_ENV] = "false";
    resetTraceForTests();

    expect(getTraceCollector()).toBeNull();
  });

  it("removes the registered exit listener when resetting tests", () => {
    const before = process.listenerCount("exit");
    withTraceFile(() => {
      expect(getTraceCollector()).not.toBeNull();
      expect(process.listenerCount("exit")).toBe(before + 1);
      resetTraceForTests();
      expect(process.listenerCount("exit")).toBe(before);
    });
  });

  it("does not mark traces flushed when artifact writes fail", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trace-blocker-"));
    fs.chmodSync(tmpDir, 0o700);
    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "not a directory");
    process.env[TRACE_FILE_ENV] = path.join(blocker, "trace.json");
    resetTraceForTests();
    const collector = getTraceCollector();
    expect(collector).not.toBeNull();

    expect(() => flushTrace()).toThrow();
    expect(() => collector?.flush()).toThrow();
  });
});
