// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifySearchTurn } from "../../../nemoclaw/src/runtime-context.ts";
import {
  nativePluginAgentRunId,
  nativePluginAgentInvocationOutcome,
  nativePluginPresent,
  nativePluginAgentPrompt,
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

it.each(["v1", "v2"] as const)(
  "keeps the %s fixture request local and names its native dispatcher",
  (version) => {
    const prompt = nativePluginAgentPrompt(version);
    expect(prompt).toContain(`Use tool_call with id nemoclaw_e2e_check_${version} and args {}`);
    expect(prompt).toContain("otherwise use the directly exposed tool");
    expect(classifySearchTurn(prompt).scope).toBe("ordinary");
  },
);

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
  it("uses the gateway envelope instead of model-provided run identifiers", () => {
    expect(
      nativePluginAgentRunId(
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
    { ...envelope, runId: "unbounded ".repeat(100) },
    { runId, payloads: [], meta: {} },
    { result: { payloads: [{ text: JSON.stringify(envelope) }], meta: {} } },
  ])("rejects an unidentified gateway run: %j", (value) => {
    expect(() => nativePluginAgentRunId(JSON.stringify(value))).toThrow(
      "no unambiguous gateway run",
    );
  });

  it("rejects multiple gateway envelopes rather than choosing the last run", () => {
    expect(() =>
      nativePluginAgentRunId(
        JSON.stringify(envelope) + "\n" + JSON.stringify({ ...envelope, runId: "other" }),
      ),
    ).toThrow("no unambiguous gateway run");
  });

  it("does not require the identified run to have a final assistant reply", () => {
    expect(
      nativePluginAgentRunId(
        JSON.stringify({
          ...envelope,
          status: "timeout",
          summary: "aborted",
          result: { payloads: [], meta: { timeoutPhase: "provider" } },
        }),
      ),
    ).toBe(runId);
  });
});

describe("native plugin agent invocation", () => {
  const pluginTool = "nemoclaw_e2e_check_v1";
  const turnOutput = JSON.stringify({
    runId,
    status: "ok",
    summary: "completed",
    result: { payloads: [], meta: {} },
  });
  const auditPage = (events: Record<string, unknown>[]) =>
    page(events.map((entry) => ({ ...entry, toolName: pluginTool })));
  type InvocationSandbox = Parameters<typeof nativePluginAgentInvocationOutcome>[0];
  const fakeSandbox = (
    turn: { exitCode: number | null; stdout: string; timedOut?: boolean; signal?: string },
    audits: string[],
  ) => {
    const calls: string[][] = [];
    const shells: string[] = [];
    const sandbox = {
      exec: async (_name: string, argv: string[]) => {
        calls.push(argv);
        return argv[1] === "agent"
          ? { ...turn, stderr: "" }
          : { exitCode: 0, stdout: audits.shift() ?? auditPage([]), stderr: "" };
      },
      execShell: async (_name: string, script: string) => {
        shells.push(script);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as InvocationSandbox;
    return { calls, shells, sandbox };
  };
  const options = {
    sandboxName: "fixture",
    version: "v1" as const,
    artifactName: "invoke",
    env: {},
    turnTimeoutMs: 1_000,
    agentTimeoutSeconds: 30,
    audit: { attempts: 3, delayMs: 0, timeoutMs: 1_000 },
  };

  it("runs one agent turn and polls only the audit page until the call completes", async () => {
    const fake = fakeSandbox({ exitCode: 0, stdout: turnOutput }, [
      auditPage([started]),
      auditPage([started, finished]),
    ]);
    expect(await nativePluginAgentInvocationOutcome(fake.sandbox, options)).toBe("succeeded");
    expect(fake.calls.map((argv) => argv[1])).toEqual(["agent", "audit", "audit"]);
    expect(fake.calls[0]).toContain(nativePluginAgentPrompt("v1"));
    expect(fake.calls[0]).toEqual(expect.arrayContaining(["--timeout", "30"]));
    expect(fake.calls[1]).toEqual(
      expect.arrayContaining(["--run", runId, "--kind", "tool_action"]),
    );
    expect(fake.shells).toEqual([]);
  });

  it("reports a failed turn without reading audit records and keeps readiness evidence", async () => {
    const fake = fakeSandbox({ exitCode: 1, stdout: "" }, []);
    expect(await nativePluginAgentInvocationOutcome(fake.sandbox, options)).toBe("failed");
    expect(fake.calls.map((argv) => argv[1])).toEqual(["agent"]);
    expect(fake.shells).toHaveLength(1);
  });
});

describe("plugin execution independently of final reply", () => {
  const tool = "nemoclaw_e2e_check_v2";
  const invocationRun = "d09778af-29ec-4378-ace3-e69c801ec508";
  const turn = JSON.stringify({
    runId: invocationRun,
    status: "timeout",
    summary: "aborted",
    result: {
      payloads: [{ text: "Request timed out", isError: true }],
      meta: { timeoutPhase: "provider", providerStarted: true, error: { kind: "incomplete_turn" } },
    },
  });
  const audit = (events: unknown[]) => JSON.stringify({ events });
  const pair = [started, finished].map((e) => ({ ...e, runId: invocationRun, toolName: tool }));
  const options = {
    sandboxName: "fixture",
    version: "v2" as const,
    artifactName: "invoke",
    env: {},
    agentTimeoutSeconds: 30,
    turnTimeoutMs: 60_000,
    audit: { attempts: 1, delayMs: 0, timeoutMs: 30_000 },
  };
  const sandbox = (
    events: unknown[],
    transport: Record<string, unknown> = {},
    auditTransport: Record<string, unknown> = {},
  ) => {
    const calls: string[][] = [];
    return {
      calls,
      client: {
        exec: async (_name: string, argv: string[]) => {
          calls.push(argv);
          return argv[1] === "agent"
            ? { exitCode: 1, stdout: turn, stderr: "", ...transport }
            : { exitCode: 0, stdout: audit(events), stderr: "", ...auditTransport };
        },
        execShell: async () => ({ exitCode: 0, stdout: "healthz=200\nreadyz=200\n", stderr: "" }),
      } as unknown as Parameters<typeof nativePluginAgentInvocationOutcome>[0],
    };
  };

  it("requires the real matched audit even when the final reply times out", async () => {
    const fake = sandbox(pair);
    expect(await nativePluginAgentInvocationOutcome(fake.client, options)).toBe("succeeded");
    expect(fake.calls.filter((argv) => argv[1] === "agent")).toHaveLength(1);
    expect(fake.calls.filter((argv) => argv[1] === "audit")).toHaveLength(2);
  });

  it.each([
    ["missing execution", []],
    ["only started", [pair[0]]],
    ["unmatched call", [pair[0], { ...pair[1], toolCallId: "other" }]],
    ["another run", pair.map((e) => ({ ...e, runId: "old-run" }))],
    ["another tool", pair.map((e) => ({ ...e, toolName: "other" }))],
  ])("does not accept %s from diagnostic counts or readiness", async (_label, events) => {
    const fake = sandbox(events);
    await expect(nativePluginAgentInvocationOutcome(fake.client, options)).rejects.toThrow(
      "polling exhausted its configured bound",
    );
  });

  it.each(["blocked", "failed", "cancelled", "timed_out", "unknown"])(
    "rejects %s tool execution despite a matching start",
    async (status) => {
      const fake = sandbox([pair[0], { ...pair[1], status }]);
      expect(await nativePluginAgentInvocationOutcome(fake.client, options)).toBe("failed");
    },
  );

  it.each([{ timedOut: true }, { signal: "SIGTERM" }, { exitCode: null }])(
    "rejects a transport failure even with successful diagnostic audit: %j",
    async (transport) => {
      const fake = sandbox(pair, transport);
      expect(await nativePluginAgentInvocationOutcome(fake.client, options)).toBe("failed");
    },
  );

  it.each([{ exitCode: 1 }, { timedOut: true }, { signal: "SIGTERM" }])(
    "rejects a failed audit read even if its output contains a successful pair: %j",
    async (auditTransport) => {
      const fake = sandbox(pair, {}, auditTransport);
      expect(await nativePluginAgentInvocationOutcome(fake.client, options)).toBe("failed");
    },
  );
});
