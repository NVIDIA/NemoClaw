// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { containsReplyTokenAllowingWhitespace } from "./helpers/e2e-answer-assertions.ts";

const LIVE_REPRO_ENV = "NEMOCLAW_ISSUE_2603_LIVE";
const LIVE_SANDBOX_ENV = "NEMOCLAW_ISSUE_2603_SANDBOX";
const LIVE_SCRIPT_NAME = "openclaw-issue2603-chat-correlation.cjs";

const ISSUE_2603_FIX_EXPECTATIONS = [
  "no empty final event for a submitted chat.send run",
  "each submitted prompt receives exactly one visible reply",
  "each visible reply remains correlated to the chat.send run that accepted the prompt",
  "chat.history contains exactly one user turn per submitted prompt",
];

type ChatMessage = {
  role?: string;
  text?: unknown;
  content?: unknown;
};

type ChatEventPayload = {
  runId?: string;
  state?: string;
  sessionKey?: string;
  message?: ChatMessage;
  errorMessage?: string;
};

type GatewayEvent = {
  event?: string;
  payload?: ChatEventPayload;
  ts?: number;
};

type SentRun = {
  promptToken: string;
  replyMarker: string;
  runId: string;
  message: string;
};

type Issue2603Trace = {
  sessionKey?: string;
  sentRuns: SentRun[];
  events: GatewayEvent[];
  historyMessages: ChatMessage[];
};

type CompactChatEvent = {
  runId?: string;
  state?: string;
  sessionKey?: string;
  text: string;
  errorMessage?: string;
};

type UncorrelatedReply = {
  replyMarker: string;
  expectedRunId: string;
  actualRunId?: string;
  state?: string;
};

type DuplicateUserTurn = {
  promptToken: string;
  count: number;
};

type Issue2603Analysis = {
  chatEvents: CompactChatEvent[];
  foreignSessionChatEvents: CompactChatEvent[];
  conflictingSessionRunEvents: CompactChatEvent[];
  emptyFinalsForSubmittedRuns: CompactChatEvent[];
  missingReplies: string[];
  duplicateReplies: { replyMarker: string; count: number }[];
  uncorrelatedReplies: UncorrelatedReply[];
  missingUserTurns: DuplicateUserTurn[];
  duplicateUserTurns: DuplicateUserTurn[];
};

type LiveIssue2603Trace = Issue2603Trace & { error?: string };

type LiveIssue2603Run = {
  repro: LiveIssue2603Trace;
  attempts: LiveIssue2603Trace[];
};

type ExecStringOptions = Omit<ExecFileSyncOptionsWithStringEncoding, "encoding" | "stdio">;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as ChatMessage;
  if (typeof record.text === "string") return record.text;
  return textFromContent(record.content);
}

// The gateway websocket broadcasts chat events from every session, so a live
// capture can observe replies or aborts that belong to another session — for
// example a prior retry attempt whose runs complete or get aborted late
// (#4881). Chat events that carry a different sessionKey are excluded from
// correlation analysis; events without a sessionKey are kept (fail-open) so
// the assertions can never be blinded by a payload-shape change.
function isOwnSessionChatEvent(event: GatewayEvent, sessionKey?: string): boolean {
  const eventSessionKey = event.payload?.sessionKey;
  return (
    event.event === "chat" &&
    (!sessionKey || typeof eventSessionKey !== "string" || eventSessionKey === sessionKey)
  );
}

