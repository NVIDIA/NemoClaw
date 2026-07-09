// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live E2E: OpenClaw TUI/chat correlation regression guards (#2603 + #3145 + #6194).
 *
 * Focused coverage slice for the protocol/history assertions migrated from
 * entrypoint now hands off to this live target.
 *
 * Covered here: ordered, non-empty, correlated replies plus ordered,
 * non-duplicated user turns against a real cloud OpenClaw sandbox, then
 * terminal TUI input after the visible `connected idle` state.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containsReplyTokenAllowingWhitespace } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { ubuntuRepoDocker } from "../registry/matrix.ts";
import { stripTerminalControl } from "../support/issue-4434-tui-capture.ts";
import {
  buildIssue6194OpenShellApprovalExpectScript,
  buildIssue6194TuiExpectScript,
  ISSUE6194_NETWORK_APPROVAL_ENDPOINT,
  ISSUE6194_NETWORK_APPROVAL_HOST,
  ISSUE6194_OPENSHELL_APPROVAL_TIMEOUT_BUFFER_SEC,
  ISSUE6194_TUI_SESSION_PREFIX,
  ISSUE6194_TUI_TIMEOUT_SEC,
  precreateIssue6194Capture,
  readIssue6194Capture,
} from "./issue-6194-tui-expect.ts";

// Reuses the standard ubuntu-repo-docker environment with the
// `cloud-openclaw` onboarding profile (already in
// `runtime-support.ts:SUPPORTED_ONBOARDING`). We don't route through the
// target registry because the registry is keyed on steady-state
// expected-state probes; this test's regression-target probes are bespoke
// websocket-trace assertions that don't fit the
// `from(env) → from(state, instance)` model.
const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");

