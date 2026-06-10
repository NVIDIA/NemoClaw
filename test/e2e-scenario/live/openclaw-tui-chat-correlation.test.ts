// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live E2E: OpenClaw TUI/chat correlation regression guard (#2603 + #3145).
 *
 * Focused coverage slice for the protocol/history assertions currently carried
 * by `test/e2e/test-openclaw-tui-chat-correlation.sh`. The retained bash lane
 * remains authoritative for full legacy closeout; this file only adds direct
 * Vitest coverage for the websocket contract.
 *
 * Covered here: ordered, non-empty, correlated replies plus ordered,
 * non-duplicated user turns against a real cloud OpenClaw sandbox. TUI
 * rendering indicators and visible tool-call status stay out of scope.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

// Reuses the standard ubuntu-repo-docker environment with the
// `cloud-openclaw` onboarding profile (already in
// `runtime-support.ts:SUPPORTED_ONBOARDING`). We don't route through the
// scenario registry because the registry is keyed on steady-state
// expected-state probes; this test's regression-target probes are bespoke
// websocket-trace assertions that don't fit the
// `from(env) → from(state, instance)` model.
const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");

const SANDBOX_NAME = "e2e-openclaw-tui-corr";

// The legacy bash script currently pins 2026.5.27 as the post-fix
// regression-guard version for #2603 + #3145. Historical buggy builds
// were older; this live guard asserts the fixed protocol/history contract
// stays stable on the pinned OpenClaw carried by the retained bash lane.
// Override via env so future pin bumps do not require a code edit.
const EXPECTED_OPENCLAW_VERSION =
  process.env.E2E_OPENCLAW_TUI_CORRELATION_PINNED_VERSION ?? "2026.5.27";

const LIVE_SCRIPT_NAME = "openclaw-issue2603-chat-correlation.cjs";
const SANDBOX_GATEWAY_PORT = 18789;

// ─── Trace analyzer types + helpers (mirrored from
//     test/openclaw-tui-chat-correlation.test.ts so the live test is
//     self-contained; kept in lockstep with the unit-test analyzer
//     via review).
//     ─────────────────────────────────────────────────────────────────

type ChatMessage = { role?: string; text?: unknown; content?: unknown };
type ChatEventPayload = {
  runId?: string;
  state?: string;
  message?: ChatMessage;
  errorMessage?: string;
};
type GatewayEvent = { event?: string; payload?: ChatEventPayload; ts?: number };
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
type DuplicateUserTurn = { promptToken: string; count: number };
type Issue2603Analysis = {
  chatEvents: CompactChatEvent[];
  emptyFinalsForSubmittedRuns: CompactChatEvent[];
  missingReplies: string[];
  duplicateReplies: { replyToken: string; count: number }[];
  uncorrelatedReplies: UncorrelatedReply[];
  finalReplyOrder: string[];
  userTurnOrder: string[];
  missingUserTurns: DuplicateUserTurn[];
  duplicateUserTurns: DuplicateUserTurn[];
};
type LiveIssue2603Trace = Issue2603Trace & { error?: string };

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof (part as { text?: unknown }).text === "string")
        return (part as { text: string }).text;
      if (typeof (part as { thinking?: unknown }).thinking === "string")
        return (part as { thinking: string }).thinking;
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

