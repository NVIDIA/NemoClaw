// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCurlProbe } from "./adapters/http/probe";
import {
  addTraceEvent,
  flushTrace,
  getTraceCollector,
  resetTraceForTests,
  sanitizeTraceAttributes,
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

function readTraceArtifact(traceFile: string): TraceArtifact {
  return JSON.parse(fs.readFileSync(traceFile, "utf8")) as TraceArtifact;
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
      const artifact = readTraceArtifact(traceFile);
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

  it("redacts secret-like metadata before writing artifacts", () => {
    withTraceFile((traceFile) => {
      const cloudToken = ["nv", "api", "-"].join("") + "a".repeat(16);
      const bearerToken = `Bearer ${"b".repeat(16)}`;
      const awsAccessKey = ["AK", "IA"].join("") + "C".repeat(16);
      const jwt = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(12)].join(".");

      withTraceSpan(
        "nemoclaw.onboard.phase.inference",
        {
          api_key: cloudToken,
          harmless_status: `probe failed with ${bearerToken}`,
          aws_like: awsAccessKey,
          jwt_like: jwt,
          credential_env: "NVIDIA_API_KEY",
        },
        () => undefined,
      );

      expect(flushTrace()).toBe(traceFile);
      const text = fs.readFileSync(traceFile, "utf8");
      const artifact = JSON.parse(text) as TraceArtifact;
      const attrs = artifact.resource_spans[0].scope_spans[0].spans[0].attributes;

      expect(attrs.api_key).toBe("<REDACTED>");
      expect(attrs.harmless_status).toContain("<REDACTED>");
      expect(attrs.aws_like).toBe("<REDACTED>");
      expect(attrs.jwt_like).toBe("<REDACTED>");
      expect(attrs.credential_env).toBe("NVIDIA_API_KEY");
      expect(text).not.toContain(cloudToken);
      expect(text).not.toContain(bearerToken);
      expect(text).not.toContain(awsAccessKey);
      expect(text).not.toContain(jwt);
    });
  });

  it("sanitizes curl probe URLs and records status metadata", () => {
    withTraceFile((traceFile) => {
      const result = runCurlProbe(
        [
          "-sS",
          "-H",
          "Authorization: Bearer should-not-appear",
          "https://example.test/v1/chat/completions?key=secret",
        ],
        {
          spawnSyncImpl: () =>
            ({
              status: 0,
              stdout: "200",
              stderr: "",
              error: undefined,
            }) as never,
        },
      );

      expect(result.ok).toBe(true);
      expect(flushTrace()).toBe(traceFile);
      const text = fs.readFileSync(traceFile, "utf8");
      const artifact = JSON.parse(text) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans.find(
        (entry) => entry.name === "nemoclaw.inference.curl_probe",
      );

      expect(text).not.toContain("should-not-appear");
      expect(text).not.toContain("key=secret");
      expect(span?.attributes["http.url"]).toBe(
        "https://example.test/v1/chat/completions?key=%3CREDACTED%3E",
      );
      expect(span?.events[0].attributes).toMatchObject({ ok: true, http_status: 200 });
    });
  });

  it("sanitizes nested sensitive span and event attributes", () => {
    withTraceFile((traceFile) => {
      const queryToken = ["ghp", "_"].join("") + "d".repeat(24);
      const slackWebhook = `https://hooks.slack.com/services/${"A".repeat(12)}/${"B".repeat(
        12,
      )}/${"C".repeat(24)}`;
      const eventBearer = `Bearer ${"e".repeat(16)}`;

      withTraceSpan(
        "nemoclaw.onboard.phase.gateway",
        {
          probe_url: `https://user:pass@example.test/path?token=${queryToken}`,
          slack_webhook: slackWebhook,
        },
        () => {
          addTraceEvent("curl_probe", {
            headers: { authorization: eventBearer },
          });
        },
      );

      expect(flushTrace()).toBe(traceFile);
      const text = fs.readFileSync(traceFile, "utf8");
      const artifact = JSON.parse(text) as TraceArtifact;
      const span = artifact.resource_spans[0].scope_spans[0].spans[0];

      expect(String(span.attributes.probe_url)).not.toContain(queryToken);
      expect(span.attributes.slack_webhook).toBe("<REDACTED>");
      expect(JSON.stringify(span.events[0].attributes)).toContain("<REDACTED>");
      expect(text).not.toContain(queryToken);
      expect(text).not.toContain(slackWebhook);
      expect(text).not.toContain(eventBearer);
    });
  });

  it("redacts nested sensitive attributes", () => {
    expect(
      sanitizeTraceAttributes({
        nested: { token: "xoxb-secret", ok: true },
        credential_env: "NVIDIA_INFERENCE_API_KEY",
      }),
    ).toMatchObject({
      nested: '{"token":"<REDACTED>","ok":true}',
      credential_env: "NVIDIA_INFERENCE_API_KEY",
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
