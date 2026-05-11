// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIVE_REPRO_ENV = "NEMOCLAW_ISSUE_2603_LIVE";
const LIVE_SANDBOX_ENV = "NEMOCLAW_ISSUE_2603_SANDBOX";
const LIVE_SCRIPT_NAME = "openclaw-issue2603-chat-correlation.cjs";

const ISSUE_2603_FIX_EXPECTATIONS = [
  "no empty final event for a submitted chat.send run",
  "each visible reply remains correlated to the chat.send run that accepted the prompt",
  "chat.history contains one user turn per submitted prompt",
];

type ChatMessage = {
  role?: string;
  text?: unknown;
  content?: unknown;
};

type ChatEventPayload = {
  runId?: string;
  state?: string;
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
  replyToken: string;
  runId: string;
  message: string;
};

type Issue2603Trace = {
  sentRuns: SentRun[];
  events: GatewayEvent[];
  historyMessages: ChatMessage[];
};

type CompactChatEvent = {
  runId?: string;
  state?: string;
  text: string;
  errorMessage?: string;
};

type UncorrelatedReply = {
  replyToken: string;
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
  emptyFinalsForSubmittedRuns: CompactChatEvent[];
  uncorrelatedReplies: UncorrelatedReply[];
  duplicateUserTurns: DuplicateUserTurn[];
};

type LiveIssue2603Trace = Issue2603Trace & { error?: string };

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

function compactChatEvents(events: GatewayEvent[]): CompactChatEvent[] {
  return events
    .filter((event) => event.event === "chat")
    .map((event) => ({
      runId: event.payload?.runId,
      state: event.payload?.state,
      text: textFromMessage(event.payload?.message),
      errorMessage: event.payload?.errorMessage,
    }));
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function analyzeIssue2603Trace({ sentRuns, events, historyMessages }: Issue2603Trace): Issue2603Analysis {
  const submittedRunIds = new Set(sentRuns.map((entry) => entry.runId));
  const expectedRunByReplyToken = new Map(sentRuns.map((entry) => [entry.replyToken, entry.runId]));
  const chatEvents = compactChatEvents(events);

  const emptyFinalsForSubmittedRuns = chatEvents.filter(
    (event) =>
      event.state === "final" &&
      typeof event.runId === "string" &&
      submittedRunIds.has(event.runId) &&
      !event.text.trim(),
  );

  const uncorrelatedReplies: UncorrelatedReply[] = [];
  for (const [replyToken, expectedRunId] of expectedRunByReplyToken) {
    for (const event of chatEvents) {
      if (!event.text.includes(replyToken)) continue;
      if (event.runId !== expectedRunId) {
        uncorrelatedReplies.push({
          replyToken,
          expectedRunId,
          actualRunId: event.runId,
          state: event.state,
        });
      }
    }
  }

  const userPromptCounts = countBy(
    historyMessages
      .filter((message) => message?.role === "user")
      .map((message) => textFromMessage(message).trim())
      .filter(Boolean),
  );
  const duplicateUserTurns = sentRuns
    .map((entry) => ({
      promptToken: entry.promptToken,
      count: userPromptCounts.get(entry.message) ?? 0,
    }))
    .filter((entry) => entry.count > 1);

  return {
    chatEvents,
    emptyFinalsForSubmittedRuns,
    uncorrelatedReplies,
    duplicateUserTurns,
  };
}

function buildFailureSummary(analysis: Issue2603Analysis): string {
  return JSON.stringify(
    {
      expectations: ISSUE_2603_FIX_EXPECTATIONS,
      emptyFinalsForSubmittedRuns: analysis.emptyFinalsForSubmittedRuns,
      uncorrelatedReplies: analysis.uncorrelatedReplies,
      duplicateUserTurns: analysis.duplicateUserTurns,
      chatEvents: analysis.chatEvents,
    },
    null,
    2,
  );
}

const capturedIssue2603Trace: Issue2603Trace = {
  sentRuns: [
    {
      promptToken: "A2603",
      replyToken: "A2603-REPLY",
      runId: "18f73be1-3410-46cb-8098-e881bf92c510",
      message:
        "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else.",
    },
    {
      promptToken: "B2603",
      replyToken: "B2603-REPLY",
      runId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
      message: "B2603: Second task. Reply exactly B2603-REPLY and nothing else.",
    },
    {
      promptToken: "C2603",
      replyToken: "C2603-REPLY",
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

function execInSandbox(sandboxName: string, command: string, options: ExecStringOptions = {}): string {
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

function sawAllReplies(replyTokens) {
  return replyTokens.every((token) => events.some((event) => event.event === "chat" && textFromMessage(event.payload?.message).includes(token)));
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
      minProtocol: 3,
      maxProtocol: 3,
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
    const messages = [
      ["A2603", "A2603-REPLY", "A2603: First task. Wait 8 seconds, then reply exactly A2603-REPLY and nothing else."],
      ["B2603", "B2603-REPLY", "B2603: Second task. Reply exactly B2603-REPLY and nothing else."],
      ["C2603", "C2603-REPLY", "C2603: Third task. Reply exactly C2603-REPLY and nothing else."],
    ];

    for (const [promptToken, replyToken, message] of messages) {
      const idempotencyKey = randomUUID();
      const response = await request("chat.send", { sessionKey, message, deliver: false, timeoutMs: 90_000, idempotencyKey });
      sentRuns.push({ promptToken, replyToken, message, runId: response.runId ?? idempotencyKey });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const submittedRunIds = new Set(sentRuns.map((entry) => entry.runId));
    const hasEmptyFinalForSubmittedRun = () => events.some((event) => event.event === "chat" && event.payload?.state === "final" && submittedRunIds.has(event.payload?.runId) && !textFromMessage(event.payload?.message).trim());

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

  const sessionKey = `issue2603-${Date.now()}`;
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

describe("OpenClaw TUI chat correlation regression (#2603)", () => {
  it("classifies the observed #2603 gateway trace as broken", () => {
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
        replyToken: "B2603-REPLY",
        expectedRunId: "a32dc5a4-9b45-4109-9b17-2fcd35787d0c",
        actualRunId: "507730cf-8055-424d-87fe-ee9221c34d74",
        state: "final",
      },
      {
        replyToken: "C2603-REPLY",
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

  it.runIf(process.env[LIVE_REPRO_ENV] === "1")(
    "keeps rapid live TUI/webchat sends correlated on a real OpenClaw sandbox",
    () => {
      const sandboxName = process.env[LIVE_SANDBOX_ENV] || "hclaw";
      const repro = runLiveIssue2603Repro(sandboxName);
      if (repro.error) throw new Error(`live repro failed before assertions: ${repro.error}`);

      const analysis = analyzeIssue2603Trace(repro);
      const failureSummary = buildFailureSummary(analysis);
      expect(analysis.emptyFinalsForSubmittedRuns, failureSummary).toEqual([]);
      expect(analysis.uncorrelatedReplies, failureSummary).toEqual([]);
      expect(analysis.duplicateUserTurns, failureSummary).toEqual([]);
    },
    190_000,
  );
});