function compactChatEvents(events: GatewayEvent[]): CompactChatEvent[] {
  return events
    .filter((event) => event.event === "chat")
    .map((event) => ({
      runId: event.payload?.runId,
      state: event.payload?.state,
      sessionKey: event.payload?.sessionKey,
      text: textFromMessage(event.payload?.message),
      errorMessage: event.payload?.errorMessage,
    }));
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function analyzeIssue2603Trace({
  sessionKey,
  sentRuns,
  events,
  historyMessages,
}: Issue2603Trace): Issue2603Analysis {
  const submittedRunIds = new Set(sentRuns.map((entry) => entry.runId));
  const expectedRunByReplyMarker = new Map(
    sentRuns.map((entry) => [entry.replyMarker, entry.runId]),
  );
  const chatEvents = compactChatEvents(
    events.filter((event) => isOwnSessionChatEvent(event, sessionKey)),
  );
  const foreignSessionChatEvents = compactChatEvents(
    events.filter((event) => event.event === "chat" && !isOwnSessionChatEvent(event, sessionKey)),
  );
  const conflictingSessionRunEvents = foreignSessionChatEvents.filter(
    (event) => typeof event.runId === "string" && submittedRunIds.has(event.runId),
  );

  const emptyFinalsForSubmittedRuns = chatEvents.filter(
    (event) =>
      event.state === "final" &&
      typeof event.runId === "string" &&
      submittedRunIds.has(event.runId) &&
      !event.text.trim(),
  );

  const uncorrelatedReplies: UncorrelatedReply[] = [];
  const visibleReplyCounts = new Map<string, number>();
  const finalReplyCounts = new Map<string, number>();
  for (const [replyMarker, expectedRunId] of expectedRunByReplyMarker) {
    for (const event of chatEvents) {
      if (!containsReplyTokenAllowingWhitespace(event.text, replyMarker)) continue;
      visibleReplyCounts.set(replyMarker, (visibleReplyCounts.get(replyMarker) ?? 0) + 1);
      if (event.state === "final") {
        finalReplyCounts.set(replyMarker, (finalReplyCounts.get(replyMarker) ?? 0) + 1);
      }
      if (event.runId !== expectedRunId) {
        uncorrelatedReplies.push({
          replyMarker,
          expectedRunId,
          actualRunId: event.runId,
          state: event.state,
        });
      }
    }
  }
  const missingReplies = sentRuns
    .map((entry) => entry.replyMarker)
    .filter((replyMarker) => !visibleReplyCounts.has(replyMarker));
  const duplicateReplies = sentRuns
    .map((entry) => ({
      replyMarker: entry.replyMarker,
      count: finalReplyCounts.get(entry.replyMarker) ?? 0,
    }))
    .filter((entry) => entry.count > 1);

  const userPromptCounts = countBy(
    historyMessages
      .filter((message) => message?.role === "user")
      .map((message) => textFromMessage(message).trim())
      .filter(Boolean),
  );
  const userTurnCounts = sentRuns.map((entry) => ({
    promptToken: entry.promptToken,
    count: userPromptCounts.get(entry.message) ?? 0,
  }));
  const missingUserTurns = userTurnCounts.filter((entry) => entry.count < 1);
  const duplicateUserTurns = userTurnCounts.filter((entry) => entry.count > 1);

  return {
    chatEvents,
    foreignSessionChatEvents,
    conflictingSessionRunEvents,
    emptyFinalsForSubmittedRuns,
    missingReplies,
    duplicateReplies,
    uncorrelatedReplies,
    missingUserTurns,
    duplicateUserTurns,
  };
}

function compactHistoryMessages(messages: ChatMessage[]): { role?: string; text: string }[] {
  return messages.map((message) => ({
    role: message.role,
    text: textFromMessage(message),
  }));
}

function summarizeLiveAttempt(attempt: LiveIssue2603Trace, index: number) {
  if (attempt.error) {
    return {
      attempt: index + 1,
      error: attempt.error,
      eventCount: attempt.events?.length ?? 0,
    };
  }

  const analysis = analyzeIssue2603Trace(attempt);
  return {
    attempt: index + 1,
    sessionKey: attempt.sessionKey,
    sentRuns: attempt.sentRuns.map((entry) => ({
      promptToken: entry.promptToken,
      runId: entry.runId,
    })),
    eventCount: attempt.events.length,
    chatEventCount: analysis.chatEvents.length,
    foreignSessionChatEvents: analysis.foreignSessionChatEvents,
    conflictingSessionRunEvents: analysis.conflictingSessionRunEvents,
    missingReplies: analysis.missingReplies,
    emptyFinalsForSubmittedRuns: analysis.emptyFinalsForSubmittedRuns,
    missingUserTurns: analysis.missingUserTurns,
    duplicateUserTurns: analysis.duplicateUserTurns,
  };
}

function buildFailureSummary(
  analysis: Issue2603Analysis,
  trace?: Issue2603Trace,
  attempts?: LiveIssue2603Trace[],
): string {
  return JSON.stringify(
    {
      expectations: ISSUE_2603_FIX_EXPECTATIONS,
      sentRuns: trace?.sentRuns,
      eventCount: trace?.events.length,
      historyMessages: trace ? compactHistoryMessages(trace.historyMessages) : undefined,
      attempts: attempts?.map(summarizeLiveAttempt),
      emptyFinalsForSubmittedRuns: analysis.emptyFinalsForSubmittedRuns,
      missingReplies: analysis.missingReplies,
      duplicateReplies: analysis.duplicateReplies,
      uncorrelatedReplies: analysis.uncorrelatedReplies,
      missingUserTurns: analysis.missingUserTurns,
      duplicateUserTurns: analysis.duplicateUserTurns,
      chatEvents: analysis.chatEvents,
      foreignSessionChatEvents: analysis.foreignSessionChatEvents,
      conflictingSessionRunEvents: analysis.conflictingSessionRunEvents,
    },
    null,
    2,
  );
}

// Frozen historical #2603 trace: it intentionally retains the original
// tool-triggering wait prompt so the classifier keeps covering the observed
// broken gateway behavior. The live repro below uses deterministic no-tools
// prompts instead.
const capturedIssue2603Trace: Issue2603Trace = {
  sentRuns: [
    {
      promptToken: "A2603",
      replyMarker: "A2603-REPLY",
      runId: "18f73be1-3410-46cb-8098-e881bf92c510",
      message:
        "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
    },
    {
      promptToken: "B2603",
      replyMarker: "B2603-REPLY",
      runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
      message: "B2603: Second task. Reply exactly B2603-REPLY and nothing else.",
    },
    {
      promptToken: "C2603",
      replyMarker: "C2603-REPLY",
      runId: "32e608a6-aeb4-4615-8416-d656f2bfa92f",
      message: "C2603: Third task. Reply exactly C2603-REPLY and nothing else.",
    },
  ],
  events: [
    { event: "chat", payload: { runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c", state: "final" } },
    { event: "chat", payload: { runId: "32e608a6-aeb4-4615-8416-d656f2bfa92f", state: "final" } },
    {
      event: "chat",
      payload: {
        runId: "18f73be1-3410-46cb-8098-e881bf92c510",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "A2603-REPLY" }] },
      },
    },
    {
      event: "chat",
      payload: {
        runId: "507730cf-8055-424d-87fe-ee9221c34d74",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
      },
    },
    {
      event: "chat",
      payload: {
        runId: "5487775f-8d5e-4080-ae91-dcce701868a6",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "C2603-REPLY" }] },
      },
    },
  ],
  historyMessages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "A2603-REPLY" }] },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "A2603-REPLY" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "B2603: Second task. Reply exactly B2603-REPLY and nothing else." },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "B2603: Second task. Reply exactly B2603-REPLY and nothing else." },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "C2603: Third task. Reply exactly C2603-REPLY and nothing else." },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "C2603-REPLY" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "C2603: Third task. Reply exactly C2603-REPLY and nothing else." },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "C2603-REPLY" }] },
  ],
};