const SANDBOX_NAME = "e2e-openclaw-tui-corr";
// OpenClaw 2026.6.10 is the post-fix regression-guard version for #2603 + #3145.
// Historical buggy builds were older; this live guard asserts the fixed
// protocol/history contract stays stable on the pinned OpenClaw version.
// Override via env so future pin bumps do not require a code edit.
const EXPECTED_OPENCLAW_VERSION =
  process.env.E2E_OPENCLAW_TUI_CORRELATION_PINNED_VERSION ?? "2026.6.10";

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
  replyMarker: string;
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
  replyMarker: string;
  expectedRunId: string;
  actualRunId?: string;
  state?: string;
};
type DuplicateUserTurn = { promptToken: string; count: number };
type Issue2603Analysis = {
  chatEvents: CompactChatEvent[];
  emptyFinalsForSubmittedRuns: CompactChatEvent[];
  missingReplies: string[];
  duplicateReplies: { replyMarker: string; count: number }[];
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
  const expectedRunByReplyMarker = new Map(
    sentRuns.map((entry) => [entry.replyMarker, entry.runId]),
  );
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
  const finalReplyOrder = chatEvents
    .filter((event) => event.state === "final")
    .flatMap((event) =>
      sentRuns
        .filter((entry) => containsReplyTokenAllowingWhitespace(event.text, entry.replyMarker))
        .map((entry) => entry.replyMarker),
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

function compactReplyTokenText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function sawAllReplies(replyMarkers) {
  return replyMarkers.every((marker) => events.some((event) => event.event === "chat" && compactReplyTokenText(textFromMessage(event.payload?.message)).includes(compactReplyTokenText(marker))));
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

    for (const [promptToken, replyMarker, message] of messages) {
      const idempotencyKey = randomUUID();
      const response = await request("chat.send", { sessionKey, message, deliver: false, timeoutMs: 90_000, idempotencyKey });
      sentRuns.push({ promptToken, replyMarker, message, runId: response.runId ?? idempotencyKey });
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
  "openclaw-tui-chat-correlation keeps rapid sends correlated and accepts terminal input after connected idle (#2603, #3145, #6194)",
  async ({ artifacts, environment, host, onboard, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");

    await artifacts.target.declare({
      id: "openclaw-tui-chat-correlation",
      boundary: [
        "openclaw-gateway-websocket",
        "openclaw-tui-terminal-after-connected-idle",
        "openshell-network-rule-terminal-approval",
      ],
      issues: ["#2603", "#3145", "#6194"],
      ownerIssue: "#4347",
      pinnedOpenClawVersion: EXPECTED_OPENCLAW_VERSION,
      historicalReproScope:
        "#6194 reported NemoClaw v0.0.72 as the known-bad release; this live target guards the current branch against the same post-idle TUI regression instead of reinstalling the old bad version.",
    });

    // Setup ────────────────────────────────────────────────────────
    const ready = await environment.assertReady(ENVIRONMENT);
    const instance: NemoClawInstance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
    });

    // Assertion: openclaw-version-pinned. The issue reporter used NemoClaw
    // v0.0.72 to demonstrate the historical failure. Reinstalling that known
    // bad release in PR CI would prove the old bug, not the proposed guard.
    // This target provisions the current branch and validates the bundled
    // OpenClaw build before exercising the same post-connected-idle terminal
    // paths so future changes cannot reintroduce #6194. OpenShell's separate
    // terminal UI owns network-rule approvals; this OpenClaw TUI flow must not
    // rely on a hosted model choosing a network tool that may not exist.
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

    // Drive the #6194 terminal flow before websocket correlation so the
    // post-idle TUI regression guard is independent of any gateway/session
    // state created by the #2603/#3145 websocket replay below. Keeping both
    // flows in this target reuses the same provisioned sandbox and avoids a
    // second long cloud setup for a tests-only PR.
    const captureDir = mkdtempSync(join(tmpdir(), "nemoclaw-issue6194-tui-"));
    const captureFile = join(captureDir, "openclaw-tui-capture.log");
    const expectScript = artifacts.pathFor("issue6194-openclaw-tui.expect");
    const tuiSession = `${ISSUE6194_TUI_SESSION_PREFIX}-${instance.sandboxName}-${Date.now()}-${randomUUID()}`;
    precreateIssue6194Capture(captureFile);
    writeFileSync(expectScript, buildIssue6194TuiExpectScript(), { mode: 0o700 });
    try {
      const tui = await host.command("expect", [expectScript], {
        artifactName: "issue6194-openclaw-tui-post-idle",
        env: {
          ...sandboxAccessEnv(),
          NEMOCLAW_ISSUE_6194_SANDBOX: instance.sandboxName,
          NEMOCLAW_ISSUE_6194_CAPTURE: captureFile,
          NEMOCLAW_ISSUE_6194_SESSION: tuiSession,
          NEMOCLAW_ISSUE_6194_TUI_TIMEOUT: String(ISSUE6194_TUI_TIMEOUT_SEC),
        },
        redactionValues: [apiKey],
        timeoutMs: (ISSUE6194_TUI_TIMEOUT_SEC + 30) * 1000,
      });
      const tuiCapture = readIssue6194Capture(captureFile);
      const rawCapture = tuiCapture.contents;
      const redactedCapture = secrets.redact(rawCapture, [apiKey]);
      const plainCapture = stripTerminalControl(redactedCapture);
      const combined = `${resultText(tui)}\n${plainCapture}`;
      const redactedArtifact = await artifacts.writeText(
        "issue6194-openclaw-tui-capture.log",
        redactedCapture,
      );
      const plainArtifact = await artifacts.writeText(
        "issue6194-openclaw-tui-capture.plain.log",
        plainCapture,
      );
      await artifacts.writeJson("issue6194-target-result.json", {
        id: "issue-6194-tui-post-connected-idle",
        expectExitCode: tui.exitCode,
        captureExists: tuiCapture.exists,
        captureNonEmpty: plainCapture.length > 0,
        captureHasMarkers: plainCapture.includes("ISSUE6194_MARK"),
        connectedIdleInitial: combined.includes("ISSUE6194_MARK connected_idle_initial"),
        chatReply: combined.includes("ISSUE6194_MARK chat_reply"),
        connectedIdleAfterChat: combined.includes("ISSUE6194_MARK connected_idle_after_chat"),
        slashStatusOutput: combined.includes("ISSUE6194_MARK slash_status_output"),
        connectedIdleAfterStatus: combined.includes("ISSUE6194_MARK connected_idle_after_status"),
        cleanExit: combined.includes("ISSUE6194_MARK clean_exit"),
      });

      expect(tuiCapture.exists, "TUI expect capture must exist").toBe(true);
      expect(plainCapture.length, "TUI expect capture must not be empty").toBeGreaterThan(0);
      expect(plainCapture, "TUI expect capture must include expect-script markers").toContain(
        "ISSUE6194_MARK",
      );
      expect(
        readFileSync(redactedArtifact, "utf8"),
        "published ANSI capture must redact API key",
      ).not.toContain(apiKey);
      expect(
        readFileSync(plainArtifact, "utf8"),
        "published plain capture must redact API key",
      ).not.toContain(apiKey);
      expect(tui.exitCode, combined).toBe(0);
      expect(combined, "TUI must reach connected idle before post-idle input").toContain(
        "ISSUE6194_MARK connected_idle_initial",
      );
      expect(combined, "post-idle chat must return a visible reply before timeout").toContain(
        "ISSUE6194_MARK chat_reply",
      );
      expect(
        combined,
        "TUI must return to connected idle after the post-idle chat reply",
      ).toContain("ISSUE6194_MARK connected_idle_after_chat");
      expect(
        combined,
        "post-idle slash command must render status output before timeout",
      ).toContain("ISSUE6194_MARK slash_status_output");
      expect(combined, "rendered status output must include its sandbox field").toMatch(
        /NemoClaw Status[\s\S]*Sandbox:/u,
      );
      expect(combined, "TUI must return to connected idle after /nemoclaw status").toContain(
        "ISSUE6194_MARK connected_idle_after_status",
      );
      expect(combined, "post-idle Ctrl+C must close the TUI session").toContain(
        "ISSUE6194_MARK clean_exit",
      );

      // OpenShell's terminal UI owns network-rule approval. Exercise that
      // boundary separately with a direct sandbox curl so hosted models that
      // expose no network tools cannot make this assertion nondeterministic.
      const approvalCaptureFile = join(captureDir, "openshell-approval-capture.log");
      const triggerCaptureFile = join(captureDir, "openshell-network-trigger.log");
      const ruleCaptureFile = join(captureDir, "openshell-pending-rule.log");
      const policyCaptureFile = join(captureDir, "openshell-policy-retry.log");
      const approvalExpectScript = artifacts.pathFor("issue6194-openshell-approval.expect");
      precreateIssue6194Capture(approvalCaptureFile);
      precreateIssue6194Capture(triggerCaptureFile);
      precreateIssue6194Capture(ruleCaptureFile);
      precreateIssue6194Capture(policyCaptureFile);
      writeFileSync(approvalExpectScript, buildIssue6194OpenShellApprovalExpectScript(), {
        mode: 0o700,
      });
      const approval = await host.command("expect", [approvalExpectScript], {
        artifactName: "issue6194-openshell-network-approval",
        env: {
          ...sandboxAccessEnv(),
          NEMOCLAW_ISSUE_6194_SANDBOX: instance.sandboxName,
          NEMOCLAW_ISSUE_6194_CAPTURE: approvalCaptureFile,
          NEMOCLAW_ISSUE_6194_TRIGGER_CAPTURE: triggerCaptureFile,
          NEMOCLAW_ISSUE_6194_RULE_CAPTURE: ruleCaptureFile,
          NEMOCLAW_ISSUE_6194_POLICY_CAPTURE: policyCaptureFile,
          NEMOCLAW_ISSUE_6194_NETWORK_ENDPOINT: ISSUE6194_NETWORK_APPROVAL_ENDPOINT,
          NEMOCLAW_ISSUE_6194_NETWORK_HOST: ISSUE6194_NETWORK_APPROVAL_HOST,
          NEMOCLAW_ISSUE_6194_TUI_TIMEOUT: String(ISSUE6194_TUI_TIMEOUT_SEC),
        },
        redactionValues: [apiKey],
        timeoutMs:
          (ISSUE6194_TUI_TIMEOUT_SEC + ISSUE6194_OPENSHELL_APPROVAL_TIMEOUT_BUFFER_SEC) * 1000,
      });
      const approvalCapture = readIssue6194Capture(approvalCaptureFile);
      const triggerCapture = readIssue6194Capture(triggerCaptureFile);
      const ruleCapture = readIssue6194Capture(ruleCaptureFile);
      const policyCapture = readIssue6194Capture(policyCaptureFile);
      const redactedApprovalCapture = secrets.redact(approvalCapture.contents, [apiKey]);
      const redactedTriggerCapture = secrets.redact(triggerCapture.contents, [apiKey]);
      const redactedRuleCapture = secrets.redact(ruleCapture.contents, [apiKey]);
      const redactedPolicyCapture = secrets.redact(policyCapture.contents, [apiKey]);
      const plainApprovalCapture = stripTerminalControl(redactedApprovalCapture);
      const approvedPolicyVersion =
        redactedPolicyCapture.match(/ISSUE6194_APPROVED_POLICY_VERSION=([0-9]+)/u)?.[1] ?? null;
      const activePolicyVersion =
        redactedPolicyCapture.match(/ISSUE6194_ACTIVE_POLICY_VERSION=([0-9]+)/u)?.[1] ?? null;
      const observedPolicyStatus =
        redactedPolicyCapture.match(/ISSUE6194_POLICY_STATUS=([a-z]+)/u)?.[1] ?? null;
      const policyStatusAttempts =
        redactedPolicyCapture.match(/ISSUE6194_POLICY_STATUS_ATTEMPT=/gu)?.length ?? 0;
      const approvalCombined = `${resultText(approval)}\n${plainApprovalCapture}\n${redactedTriggerCapture}\n${redactedRuleCapture}\n${redactedPolicyCapture}`;
      await artifacts.writeText(
        "issue6194-openshell-approval-capture.log",
        redactedApprovalCapture,
      );
      await artifacts.writeText(
        "issue6194-openshell-approval-capture.plain.log",
        plainApprovalCapture,
      );
      await artifacts.writeText("issue6194-openshell-network-trigger.log", redactedTriggerCapture);
      await artifacts.writeText("issue6194-openshell-pending-rule.log", redactedRuleCapture);
      await artifacts.writeText("issue6194-openshell-policy-retry.log", redactedPolicyCapture);
      await artifacts.writeJson("issue6194-approval-result.json", {
        id: "issue-6194-openshell-network-approval",
        expectExitCode: approval.exitCode,
        approvalCaptureExists: approvalCapture.exists,
        approvalCaptureNonEmpty: plainApprovalCapture.length > 0,
        triggerCaptureExists: triggerCapture.exists,
        ruleCaptureExists: ruleCapture.exists,
        ruleCaptureNonEmpty: redactedRuleCapture.length > 0,
        policyCaptureExists: policyCapture.exists,
        policyCaptureNonEmpty: redactedPolicyCapture.length > 0,
        approvedPolicyVersion,
        activePolicyVersion,
        observedPolicyStatus,
        policyStatusAttempts,
        policyStatusLoaded: redactedPolicyCapture.includes("ISSUE6194_POLICY_STATUS=loaded"),
        policyVersionActive:
          approvedPolicyVersion !== null && approvedPolicyVersion === activePolicyVersion,
        postApprovalEndpoint: ISSUE6194_NETWORK_APPROVAL_ENDPOINT,
        postApprovalExpectedHttpStatus: 401,
        postApprovalHttpStatus401: redactedPolicyCapture.includes(
          "ISSUE6194_POLICY_HTTP_STATUS=401",
        ),
        pendingQueueEmpty: approvalCombined.includes("ISSUE6194_MARK pending_queue_empty"),
        requestTriggered: approvalCombined.includes("ISSUE6194_MARK network_request_triggered"),
        requestCompleted: approvalCombined.includes("ISSUE6194_MARK network_request_completed"),
        singletonRule: approvalCombined.includes("ISSUE6194_MARK network_rule_singleton"),
        rulesFocused: approvalCombined.includes("ISSUE6194_MARK network_rules_focused"),
        endpointRendered: approvalCombined.includes("ISSUE6194_MARK network_rule_endpoint"),
        detailBinary: approvalCombined.includes("ISSUE6194_MARK network_rule_detail_binary"),
        approvalProcessed: approvalCombined.includes("ISSUE6194_MARK network_approval_processed"),
        policyLoaded: approvalCombined.includes("ISSUE6194_MARK network_policy_loaded"),
        policyUpdated: approvalCombined.includes("ISSUE6194_MARK network_policy_updated"),
        cleanExit: approvalCombined.includes("ISSUE6194_MARK openshell_clean_exit"),
      });

      expect(approvalCapture.exists, "OpenShell approval capture must exist").toBe(true);
      expect(
        plainApprovalCapture.length,
        "OpenShell approval capture must not be empty",
      ).toBeGreaterThan(0);
      expect(policyCapture.exists, "post-approval policy retry capture must exist").toBe(true);
      expect(
        redactedPolicyCapture.length,
        "post-approval policy retry capture must not be empty",
      ).toBeGreaterThan(0);
      expect(approval.exitCode, approvalCombined).toBe(0);
      expect(
        approvalCombined,
        "direct curl must create exactly one matching pending rule",
      ).toContain("ISSUE6194_MARK network_rule_singleton");
      expect(approvalCombined, "OpenShell must render the exact blocked endpoint").toContain(
        "ISSUE6194_MARK network_rule_detail_endpoint",
      );
      expect(
        approvalCombined,
        "OpenShell must attribute the rule to the direct curl binary",
      ).toContain("ISSUE6194_MARK network_rule_detail_binary");
      expect(approvalCombined, "OpenShell approval input must be processed").toContain(
        "ISSUE6194_MARK network_approval_processed",
      );
      expect(
        approvedPolicyVersion,
        "approval acknowledgement must identify its assigned policy revision",
      ).not.toBeNull();
      expect(
        redactedPolicyCapture,
        "acknowledged policy revision must reach loaded status before the retry",
      ).toContain("ISSUE6194_POLICY_STATUS=loaded");
      expect(
        activePolicyVersion,
        "loaded active policy revision must match the approval acknowledgement",
      ).toBe(approvedPolicyVersion);
      expect(
        approvalCombined,
        "post-approval probe must wait for the acknowledged policy revision to become active",
      ).toContain("ISSUE6194_MARK network_policy_loaded");
      expect(
        redactedPolicyCapture,
        "approved running policy must allow the exact post-approval Atlassian probe",
      ).toContain("ISSUE6194_POLICY_HTTP_STATUS=401");
      expect(
        approvalCombined,
        "post-approval probe must independently prove the running policy was updated",
      ).toContain("ISSUE6194_MARK network_policy_updated");
      expect(approvalCombined, "OpenShell terminal must exit cleanly after approval").toContain(
        "ISSUE6194_MARK openshell_clean_exit",
      );
    } finally {
      rmSync(captureDir, { recursive: true, force: true });
    }

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
      repro.sentRuns.map((entry) => entry.replyMarker),
    );
    expect(analysis.missingUserTurns, failureSummary).toEqual([]);
    expect(analysis.duplicateUserTurns, failureSummary).toEqual([]);
  },
  // 75-minute budget covers cloud onboarding, sandbox provisioning, gateway
  // warmup, the 120-second wait-for-replies window, and retry.
  75 * 60_000,
);
