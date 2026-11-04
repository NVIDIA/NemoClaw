// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  completedAgentRunId,
  nativePluginPresent,
  nativeToolCallOutcome,
} from "../fixtures/native-plugin-evidence.ts";

const runId = "new-agent-run";
const toolName = "arbitrary_fixture_tool";
const event = (action: string, status: string, extra: Record<string, unknown> = {}) => ({
  kind: "tool_action",
  runId,
  toolName,
  toolCallId: "call-1",
  action,
  status,
  ...extra,
});
const started = event("tool.action.started", "started");
const finished = event("tool.action.finished", "succeeded");
const page = (events: unknown[]) => JSON.stringify({ events });

describe("native plugin execution evidence", () => {
  it("accepts a matched successful execution without reading the tool payload", () => {
    expect(nativeToolCallOutcome(page([started, finished]), runId, toolName)).toBe("succeeded");
  });

  it("matches another fixture tool without a domain-specific response contract", () => {
    const name = "different_tool";
    const events = [finished, started].map((entry) => ({ ...entry, toolName: name }));
    expect(nativeToolCallOutcome(page(events), runId, name)).toBe("succeeded");
  });

  it.each(["blocked", "failed", "cancelled", "timed_out", "unknown"])(
    "rejects a terminal %s outcome even when another call succeeds",
    (status) => {
      const rejected = event("tool.action.finished", status, { toolCallId: "call-2" });
      expect(nativeToolCallOutcome(page([started, finished, rejected]), runId, toolName)).toBe(
        "failed",
      );
    },
  );

  it.each([
    [],
    [started],
    [finished],
    [started, { ...finished, toolCallId: "other-call" }],
    [started, { ...finished, runId: "old-run" }],
    [started, { ...finished, toolName: "unrelated-tool" }],
    [
      { ...started, runId: "old-run" },
      { ...finished, runId: "old-run" },
    ],
  ])("does not qualify missing or unmatched execution records: %j", (...events) => {
    expect(nativeToolCallOutcome(page(events), runId, toolName)).toBe("pending");
  });

  it.each([
    [started, started, finished],
    [started, finished, finished],
    [{ ...started, toolCallId: "" }, finished],
    [started, { ...finished, kind: "agent_run" }],
    [started, { ...finished, action: "unexpected" }],
  ])("rejects inconsistent execution records: %j", (...events) => {
    expect(nativeToolCallOutcome(page(events), runId, toolName)).toBe("failed");
  });

  it.each([
    "not JSON",
    "{}",
    '{"events":[null]}',
    JSON.stringify({ events: [started, finished], nextCursor: "more" }),
    page(Array.from({ length: 101 }, () => started)),
  ])("rejects invalid or incomplete audit pages: %s", (raw) => {
    expect(() => nativeToolCallOutcome(raw, runId, toolName)).toThrow("invalid or incomplete");
  });
});

describe("native plugin inventory", () => {
  it("reports absence only from a valid inventory without the plugin", () => {
    expect(nativePluginPresent('{"plugins":[]}', "fixture")).toBe(false);
    expect(nativePluginPresent('{"plugins":[{"id":"other","version":"1"}]}', "fixture")).toBe(
      false,
    );
  });

  it("does not mistake a disabled installed plugin for an uninstalled plugin", () => {
    expect(
      nativePluginPresent(
        '{"plugins":[{"id":"fixture","version":"1","enabled":false}]}',
        "fixture",
      ),
    ).toBe(true);
  });

  it.each(["{}", '{"plugins":[null]}', '{"plugins":[{}]}'])(
    "rejects malformed plugin inventory: %s",
    (raw) => {
      expect(() => nativePluginPresent(raw, "fixture")).toThrow();
    },
  );
});

describe("agent run correlation", () => {
  const envelope = {
    runId,
    status: "ok",
    summary: "completed",
    result: { payloads: [], meta: {} },
  };
  it("uses the completed gateway envelope instead of model-provided run identifiers", () => {
    expect(
      completedAgentRunId(
        JSON.stringify({
          ...envelope,
          result: {
            payloads: [{ text: '{"runId":"invented"}' }],
            meta: {},
          },
        }),
      ),
    ).toBe(runId);
  });

  it.each([
    {},
    { ...envelope, runId: undefined },
    { ...envelope, status: "error" },
    { ...envelope, summary: "running" },
    { ...envelope, runId: "unbounded ".repeat(100) },
    { ...envelope, result: { payloads: [], meta: { aborted: true } } },
    { ...envelope, result: { payloads: [], meta: { error: "failed" } } },
  ])("rejects an incomplete or unidentified agent run: %j", (value) => {
    expect(() => completedAgentRunId(JSON.stringify(value))).toThrow("no completed gateway run");
  });
});