function execOpenShell(args: string[], options: ExecStringOptions = {}): string {
  return execFileSync("openshell", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function execInSandbox(
  sandboxName: string,
  command: string,
  options: ExecStringOptions = {},
): string {
  return execOpenShell(
    ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-lc", command],
    options,
  );
}

function ensureGatewayRunning(sandboxName: string): void {
  const command = [
    "curl -fsS http://127.0.0.1:18789/health >/dev/null 2>&1",
    "|| (nohup openclaw gateway run --port 18789 >/tmp/openclaw-issue2603-gateway.log 2>&1 & sleep 10)",
    "&& curl -fsS http://127.0.0.1:18789/health >/dev/null",
  ].join(" ");
  execInSandbox(sandboxName, command, { timeout: 30_000 });
}

function buildLiveReproScript(): string {
  return (
    String.raw`
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const openClawRequire = createRequire("/usr/local/lib/node_modules/openclaw/package.json");
const WebSocket = openClawRequire("ws");

const token = process.argv[2];
const sessionKey = process.argv[3];
const ws = new WebSocket("ws://127.0.0.1:18789/ws", { headers: { Origin: "http://127.0.0.1:18789" } });
const events = [];
const pending = new Map();
let requestId = 0;

function request(method, params = {}, timeoutMs = 30_000) {
  const id = ` +
    "`r${++requestId}`" +
    String.raw`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(` +
    "`timeout waiting for ${method}`" +
    String.raw`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
  });
}

function textFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

function compactReplyTokenText(value) {
  return String(value || "").replace(/\s+/g, "");
}

// Chat events are broadcast for every session on this gateway; only events
// from this run's session may satisfy the reply wait (nemoclaw #4881).
function isOwnSessionChatEvent(event) {
  if (event.event !== "chat") return false;
  const eventSessionKey = event.payload?.sessionKey;
  return typeof eventSessionKey !== "string" || eventSessionKey === sessionKey;
}

function sawAllReplies(replyMarkers) {
  return replyMarkers.every((marker) => events.some((event) => isOwnSessionChatEvent(event) && compactReplyTokenText(textFromMessage(event.payload?.message)).includes(compactReplyTokenText(marker))));
}

ws.on("message", (data) => {
  const frame = JSON.parse(String(data));
  if (frame.type === "res" && pending.has(frame.id)) {
    const entry = pending.get(frame.id);
    pending.delete(frame.id);
    clearTimeout(entry.timeout);
    if (frame.ok === false || frame.error) entry.reject(new Error(JSON.stringify(frame.error ?? frame)));
    else entry.resolve(frame.payload ?? frame.result ?? frame);
    return;
  }
  if (frame.type === "event" || frame.event) {
    events.push({ event: frame.event, payload: frame.payload ?? {}, ts: Date.now() });
  }
});

ws.on("error", (error) => {
  console.error(` +
    "`ISSUE2603_ERROR ${String(error)}`" +
    String.raw`);
});

ws.on("open", async () => {
  try {
    await request("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "openclaw-control-ui",
        displayName: "issue2603-live-repro",
        version: "test",
        platform: process.platform,
        mode: "ui",
        instanceId: randomUUID(),
      },
      caps: ["tool-events"],
      scopes: ["operator.read", "operator.write"],
      auth: { token },
    });

    await request("chat.history", { sessionKey, limit: 20 });

    const sentRuns = [];
    // This guard measures websocket run correlation, not tool execution. Keep
    // the prompts tool-free so a model-selected tool cannot replace the reply;
    // the strict empty-final, missing-reply, and history assertions below still
    // fail if the instruction is ignored and the expected reply is lost.
    const messages = [
      ["A2603", "A2603-REPLY", "A2603: First task. Reply exactly A2603-REPLY and nothing else. Do not use tools."],
      ["B2603", "B2603-REPLY", "B2603: Second task. Reply exactly B2603-REPLY and nothing else. Do not use tools."],
      ["C2603", "C2603-REPLY", "C2603: Third task. Reply exactly C2603-REPLY and nothing else. Do not use tools."],
    ];

    for (const [promptToken, replyMarker, message] of messages) {
      const idempotencyKey = randomUUID();
      const response = await request("chat.send", { sessionKey, message, deliver: false, timeoutMs: 90_000, idempotencyKey });
      sentRuns.push({ promptToken, replyMarker, message, runId: response.runId ?? idempotencyKey });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const submittedRunIds = new Set(sentRuns.map((entry) => entry.runId));
    const hasEmptyFinalForSubmittedRun = () => events.some((event) => isOwnSessionChatEvent(event) && event.payload?.state === "final" && submittedRunIds.has(event.payload?.runId) && !textFromMessage(event.payload?.message).trim());

    if (hasEmptyFinalForSubmittedRun()) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } else {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !sawAllReplies(messages.map((entry) => entry[1]))) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    const history = await request("chat.history", { sessionKey, limit: 50 });
    console.log(` +
    "`ISSUE2603_RESULT ${JSON.stringify({ sessionKey, sentRuns, events, historyMessages: history.messages ?? [] })}`" +
    String.raw`);
  } catch (error) {
    console.log(` +
    "`ISSUE2603_RESULT ${JSON.stringify({ error: String(error), events })}`" +
    String.raw`);
  } finally {
    ws.close();
  }
});
`
  );
}

function runLiveIssue2603Repro(sandboxName: string): LiveIssue2603Trace {
  ensureGatewayRunning(sandboxName);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue2603-"));
  const localScript = path.join(tempDir, LIVE_SCRIPT_NAME);
  const remoteScript = `/tmp/${LIVE_SCRIPT_NAME}`;
  fs.writeFileSync(localScript, buildLiveReproScript(), "utf8");

  execOpenShell(["sandbox", "upload", sandboxName, localScript, remoteScript], { timeout: 30_000 });

  const sessionKey = `issue2603-${Date.now()}-${randomUUID()}`;
  const tokenExpression =
    "JSON.parse(require('fs').readFileSync('/sandbox/.openclaw/openclaw.json','utf8')).gateway?.auth?.token||''";
  const output = execInSandbox(
    sandboxName,
    `TOKEN=$(node -e "console.log(${tokenExpression})"); node ${remoteScript} "$TOKEN" ${sessionKey}`,
    { timeout: 180_000 },
  );
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith("ISSUE2603_RESULT "));
  if (!resultLine) throw new Error(`live repro did not emit ISSUE2603_RESULT. Output:\n${output}`);
  return JSON.parse(resultLine.slice("ISSUE2603_RESULT ".length)) as LiveIssue2603Trace;
}

// A capture failure is an attempt that observed no chat signal for its own
// submitted runs: no chat event references a submitted run id and no chat
// event contains a reply token. Chat events that carry neither (for example
// empty aborted events for another attempt's stale runs, as in #4881) are
// infrastructure noise and must not defeat this classification. Any event
// that does reference a submitted run or reply token keeps the strict
// correlation assertions in force.
function looksLikeEventCaptureFailure(repro: LiveIssue2603Trace): boolean {
  if (repro.error || !Array.isArray(repro.sentRuns) || !Array.isArray(repro.events)) return false;

  const analysis = analyzeIssue2603Trace(repro);
  const submittedRunIds = new Set(repro.sentRuns.map((entry) => entry.runId));
  const hasSubmittedRunEvent = analysis.chatEvents.some(
    (event) => typeof event.runId === "string" && submittedRunIds.has(event.runId),
  );
  const hasReplyTokenEvent = repro.sentRuns.some((entry) =>
    analysis.chatEvents.some((event) =>
      containsReplyTokenAllowingWhitespace(event.text, entry.replyMarker),
    ),
  );
  return (
    repro.sentRuns.length === 3 &&
    analysis.conflictingSessionRunEvents.length === 0 &&
    !hasSubmittedRunEvent &&
    !hasReplyTokenEvent
  );
}

// The no-chat-events failure happens when slow inference keeps the submitted
// runs in flight past the reply deadline: OpenClaw accepts the chat.send
// requests, but this websocket client captures no chat stream events for them
// before assertions. The retry uses a fresh session, and because the prior
// attempt's orphaned runs may complete or get aborted *during* the retry —
// broadcasting events with the same reply tokens under the old run ids — the
// analysis is session-scoped so those stale events cannot masquerade as
// uncorrelated replies or block this classifier (#4881, #4742, #4637). The
// source boundary is the pinned OpenClaw 2026.5.x gateway/websocket runtime
// inside the sandbox, so this NemoClaw-side E2E can only keep the #2603/#3145
// correlation assertions stable while preserving signal for real empty-final,
// duplicate-turn, and uncorrelated-reply regressions. Remove this retry when
// OpenClaw exposes a deterministic chat subscription/readiness acknowledgement
// or the 10x nightly sweep no longer shows the capture-failure signature
// without this guard.
function runLiveIssue2603ReproWithEventCaptureRetry(sandboxName: string): LiveIssue2603Run {
  const attempts: LiveIssue2603Trace[] = [];
  let repro = runLiveIssue2603Repro(sandboxName);
  attempts.push(repro);

  if (looksLikeEventCaptureFailure(repro)) {
    console.warn(
      "ISSUE2603_RETRY captured no chat events for the submitted runs; retrying with a fresh session",
    );
    repro = runLiveIssue2603Repro(sandboxName);
    attempts.push(repro);
  }

  return { repro, attempts };
}

describe("OpenClaw TUI chat correlation regression (#2603)", () => {
  it("classifies the observed gateway trace as broken (#2603)", () => {
    const analysis = analyzeIssue2603Trace(capturedIssue2603Trace);

    expect(analysis.emptyFinalsForSubmittedRuns).toEqual([
      {
        runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
        state: "final",
        text: "",
        errorMessage: undefined,
      },
      {
        runId: "32e608a6-aeb4-4615-8416-d656f2bfa92f",
        state: "final",
        text: "",
        errorMessage: undefined,
      },
    ]);
    expect(analysis.uncorrelatedReplies).toEqual([
      {
        replyMarker: "B2603-REPLY",
        expectedRunId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
        actualRunId: "507730cf-8055-424d-87fe-ee9221c34d74",
        state: "final",
      },
      {
        replyMarker: "C2603-REPLY",
        expectedRunId: "32e608a6-aeb4-4615-8416-d656f2bfa92f",
        actualRunId: "5487775f-8d5e-4080-ae91-dcce701868a6",
        state: "final",
      },
    ]);
    expect(analysis.duplicateUserTurns).toEqual([
      { promptToken: "A2603", count: 2 },
      { promptToken: "B2603", count: 2 },
      { promptToken: "C2603", count: 2 },
    ]);
  });

  it("matches deterministic reply tokens split by harmless model whitespace", () => {
    const analysis = analyzeIssue2603Trace({
      sentRuns: [
        {
          promptToken: "A2603",
          replyMarker: "A2603-REPLY",
          runId: "split-reply-run",
          message: "A2603: Reply exactly A2603-REPLY and nothing else.",
        },
      ],
      events: [
        {
          event: "chat",
          payload: {
            runId: "split-reply-run",
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "A\n2603-REPLY" }] },
          },
        },
      ],
      historyMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "A2603: Reply exactly A2603-REPLY and nothing else." }],
        },
      ],
    });

    expect(analysis.missingReplies).toEqual([]);
    expect(analysis.uncorrelatedReplies).toEqual([]);
  });

  it("does not classify a streamed delta plus final for the same run as a duplicate reply", () => {
    const analysis = analyzeIssue2603Trace({
      sentRuns: [
        {
          promptToken: "B2603",
          replyMarker: "B2603-REPLY",
          runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
          message: "B2603: Second task. Reply exactly B2603-REPLY and nothing else.",
        },
      ],
      events: [
        {
          event: "chat",
          payload: {
            runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
          },
        },
        {
          event: "chat",
          payload: {
            runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
          },
        },
      ],
      historyMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "B2603: Second task. Reply exactly B2603-REPLY and nothing else.",
            },
          ],
        },
      ],
    });

    expect(analysis.missingReplies).toEqual([]);
    expect(analysis.duplicateReplies).toEqual([]);
    expect(analysis.uncorrelatedReplies).toEqual([]);
  });

  it("treats hosted-model line wrapping inside reply tokens as the same visible reply", () => {
    const analysis = analyzeIssue2603Trace({
      sentRuns: [
        {
          promptToken: "A2603",
          replyMarker: "A2603-REPLY",
          runId: "run-a",
          message:
            "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
        },
      ],
      events: [
        {
          event: "chat",
          payload: {
            runId: "run-a",
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "A2\n603-REPLY" }] },
          },
        },
      ],
      historyMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
            },
          ],
        },
      ],
    });

    expect(analysis.missingReplies).toEqual([]);
    expect(analysis.duplicateReplies).toEqual([]);
    expect(analysis.uncorrelatedReplies).toEqual([]);
  });

  it("only retries the live repro when no chat events were captured", () => {
    expect(
      looksLikeEventCaptureFailure({
        sentRuns: capturedIssue2603Trace.sentRuns,
        events: [],
        historyMessages: [],
      }),
    ).toBe(true);

    expect(
      looksLikeEventCaptureFailure({
        sentRuns: capturedIssue2603Trace.sentRuns,
        events: [
          {
            event: "chat",
            payload: {
              runId: "18f73be1-3410-46cb-8098-e881bf92c510",
              state: "final",
            },
          },
        ],
        historyMessages: [],
      }),
    ).toBe(false);
  });

  it("excludes chat events from other sessions from correlation analysis", () => {
    const [runA, runB, runC] = capturedIssue2603Trace.sentRuns;
    const analysis = analyzeIssue2603Trace({
      sessionKey: "issue2603-own-session",
      sentRuns: capturedIssue2603Trace.sentRuns,
      events: [
        // Own-session reply for A under the submitted run id: counted.
        {
          event: "chat",
          payload: {
            runId: runA.runId,
            state: "final",
            sessionKey: "issue2603-own-session",
            message: { role: "assistant", content: [{ type: "text", text: "A2603-REPLY" }] },
          },
        },
        // Stale replies for B and C from a previous attempt's session under
        // foreign run ids: excluded instead of reported as uncorrelated.
        {
          event: "chat",
          payload: {
            runId: "0870f90c-1534-49f1-9731-37f04dbd31d1",
            state: "final",
            sessionKey: "issue2603-stale-session",
            message: { role: "assistant", content: [{ type: "text", text: "B2603-REPLY" }] },
          },
        },
        {
          event: "chat",
          payload: {
            runId: "3e9fcfd6-ff8a-43f4-a14f-b1899443badf",
            state: "final",
            sessionKey: "issue2603-stale-session",
            message: { role: "assistant", content: [{ type: "text", text: "C2603-REPLY" }] },
          },
        },
      ],
      historyMessages: [],
    });

    expect(analysis.chatEvents).toHaveLength(1);
    expect(analysis.foreignSessionChatEvents).toHaveLength(2);
    expect(analysis.uncorrelatedReplies).toEqual([]);
    expect(analysis.missingReplies).toEqual([runB.replyMarker, runC.replyMarker]);
  });

  it("keeps chat events without a sessionKey in correlation analysis (fail-open)", () => {
    const [runA] = capturedIssue2603Trace.sentRuns;
    const analysis = analyzeIssue2603Trace({
      sessionKey: "issue2603-own-session",
      sentRuns: [runA],
      events: [
        {
          event: "chat",
          payload: {
            runId: runA.runId,
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "A2603-REPLY" }] },
          },
        },
      ],
      historyMessages: [],
    });

    expect(analysis.chatEvents).toHaveLength(1);
    expect(analysis.missingReplies).toEqual([]);
    expect(analysis.uncorrelatedReplies).toEqual([]);
  });

  it("classifies stale aborted events for foreign runs as a capture failure (#4881)", () => {
    const staleAbortedEvents: GatewayEvent[] = [
      "16aa47fc-9f1a-4a00-94f4-930f92ab0561",
      "4335776b-aab2-4d02-b479-60cefcccf503",
      "1f7b660e-4ef4-46db-9c7f-1c469ced4258",
    ].map((runId) => ({
      event: "chat",
      payload: { runId, state: "aborted" },
    }));
    const repro = {
      sentRuns: capturedIssue2603Trace.sentRuns,
      events: staleAbortedEvents,
      historyMessages: [],
    };

    // Fail-open: without a sessionKey on the events they stay in the
    // analysis, but events that reference neither a submitted run nor a
    // reply token must still classify as a capture failure.
    expect(analyzeIssue2603Trace(repro).chatEvents).toHaveLength(3);
    expect(looksLikeEventCaptureFailure(repro)).toBe(true);
  });

  it("does not classify submitted-run events with a mismatched sessionKey as capture failure", () => {
    const [runA] = capturedIssue2603Trace.sentRuns;
    const repro = {
      sessionKey: "issue2603-own-session",
      sentRuns: capturedIssue2603Trace.sentRuns,
      events: [
        {
          event: "chat",
          payload: {
            runId: runA.runId,
            state: "aborted",
            sessionKey: "issue2603-conflicting-session",
          },
        },
      ],
      historyMessages: [],
    };
    const analysis = analyzeIssue2603Trace(repro);

    expect(analysis.chatEvents).toHaveLength(0);
    expect(analysis.conflictingSessionRunEvents).toEqual([
      {
        runId: runA.runId,
        state: "aborted",
        sessionKey: "issue2603-conflicting-session",
        text: "",
        errorMessage: undefined,
      },
    ]);
    expect(looksLikeEventCaptureFailure(repro)).toBe(false);
  });

  it("does not classify a whitespace-split reply token under a non-submitted run as a capture failure", () => {
    const [, runB] = capturedIssue2603Trace.sentRuns;
    const repro = {
      sentRuns: capturedIssue2603Trace.sentRuns,
      events: [
        {
          event: "chat",
          payload: {
            runId: "0870f90c-1534-49f1-9731-37f04dbd31d1",
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "B\n2603-REPLY" }] },
          },
        },
      ],
      historyMessages: [],
    };

    expect(runB.replyMarker).toBe("B2603-REPLY");
    expect(analyzeIssue2603Trace(repro).chatEvents).toHaveLength(1);
    expect(looksLikeEventCaptureFailure(repro)).toBe(false);
  });

  it("keeps the live repro prompts deterministic and tool-free", () => {
    const script = buildLiveReproScript();

    expect(script).not.toContain("Wait 8 seconds");
    expect(script).toContain(
      "A2603: First task. Reply exactly A2603-REPLY and nothing else. Do not use tools.",
    );
    expect(script).toContain(
      "B2603: Second task. Reply exactly B2603-REPLY and nothing else. Do not use tools.",
    );
    expect(script).toContain(
      "C2603: Third task. Reply exactly C2603-REPLY and nothing else. Do not use tools.",
    );
  });

  it.runIf(process.env[LIVE_REPRO_ENV] === "1")(
    "keeps rapid live TUI/webchat sends correlated on a real OpenClaw sandbox",
    () => {
      const sandboxName = process.env[LIVE_SANDBOX_ENV] || "hclaw";
      const { repro, attempts } = runLiveIssue2603ReproWithEventCaptureRetry(sandboxName);
      if (repro.error) throw new Error(`live repro failed before assertions: ${repro.error}`);

      const analysis = analyzeIssue2603Trace(repro);
      const failureSummary = buildFailureSummary(analysis, repro, attempts);
      // An infrastructure capture failure (no chat events for the submitted
      // runs) is gateway/inference latency at the live repro boundary, not a
      // #2603/#3145 correlation regression — surface it as its own assertion.
      expect(
        looksLikeEventCaptureFailure(repro),
        `INFRASTRUCTURE CAPTURE FAILURE: ${attempts.length} attempt(s) observed no chat events ` +
          `for their submitted runs. This signature is gateway/inference latency at the live repro ` +
          `boundary, not a #2603/#3145 correlation regression. ${failureSummary}`,
      ).toBe(false);
      expect(analysis.emptyFinalsForSubmittedRuns, failureSummary).toEqual([]);
      expect(analysis.missingReplies, failureSummary).toEqual([]);
      expect(analysis.duplicateReplies, failureSummary).toEqual([]);
      expect(analysis.uncorrelatedReplies, failureSummary).toEqual([]);
      expect(analysis.missingUserTurns, failureSummary).toEqual([]);
      expect(analysis.duplicateUserTurns, failureSummary).toEqual([]);
    },
    370_000,
  );
});