function analyzeIssue2603Trace({
  sentRuns,
  events,
  historyMessages,
}: Issue2603Trace): Issue2603Analysis {
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
  const visibleReplyCounts = new Map<string, number>();
  const finalReplyCounts = new Map<string, number>();
  for (const [replyToken, expectedRunId] of expectedRunByReplyToken) {
    for (const event of chatEvents) {
      if (!event.text.includes(replyToken)) continue;
      visibleReplyCounts.set(replyToken, (visibleReplyCounts.get(replyToken) ?? 0) + 1);
      if (event.state === "final") {
        finalReplyCounts.set(replyToken, (finalReplyCounts.get(replyToken) ?? 0) + 1);
      }
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
  const missingReplies = sentRuns
    .map((entry) => entry.replyToken)
    .filter((replyToken) => !visibleReplyCounts.has(replyToken));
  const duplicateReplies = sentRuns
    .map((entry) => ({
      replyToken: entry.replyToken,
      count: finalReplyCounts.get(entry.replyToken) ?? 0,
    }))
    .filter((entry) => entry.count > 1);
  const finalReplyOrder = chatEvents
    .filter((event) => event.state === "final")
    .flatMap((event) =>
      sentRuns
        .filter((entry) => event.text.includes(entry.replyToken))
        .map((entry) => entry.replyToken),
    );

  const userMessages = historyMessages
    .filter((message) => message?.role === "user")
    .map((message) => textFromMessage(message).trim())
    .filter(Boolean);
  const userPromptCounts = countBy(userMessages);
  const userTurnCounts = sentRuns.map((entry) => ({
    promptToken: entry.promptToken,
    count: userPromptCounts.get(entry.message) ?? 0,
  }));
  const userTurnOrder = userMessages.flatMap((message) =>
    sentRuns.filter((entry) => entry.message === message).map((entry) => entry.promptToken),
  );
  const missingUserTurns = userTurnCounts.filter((entry) => entry.count < 1);
  const duplicateUserTurns = userTurnCounts.filter((entry) => entry.count > 1);

  return {
    chatEvents,
    emptyFinalsForSubmittedRuns,
    missingReplies,
    duplicateReplies,
    uncorrelatedReplies,
    finalReplyOrder,
    userTurnOrder,
    missingUserTurns,
    duplicateUserTurns,
  };
}

// The zero-chat-events failure is an observability race at the live
// repro boundary: OpenClaw accepts the chat.send requests, but the
// websocket client captures no chat stream events before assertions.
// The source boundary is the pinned OpenClaw 2026.5.x gateway runtime,
// so this NemoClaw-side E2E retries once on a fresh session before
// asserting. Remove when OpenClaw exposes a deterministic chat
// subscription/readiness ack or the 10x sweep stops flagging this
// signature without the guard.
function looksLikeEventCaptureFailure(repro: LiveIssue2603Trace): boolean {
  if (repro.error || !Array.isArray(repro.sentRuns) || !Array.isArray(repro.events)) return false;
  const analysis = analyzeIssue2603Trace(repro);
  return (
    repro.sentRuns.length === 3 &&
    analysis.chatEvents.length === 0 &&
    analysis.emptyFinalsForSubmittedRuns.length === 0 &&
    analysis.duplicateReplies.length === 0 &&
    analysis.uncorrelatedReplies.length === 0 &&
    analysis.missingReplies.length === repro.sentRuns.length
  );
}

// ─── In-sandbox websocket repro driver ─────────────────────────────

function buildLiveReproScript(): string {
  // Verbatim port of the script in test/openclaw-tui-chat-correlation.test.ts
  // (loaded at runtime from /usr/local/lib/node_modules/openclaw/package.json
  // so it picks up the in-sandbox OpenClaw `ws` dependency without the
  // sandbox needing its own npm install).
  return (
    String.raw`
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const openClawRequire = createRequire("/usr/local/lib/node_modules/openclaw/package.json");
const WebSocket = openClawRequire("ws");

const token = process.argv[2];
const sessionKey = process.argv[3];
const gatewayPort = process.env.ISSUE2603_GATEWAY_PORT || "18789";
const ws = new WebSocket("ws://127.0.0.1:" + gatewayPort + "/ws", { headers: { Origin: "http://127.0.0.1:" + gatewayPort } });
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
    const messages = [
      [
        "A2603",
        "A2603-REPLY",
        "A2603: First task. Reply exactly A2603-REPLY and nothing else. Do not use tools.",
      ],
      [
        "B2603",
        "B2603-REPLY",
        "B2603: Second task. Reply exactly B2603-REPLY and nothing else. Do not use tools.",
      ],
      [
        "C2603",
        "C2603-REPLY",
        "C2603: Third task. Reply exactly C2603-REPLY and nothing else. Do not use tools.",
      ],
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

// Idempotent: returns 0 if the in-sandbox gateway already responds to
// /health, otherwise launches `openclaw gateway run --port 18789`,
// sleeps 10s, and re-checks. Mirrors the legacy `ensureGatewayRunning`
// helper from test/openclaw-tui-chat-correlation.test.ts.
async function ensureSandboxGatewayRunning(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const healthScript = [
    `curl -fsS http://127.0.0.1:${SANDBOX_GATEWAY_PORT}/health >/dev/null 2>&1`,
    `|| (nohup openclaw gateway run --port ${SANDBOX_GATEWAY_PORT} >/tmp/openclaw-issue2603-gateway.log 2>&1 & sleep 10)`,
    `&& curl -fsS http://127.0.0.1:${SANDBOX_GATEWAY_PORT}/health >/dev/null`,
  ].join(" ");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(healthScript), {
    artifactName: "ensure-sandbox-gateway-running",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `in-sandbox OpenClaw gateway did not become reachable on port ${SANDBOX_GATEWAY_PORT}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function runLiveIssue2603Repro(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<LiveIssue2603Trace> {
  await ensureSandboxGatewayRunning(sandbox, sandboxName);

  const tmp = mkdtempSync(join(tmpdir(), "nemoclaw-issue2603-"));
  const localScript = join(tmp, LIVE_SCRIPT_NAME);
  const remoteScript = `/tmp/${LIVE_SCRIPT_NAME}`;
  writeFileSync(localScript, buildLiveReproScript(), "utf8");
  try {
    const upload = await sandbox.upload(sandboxName, localScript, remoteScript, {
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (upload.exitCode !== 0) {
      throw new Error(
        `failed to upload live repro script\nstdout:\n${upload.stdout}\nstderr:\n${upload.stderr}`,
      );
    }

    const sessionKey = `issue2603-${Date.now()}-${randomUUID()}`;
    const tokenExpression =
      "JSON.parse(require('fs').readFileSync('/sandbox/.openclaw/openclaw.json','utf8')).gateway?.auth?.token||''";
    const driver = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript(
        `TOKEN=$(node -e "console.log(${tokenExpression})"); ISSUE2603_GATEWAY_PORT=${SANDBOX_GATEWAY_PORT} node ${remoteScript} "$TOKEN" ${sessionKey}`,
      ),
      {
        artifactName: "live-issue2603-repro",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 180_000,
      },
    );

    const resultLine = driver.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("ISSUE2603_RESULT "));
    if (!resultLine) {
      throw new Error(
        `live repro did not emit ISSUE2603_RESULT.\nstdout:\n${driver.stdout}\nstderr:\n${driver.stderr}`,
      );
    }
    return JSON.parse(resultLine.slice("ISSUE2603_RESULT ".length)) as LiveIssue2603Trace;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runLiveIssue2603ReproWithEventCaptureRetry(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<{ repro: LiveIssue2603Trace; attempts: LiveIssue2603Trace[] }> {
  const attempts: LiveIssue2603Trace[] = [];
  let repro = await runLiveIssue2603Repro(sandbox, sandboxName);
  attempts.push(repro);
  if (looksLikeEventCaptureFailure(repro)) {
    console.warn(
      "ISSUE2603_RETRY captured zero chat events after accepted sends; retrying with a fresh session",
    );
    repro = await runLiveIssue2603Repro(sandbox, sandboxName);
    attempts.push(repro);
  }
  return { repro, attempts };
}

// ─── The live regression guard ─────────────────────────────────────

test(
  "openclaw-tui-chat-correlation: rapid TUI/webchat sends stay correlated on a real OpenClaw sandbox (#2603 + #3145)",
  async ({ artifacts, environment, onboard, sandbox, secrets }) => {
    secrets.required("NVIDIA_API_KEY");

    await artifacts.writeJson("scenario.json", {
      id: "openclaw-tui-chat-correlation",
      runner: "vitest",
      boundary: "openclaw-gateway-websocket",
      issues: ["#2603", "#3145"],
      ownerIssue: "#4347",
      pinnedOpenClawVersion: EXPECTED_OPENCLAW_VERSION,
    });

    // Setup ────────────────────────────────────────────────────────
    const ready = await environment.assertReady(ENVIRONMENT);
    const instance: NemoClawInstance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
    });

    // Assertion: openclaw-version-pinned. The regression target only
    // reproduces against the 2026.5.27 build; if the sandbox installed
    // a different version, the rest of the test is meaningless.
    //
    // Every sandbox.* call must pass `env: buildAvailabilityProbeEnv()`:
    // ShellProbe.run spawns with an empty env when none is provided,
    // and openshell needs PATH (~/.local/bin on Ubuntu runners) to
    // resolve. Phase fixtures (state-validation, runtime, lifecycle)
    // all follow this same convention.
    const versionResult = await sandbox.exec(instance.sandboxName, ["openclaw", "--version"], {
      artifactName: "openclaw-version-pinned",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(versionResult.exitCode).toBe(0);
    expect(
      versionResult.stdout,
      `expected fresh sandbox to run OpenClaw ${EXPECTED_OPENCLAW_VERSION}; ` +
        `update E2E_OPENCLAW_TUI_CORRELATION_PINNED_VERSION when bumping. ` +
        `actual: ${versionResult.stdout}`,
    ).toContain(EXPECTED_OPENCLAW_VERSION);

    // Drive the websocket repro and capture the trace ──────────────
    const { repro, attempts } = await runLiveIssue2603ReproWithEventCaptureRetry(
      sandbox,
      instance.sandboxName,
    );

    await artifacts.writeJson("issue2603-trace.json", {
      sentRuns: repro.sentRuns,
      eventCount: repro.events?.length ?? 0,
      attempts: attempts.length,
      error: repro.error,
    });

    if (repro.error) {
      throw new Error(`live repro failed before assertions: ${repro.error}`);
    }

    const analysis = analyzeIssue2603Trace(repro);
    const failureSummary = JSON.stringify(
      {
        sentRuns: repro.sentRuns,
        eventCount: repro.events.length,
        analysis,
      },
      null,
      2,
    );

    // #2603 protocol/history subset — every submitted run produces a
    // non-empty final, every reply correlates to the run that accepted
    // the prompt, and observed user turns remain in submitted A/B/C order.
    // TUI rendering indicators and visible tool-call status are covered
    // outside this websocket-level guard.
    expect(analysis.emptyFinalsForSubmittedRuns, failureSummary).toEqual([]);
    expect(analysis.uncorrelatedReplies, failureSummary).toEqual([]);
    expect(analysis.userTurnOrder, failureSummary).toEqual(
      repro.sentRuns.map((entry) => entry.promptToken),
    );

    // #3145 contract — no missing replies, no duplicate replies, no
    // out-of-order final replies, and no history corruption (missing or
    // duplicated user turns).
    expect(analysis.missingReplies, failureSummary).toEqual([]);
    expect(analysis.duplicateReplies, failureSummary).toEqual([]);
    expect(analysis.finalReplyOrder, failureSummary).toEqual(
      repro.sentRuns.map((entry) => entry.replyToken),
    );
    expect(analysis.missingUserTurns, failureSummary).toEqual([]);
    expect(analysis.duplicateUserTurns, failureSummary).toEqual([]);
  },
  // 75-minute budget mirrors the retained `openclaw-tui-chat-correlation-e2e`
  // job in nightly-e2e.yaml: cloud onboarding + sandbox provisioning +
  // gateway warmup + the 120-second wait-for-replies window + retry.
  75 * 60_000,
);
