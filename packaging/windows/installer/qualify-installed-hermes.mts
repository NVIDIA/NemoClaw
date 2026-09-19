// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare const requestAnimationFrame: typeof globalThis.requestAnimationFrame;
// CI-only acceptance of the real installed Hermes dashboard and native Stop owner.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acceptanceProcessesStopped,
  captureOwned,
  retainedAcceptance,
} from "./qualify-finished-package.mts";
import { childEnvironment, sanitizedFailure } from "./qualify-installed-openclaw.mts";
import { nativeCredentialBinding, readOpenedRegularFile } from "../runtime/native-security.mts";
import { sampleInstalledIdle } from "../tests/performance/installed-idle.mts";

export function recordedHermesTerminal(messages: any[], command: string, sentinel: string) {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls =
      typeof message.tool_calls === "string" ? JSON.parse(message.tool_calls) : message.tool_calls;
    for (const call of calls ?? []) {
      if (call.function?.name !== "terminal") continue;
      const args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
      if (args?.command !== command) continue;
      const reply = messages.find((row) => row.role === "tool" && row.tool_call_id === call.id);
      if (!reply) continue;
      const value = typeof reply.content === "string" ? JSON.parse(reply.content) : reply.content;
      if (
        value?.exit_code === 0 &&
        value.error == null &&
        typeof value.output === "string" &&
        value.output.includes(sentinel)
      )
        return { toolCallId: call.id, command, result: value };
    }
  }
  return null;
}

export function hermesInstalledCodeCommand(nonce: string) {
  assert.match(nonce, /^[a-f0-9]{20}$/u);
  const sentinel = "NEMOCLAW_EXECUTE_CODE_" + nonce;
  return [
    "from hermes_tools import terminal",
    "result = terminal(command=" + JSON.stringify("printf '%s\\n' '" + sentinel + "'") + ")",
    "assert result['exit_code'] == 0 and " + JSON.stringify(sentinel) + " in result['output']",
    "print(" + JSON.stringify(sentinel) + ")",
  ].join("\n");
}

export function recordedHermesCode(messages: any[], code: string, sentinel: string) {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls =
      typeof message.tool_calls === "string" ? JSON.parse(message.tool_calls) : message.tool_calls;
    for (const call of calls ?? []) {
      if (call.function?.name !== "execute_code") continue;
      const args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
      if (args?.code !== code) continue;
      const reply = messages.find((row) => row.role === "tool" && row.tool_call_id === call.id);
      if (!reply) continue;
      const value = typeof reply.content === "string" ? JSON.parse(reply.content) : reply.content;
      if (
        value?.status === "success" &&
        value.exit_code === 0 &&
        value.error == null &&
        typeof value.output === "string" &&
        value.output.includes(sentinel) &&
        Number.isInteger(value.tool_calls_made) &&
        value.tool_calls_made >= 1 &&
        value.kernel?.mode === "session" &&
        Number.isInteger(value.kernel.execution_count) &&
        value.kernel.execution_count >= 1
      )
        return { toolCallId: call.id, code, result: value };
    }
  }
  return null;
}

export function recordedHermesBrowser(messages: any[], code: string, sentinel: string) {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls =
      typeof message.tool_calls === "string" ? JSON.parse(message.tool_calls) : message.tool_calls;
    for (const call of calls ?? []) {
      if (call.function?.name !== "browser_exec") continue;
      const args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
      if (args?.code !== code) continue;
      const reply = messages.find((row) => row.role === "tool" && row.tool_call_id === call.id);
      if (!reply) continue;
      const value = typeof reply.content === "string" ? JSON.parse(reply.content) : reply.content;
      if (
        value?.success === true &&
        value.exit_code === 0 &&
        typeof value.output === "string" &&
        value.output.includes(sentinel)
      )
        return { toolCallId: call.id, code, result: value };
    }
  }
  return null;
}

export function validateHermesEdgeReceipt(receipt: any, sessionId: string) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt?.classification, "native-hermes-edge-browser");
  assert.equal(receipt?.agent, "hermes");
  assert.equal(receipt?.sessionId, sessionId);
  assert.equal(receipt?.identity?.architecture, "arm64");
  assert.equal(receipt?.identity?.machine, 0xaa64);
  assert.equal(receipt?.identity?.signatureStatus, "Valid");
  assert.match(receipt?.identity?.signerSubject ?? "", /Microsoft Corporation/iu);
  assert.equal(receipt?.identity?.provenance, "standard-windows-microsoft-edge-installation");
  assert.match(
    receipt?.identity?.path ?? "",
    /^[A-Z]:\\Program Files(?: \(x86\))?\\Microsoft\\Edge\\Application\\msedge\.exe$/iu,
  );
  assert.match(receipt?.identity?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert(Number.isInteger(receipt?.process?.pid) && receipt.process.pid > 0);
  assert.match(receipt?.process?.creationTimeFileTime ?? "", /^\d+$/u);
  assert.equal(receipt?.endpoint?.host, "127.0.0.1");
  assert(Number.isInteger(receipt?.endpoint?.port) && receipt.endpoint.port > 0);
  assert.match(receipt?.endpoint?.path ?? "", /^\/devtools\/browser\/[A-Za-z0-9-]+$/u);
  assert.equal(receipt?.authenticatedRelay, true);
  assert.equal(receipt?.generalHostProxy, false);
  assert.equal(receipt?.inheritedKillOnCloseJob, true);
  return receipt;
}

export function hermesInstalledToolCommand(nonce: string) {
  assert.match(nonce, /^[a-f0-9]{20}$/u);
  const sentinel = "NEMOCLAW_TOOLS_" + nonce;
  return `set -euo pipefail; f=nemoclaw-${nonce}.txt; printf '%s\\n' '${sentinel}' > "$f"; test "$(cat "$f")" = '${sentinel}'; rg --fixed-strings '${sentinel}' "$f"; rm -- "$f"; test ! -e "$f"; python -c 'import pathlib,tempfile; t=tempfile.TemporaryDirectory(); p=pathlib.Path(t.name)/"proof"; p.write_text("${sentinel}"); assert p.read_text()=="${sentinel}"; t.cleanup(); print("${sentinel}")'; printf '%s\\n' '${sentinel}'`;
}

export function hermesTranscriptRoute(id: string, profile: string, poll: number) {
  assert(id.length > 0 && id.length <= 128, "Hermes stored session identity is invalid");
  assert(profile.length > 0 && profile.length <= 128, "Hermes profile identity is invalid");
  assert(Number.isSafeInteger(poll) && poll > 0, "Hermes transcript poll identity is invalid");
  return (
    "/api/sessions/" +
    encodeURIComponent(id) +
    "/messages?limit=500&order=latest&profile=" +
    encodeURIComponent(profile) +
    "&poll=" +
    poll
  );
}

export function hermesPromptLines(prompt: string) {
  assert(prompt.length > 0 && prompt.length <= 64 * 1024, "Hermes prompt length is invalid");
  assert(!prompt.includes("\r"), "Hermes prompt must use canonical newlines");
  return prompt.split("\n");
}

export function hermesPromptFrames(prompt: string) {
  const frames: string[] = [];
  const lines = hermesPromptLines(prompt);
  for (const [index, line] of lines.entries()) {
    if (line) frames.push(line);
    if (index + 1 < lines.length) frames.push("\u001b[13;2u");
  }
  frames.push("\r");
  return frames;
}

export function sanitizeHermesBrowserDiagnostic(value: unknown, secrets: string[] = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "<redacted>");
  }
  return text
    .replace(/([?&](?:token|ticket)=)[^&\s"'<>]+/giu, "$1<redacted>")
    .replace(/(X-Hermes-Session-Token\s*[:=]\s*)[^\s,"'<>]+/giu, "$1<redacted>")
    .slice(0, 4096);
}

export function applyHermesSocketObservations(pty: any, origin: string, batch: any) {
  assert.equal(batch?.overflow, false, "The in-page Hermes socket observation exceeded its bound");
  assert(Array.isArray(batch?.records) && batch.records.length <= 512);
  for (const record of batch.records) {
    assert(
      record &&
        ["open", "message", "close"].includes(record.kind) &&
        typeof record.url === "string" &&
        record.url.length <= 4096,
      "Invalid in-page Hermes socket observation",
    );
    const url = new URL(record.url);
    if (url.origin.replace(/^ws/u, "http") !== origin) continue;
    const channel = url.searchParams.get("channel");
    if (!channel) continue;
    if (url.pathname === "/api/pty") {
      if (record.kind === "open") pty.bindPty(channel);
      if (record.kind === "message") pty.ptyData();
      if (record.kind === "close") pty.ptyClosed(channel);
      continue;
    }
    if (url.pathname !== "/api/events") continue;
    if (record.kind === "open") pty.bindEvents(channel);
    if (record.kind === "close") pty.eventsClosed(channel);
    if (record.kind === "message") {
      assert(
        typeof record.text === "string" && record.text.length <= 1024 * 1024,
        "The actual PTY event frame is invalid or oversized",
      );
      pty.receive(channel, JSON.parse(record.text));
    }
  }
}

export function createHermesPtyState() {
  let channel: string | null = null,
    sessionId: string | null = null,
    storedSessionId: string | null = null,
    profileName: string | null = null;
  let receivedPtyData = false,
    lastSeq = 0,
    completeSeq = 0,
    settledSeq = 0;
  let readyInfo: any = null,
    failure: string | null = null,
    idle = false,
    observing = true;
  const openEventFeeds = new Map<string, number>();
  const openPtyFeeds = new Map<string, number>();
  const eventFeedOpen = () => channel !== null && (openEventFeeds.get(channel) ?? 0) > 0;
  const ptyFeedOpen = () => channel !== null && (openPtyFeeds.get(channel) ?? 0) > 0;
  const pending: { channel: string; value: any }[] = [];
  const events: { type: string; seq: number; sessionId: string }[] = [];
  const connections: { endpoint: "pty" | "events"; action: "open" | "close"; channel: string }[] =
    [];
  const noteConnection = (
    endpoint: "pty" | "events",
    action: "open" | "close",
    connectionChannel: string,
  ) => {
    if (connections.length === 128) {
      failure = "The actual PTY connection lifecycle log exceeded its bound";
      return;
    }
    connections.push({ endpoint, action, channel: connectionChannel });
  };
  const receive = (eventChannel: string, value: any) => {
    if (!channel) {
      if (pending.length < 128) pending.push({ channel: eventChannel, value });
      else failure = "The PTY startup event buffer exceeded its bound";
      return;
    }
    if (eventChannel !== channel || value?.method !== "event") return;
    const event = value.params,
      payload = event?.payload;
    if (!event || typeof event.type !== "string") {
      failure = "Invalid actual PTY event envelope";
      return;
    }
    const objectPayload =
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    if (
      event.type === "error" ||
      event.type.endsWith(".error") ||
      objectPayload?.error ||
      objectPayload?.status === "error"
    ) {
      failure = "The actual PTY reported an error event: " + event.type;
      return;
    }
    // Canonical gateway.ready and other globals are intentionally unsequenced.
    // They cannot establish readiness or completion of a PTY session.
    if (
      (event.session_id === undefined || event.session_id === null || event.session_id === "") &&
      event.seq === undefined
    )
      return;
    if (
      typeof event.session_id !== "string" ||
      !event.session_id ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 1
    ) {
      failure = "Invalid actual PTY session identity or sequence";
      return;
    }
    // message.start legitimately has no payload; session.info must have one.
    if (event.type === "session.info" && objectPayload === null) {
      failure = "Invalid actual PTY session.info payload";
      return;
    }
    const announcedProfile =
      typeof payload?.profile_name === "string" &&
      payload.profile_name.length > 0 &&
      payload.profile_name.length <= 128
        ? payload.profile_name
        : null;
    const usable =
      event.type === "session.info" &&
      payload.version === "0.21.1" &&
      payload.lazy !== true &&
      payload.running === false &&
      announcedProfile !== null;
    if (!sessionId) {
      if (!usable) return;
      sessionId = event.session_id;
      profileName = announcedProfile;
    }
    if (event.session_id !== sessionId) {
      failure = "The actual PTY changed its runtime session";
      return;
    }
    if (usable && announcedProfile !== profileName) {
      failure = "The actual PTY changed its owning profile";
      return;
    }
    if (event.seq <= lastSeq) return; // A reconnect can replay already observed sequence numbers.
    lastSeq = event.seq;
    if (["message.start", "message.complete", "session.info"].includes(event.type)) {
      if (events.length === 128) {
        failure = "The actual PTY lifecycle event log exceeded its bound";
        return;
      }
      events.push({ type: event.type, seq: event.seq, sessionId: event.session_id as string });
    }
    if (event.type === "message.start") {
      completeSeq = 0;
      settledSeq = 0;
      readyInfo = null;
      if (idle && observing) failure = "A new message started during the idle sample";
    }
    if (event.type === "message.complete") completeSeq = event.seq;
    if (event.type === "session.info") {
      if (
        typeof payload.stored_session_id === "string" &&
        payload.stored_session_id.length > 0 &&
        payload.stored_session_id.length <= 128
      )
        storedSessionId = payload.stored_session_id;
      readyInfo = usable
        ? {
            version: payload.version,
            lazy: payload.lazy === true,
            running: payload.running,
            profileName,
            seq: event.seq,
          }
        : null;
      if (usable && completeSeq > 0 && event.seq > completeSeq) settledSeq = event.seq;
    }
  };
  return {
    bindPty(value: string) {
      assert.match(value, /^[A-Za-z0-9_-]{1,128}$/u);
      if (channel && channel !== value) {
        failure = "Multiple PTY channels belong to this page";
        return;
      }
      channel = value;
      openPtyFeeds.set(value, (openPtyFeeds.get(value) ?? 0) + 1);
      noteConnection("pty", "open", value);
      for (const item of pending.splice(0)) receive(item.channel, item.value);
    },
    receive,
    bindEvents(value: string) {
      assert.match(value, /^[A-Za-z0-9_-]{1,128}$/u);
      assert(openEventFeeds.has(value) || openEventFeeds.size < 8);
      openEventFeeds.set(value, (openEventFeeds.get(value) ?? 0) + 1);
      noteConnection("events", "open", value);
    },
    eventsClosed(value: string) {
      openEventFeeds.set(value, Math.max(0, (openEventFeeds.get(value) ?? 0) - 1));
      noteConnection("events", "close", value);
      if (observing && sessionId !== null && value === channel && !eventFeedOpen())
        failure = "The actual PTY event feed closed";
    },
    ptyData() {
      receivedPtyData = true;
    },
    ptyClosed(value: string) {
      openPtyFeeds.set(value, Math.max(0, (openPtyFeeds.get(value) ?? 0) - 1));
      noteConnection("pty", "close", value);
      if (observing && sessionId !== null && value === channel && !ptyFeedOpen())
        failure = "The actual PTY socket closed";
    },
    assertHealthy() {
      assert.equal(failure, null, failure ?? undefined);
      assert(ptyFeedOpen(), "The actual PTY socket is not live");
      assert(eventFeedOpen(), "The actual PTY event feed is not live");
    },
    usable() {
      return (
        failure === null &&
        ptyFeedOpen() &&
        eventFeedOpen() &&
        receivedPtyData &&
        readyInfo !== null
      );
    },
    markTurn() {
      assert(failure === null && ptyFeedOpen() && readyInfo);
      idle = false;
      return lastSeq;
    },
    settledAfter(mark: number) {
      return (
        failure === null &&
        ptyFeedOpen() &&
        eventFeedOpen() &&
        readyInfo !== null &&
        completeSeq > mark &&
        settledSeq > completeSeq
      );
    },
    beginIdle(mark: number) {
      assert(this.settledAfter(mark), "The actual PTY turn is not settled");
      idle = true;
    },
    finish() {
      observing = false;
    },
    storedSessionId() {
      return storedSessionId;
    },
    profileName() {
      return profileName;
    },
    snapshot() {
      return {
        channel,
        eventFeedOpen: eventFeedOpen(),
        ptyFeedOpen: ptyFeedOpen(),
        openEventFeedCount: [...openEventFeeds.values()].reduce((sum, value) => sum + value, 0),
        openPtyFeedCount: [...openPtyFeeds.values()].reduce((sum, value) => sum + value, 0),
        runtimeSessionId: sessionId,
        storedSessionId,
        profileName,
        receivedPtyData,
        lastSeq,
        completeSeq,
        settledSeq,
        readyInfo,
        failure,
        events: [...events],
        connections: [...connections],
      };
    },
  };
}

export function hermesTurnIndex(messages: any[], prompt: string, markers: string[] = []) {
  return messages.findIndex(
    (row) =>
      row.role === "user" &&
      typeof row.content === "string" &&
      (row.content === prompt ||
        (markers.length > 0 && markers.every((marker) => row.content.includes(marker)))),
  );
}

export function finalHermesTurn(messages: any[]) {
  const user = messages.findIndex((row) => row.role === "user");
  if (user < 0) return false;
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content !== "string" || !last.content.trim())
    return false;
  const calls = typeof last.tool_calls === "string" ? JSON.parse(last.tool_calls) : last.tool_calls;
  return messages.length > user + 1 && (!calls || calls.length === 0);
}

export function finalHermesAssistant(messages: any[], prompt: string, markers: string[] = []) {
  const user = hermesTurnIndex(messages, prompt, markers);
  return user >= 0 && finalHermesTurn(messages.slice(user));
}

export function hermesMessagesAfter(messages: any[], mark: number) {
  assert(Number.isSafeInteger(mark) && mark >= 0, "Hermes transcript mark is invalid");
  for (const row of messages)
    assert(Number.isSafeInteger(row.id) && row.id > 0, "Hermes transcript row has no identity");
  return [...messages].sort((left, right) => left.id - right.id).filter((row) => row.id > mark);
}

function argument(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error("Missing " + name);
}
function closed(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned installed operation exceeded its existing deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const install = path.resolve(argument("--install-root"));
  const output = path.resolve(argument("--output"));
  const identity = JSON.parse(fs.readFileSync(argument("--runtime-identity"), "utf8"));
  const model = argument("--model", "nvidia/nemotron-3-super-120b-a12b");
  const secret = process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "";
  assert(
    secret.startsWith("nvapi-") && secret.length <= 2048 && !/[\r\n\0]/u.test(secret),
    "An authorized NVIDIA credential is required",
  );
  const runnerTempValue = process.env.RUNNER_TEMP;
  assert(runnerTempValue && path.isAbsolute(runnerTempValue), "RUNNER_TEMP must be absolute.");
  const runnerTemp = path.resolve(runnerTempValue);
  const outputFromRunnerTemp = path.relative(runnerTemp, output);
  assert(
    outputFromRunnerTemp !== ".." &&
      !outputFromRunnerTemp.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(outputFromRunnerTemp),
    "The observer output must remain beneath RUNNER_TEMP.",
  );
  assert(!fs.existsSync(output));
  fs.mkdirSync(output, { recursive: true });
  const observerStopSentinel = path.join(
    output,
    `observer-stop-${randomBytes(32).toString("hex")}.sentinel`,
  );
  assert.equal(fs.existsSync(observerStopSentinel), false);
  const environment = childEnvironment(process.env);
  delete environment.GITHUB_ACTIONS;
  const observerEnvironment = { ...environment, GITHUB_ACTIONS: "true" };
  const launcher = path.join(install, "bin/NemoClaw.exe");
  const ps = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const state = path.join(process.env.LOCALAPPDATA!, "NVIDIA/NemoClaw/agents/hermes");
  const reuse = process.argv.includes("--reuse-configuration");
  const preserve = process.argv.includes("--preserve-configuration");
  const results: any = {
    installedAcceptance: false,
    fullAgentQualified: false,
    tavilyLiveLookup: "not-tested-user-waiver",
    conversationIntervalsSeparateFromLocalStartup: true,
    isolatedProviderLatencyMeasured: false,
  };
  const cleanupErrors: string[] = [];
  let phase = "configuration",
    primary: unknown,
    configurationOwned = false,
    binding: string | undefined;
  let guardian: ChildProcess | undefined, observer: ChildProcess | undefined;
  let guardianClosed: Promise<number> | undefined, observerClosed: Promise<number> | undefined;
  let browser: any,
    latest: any,
    stopInvoked = false,
    stopCompleted = false,
    observerFailure: Error | undefined;
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
  const command = async (name: string, args: string[], input = "") => {
    const value = await captureOwned(launcher, args, environment, input);
    assert.equal(value.failure, null);
    assert.equal(value.exitCode, 0, name);
    return value.stdout;
  };
  try {
    const configuration = {
      schemaVersion: 1,
      classification: "nemoclaw-native-windows-agent-configuration",
      agent: "hermes",
      inference: "nvidia",
      endpoint: "https://integrate.api.nvidia.com/v1",
      model,
      credentialStored: true,
      profile: "personal",
      options: {},
    };
    if (!reuse)
      assert(!fs.existsSync(state), "Fresh Hermes acceptance requires no saved configuration");
    const configurationPath = path.join(state, "native-windows.json");
    const retainedState = reuse
      ? retainedAcceptance(
          "hermes",
          JSON.parse(
            readOpenedRegularFile(argument("--previous-acceptance"), {
              encoding: "utf8",
              maxBytes: 1024 * 1024,
              rejectLinks: true,
            }) ?? "null",
          ),
          identity,
          readOpenedRegularFile(configurationPath, {
            encoding: "utf8",
            maxBytes: 64 * 1024,
            rejectLinks: true,
          }) ?? "",
          `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
        )
      : undefined;
    const ownedState = JSON.parse(await command("private state", ["--state-session", "hermes"]));
    assert.equal(ownedState.agent, "hermes");
    assert.equal(ownedState.leaseHeld, true);
    assert.match(ownedState.stateRoot, /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u);
    assert(
      reuse || ownedState.created === true,
      "Fresh Hermes acceptance cannot use pre-existing agent data",
    );
    if (reuse)
      assert(
        ownedState.created === false && ownedState.stateRoot === retainedState,
        "Hermes restart cannot claim different or recreated agent data",
      );
    configurationOwned = true;
    results.stateRoot = ownedState.stateRoot;
    binding = nativeCredentialBinding(configuration);
    if (!reuse) {
      const onboardPath = path.join(output, "native-onboarding.json");
      const onboard = await captureOwned(
        path.join(process.env.ProgramFiles!, "PowerShell/7/pwsh.exe"),
        [
          "-NoProfile",
          "-File",
          fileURLToPath(new URL("./control-installed-hermes-onboarding.ps1", import.meta.url)),
          "-InstallRoot",
          install,
          "-Model",
          model,
          "-OutputPath",
          onboardPath,
        ],
        { ...observerEnvironment, NVIDIA_API_KEY: secret },
        "",
        180_000,
      );
      assert.equal(onboard.failure, null);
      assert.equal(onboard.exitCode, 0, "Native Hermes onboarding failed");
      results.onboarding = JSON.parse(fs.readFileSync(onboardPath, "utf8"));
      assert.equal(results.onboarding.passed, true);
      assert.equal(results.onboarding.successfulConfigurationSaves, 1);
      assert.equal(results.onboarding.rejectedEmptyIntegrationSave, true);
      assert.equal(results.onboarding.cleanupClosed, true);
    }
    const configurationText = readOpenedRegularFile(configurationPath, {
      encoding: "utf8",
      maxBytes: 64 * 1024,
      rejectLinks: true,
    });
    assert(configurationText !== null, "Saved Hermes configuration is missing");
    const saved = JSON.parse(configurationText);
    results.configurationSha256 = createHash("sha256").update(configurationText).digest("hex");
    results.configurationReused = reuse;
    assert.equal(saved.agent, "hermes");
    assert.equal(saved.model, model);
    assert.equal(saved.inference, "nvidia");
    assert.equal(saved.endpoint, configuration.endpoint);
    assert.equal(saved.profile, "personal");
    assert.equal(saved.credentialStored, true);
    assert.equal(saved.options?.search ?? null, null);
    assert.equal(Object.keys(saved.options?.messaging ?? {}).length, 0);
    results.configuration = {
      reused: reuse,
      configuredThisCase: !reuse,
      nativeOnboardingUsed: !reuse,
      searchRequested: false,
      messagingRequested: false,
    };
    const capabilities = JSON.parse(await command("capabilities", ["--runtime-capabilities"]));
    assert.equal(capabilities.immutableRuntime, true);
    assert.equal(capabilities.guardianEnabled, true);
    const description = JSON.parse(await command("description", ["--runtime-host", "describe"]));
    assert.equal(description.sea, true);
    assert.equal(description.node, "v22.23.2");
    const lease = JSON.parse(
      await command("runtime-identity", ["--runtime-session", "hermes"], "release\n"),
    );
    for (const key of [
      "runtimeId",
      "manifestSha256",
      "sourceRevision",
      "nodeSha256",
      "nodeVersion",
    ])
      assert.equal(lease[key], identity[key]);
    results.runtime = lease;
    assert.equal(
      fs
        .readFileSync(path.join(path.dirname(path.dirname(state)), "active-agent.txt"), "utf8")
        .trim(),
      "hermes",
    );
    phase = "dashboard-startup";
    const session = path.join(output, "session");
    fs.mkdirSync(session);
    const started = performance.now();
    guardian = spawn(
      launcher,
      ["--wait", "--dashboard-qualification", "--artifact-directory", session],
      { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    guardianClosed = closed(guardian);
    void guardianClosed.catch(() => {});
    guardian.stdin!.end();
    const outputBytes = { stdout: 0, stderr: 0 };
    for (const channel of ["stdout", "stderr"] as const)
      guardian[channel]!.on("data", (data: Buffer) => {
        outputBytes[channel] += data.length;
        if (outputBytes[channel] > 8 * 1024 * 1024)
          observerFailure = new Error("Installed guardian output exceeded its bound");
        else
          fs.appendFileSync(
            path.join(output, "guardian." + channel + ".log"),
            JSON.stringify(sanitizedFailure(new Error(data.toString("utf8")), secret)) + "\n",
          );
      });
    observer = spawn(
      ps,
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./control-installed-openclaw.ps1", import.meta.url)),
        "-RootProcessId",
        String(guardian.pid),
        "-InstallRoot",
        install,
      ],
      {
        env: {
          ...observerEnvironment,
          RUNNER_TEMP: runnerTemp,
          NEMOCLAW_OBSERVER_CONTROLLER_PID: String(process.pid),
          NEMOCLAW_OBSERVER_STOP_SENTINEL: observerStopSentinel,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    observerClosed = closed(observer);
    void observerClosed.catch(() => {});
    let buffer = "",
      bytes = 0;
    observer.stdout!.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) {
        observerFailure = new Error("Native UI observer output exceeded its bound");
        return;
      }
      buffer += data.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.kind === "observation") latest = event;
          if (event.kind === "stop-invoked") stopInvoked = true;
          if (event.kind === "closed" && event.exitCode === 0) stopCompleted = true;
          fs.appendFileSync(path.join(output, "observer.jsonl"), JSON.stringify(event) + "\n");
        } catch {
          observerFailure = new Error("Native UI observer emitted invalid JSON");
        }
      }
    });
    observer.stderr!.on("data", (data: Buffer) =>
      fs.appendFileSync(
        path.join(output, "observer.stderr.log"),
        JSON.stringify(sanitizedFailure(new Error(data.toString("utf8")), secret)) + "\n",
      ),
    );
    const deadline = performance.now() + 120_000;
    let ready: any;
    while (performance.now() < deadline) {
      if (observerFailure) throw observerFailure;
      assert.equal(guardian.exitCode, null);
      assert.equal(observer.exitCode, null);
      const file = path.join(session, "dashboard-ready.json");
      if (fs.existsSync(file) && latest?.openEnabled) {
        ready = JSON.parse(fs.readFileSync(file, "utf8"));
        break;
      }
      await sleep(250);
    }
    assert(ready?.agent === "hermes", "The actual Hermes dashboard did not become ready");
    assert.equal(
      ready.agentRuntimeRoot,
      results.stateRoot,
      "Hermes started with different agent data",
    );
    results.edgeBrowser = validateHermesEdgeReceipt(
      JSON.parse(fs.readFileSync(path.join(session, "edge-browser.json"), "utf8")),
      ready.sessionId,
    );
    const origin = new URL(ready.url);
    assert.equal(origin.protocol, "http:");
    assert.equal(origin.hostname, "127.0.0.1");
    assert.equal(origin.pathname, "/");
    assert(!origin.search && !origin.hash);
    assert(latest.ports.includes(Number(origin.port)));
    results.startup = {
      dashboardPortReadyMs: performance.now() - started,
      port: Number(origin.port),
      observer: latest,
    };
    const driver = path.resolve(argument("--browser-driver-root"));
    const { chromium } = createRequire(path.join(driver, "package.json"))(driver);
    const edge = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
      .filter(Boolean)
      .map((root) => path.join(root!, "Microsoft/Edge/Application/msedge.exe"))
      .find(fs.existsSync);
    assert(edge, "The runner has no existing browser for real dashboard acceptance");
    browser = await chromium.launch({
      executablePath: edge,
      headless: true,
      timeout: Math.max(1, Math.min(30_000, 120_000 - (performance.now() - started))),
    });
    const page = await browser.newPage();
    let sessionToken: string | undefined;
    const browserEvents: { kind: string; route?: string; status?: number; text?: string }[] = [];
    const noteBrowserEvent = (event: (typeof browserEvents)[number]) => {
      if (browserEvents.length < 128)
        browserEvents.push({
          ...event,
          ...(event.text === undefined
            ? {}
            : {
                text: sanitizeHermesBrowserDiagnostic(event.text, [secret, sessionToken ?? ""]),
              }),
        });
    };
    const localRoute = (value: string) => {
      try {
        const url = new URL(value);
        return url.origin === origin.origin ? url.pathname : "different-origin";
      } catch {
        return "invalid-url";
      }
    };
    page.on("console", (message: any) => {
      const text = message.text();
      if (/chat|pty|websocket|error|fail|disconnect|reconnect/iu.test(text))
        noteBrowserEvent({ kind: "console-" + message.type(), text });
    });
    page.on("pageerror", (error: Error) =>
      noteBrowserEvent({ kind: "page-error", text: String(error) }),
    );
    page.on("requestfailed", (request: any) => {
      const route = localRoute(request.url());
      if (route !== "different-origin")
        noteBrowserEvent({
          kind: "request-failed",
          route,
          text: String(request.failure()?.errorText ?? "unknown failure"),
        });
    });
    page.on("response", (response: any) => {
      const route = localRoute(response.url());
      if (route !== "different-origin" && response.status() >= 400)
        noteBrowserEvent({ kind: "http-error", route, status: response.status() });
    });
    await page.addInitScript(() => {
      const target = globalThis as any;
      const observation = {
        records: [] as any[],
        overflow: false,
        sockets: new Map<number, { socket: any; url: string }>(),
        nextSocketId: 1,
      };
      Object.defineProperty(target, "__nemoclawSocketObservation", {
        value: observation,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      const push = (record: any) => {
        if (
          observation.records.length >= 512 ||
          (typeof record.text === "string" && record.text.length > 1024 * 1024)
        ) {
          observation.overflow = true;
          return;
        }
        observation.records.push(record);
      };
      const NativeWebSocket = target.WebSocket;
      const ObservedWebSocket = new Proxy(NativeWebSocket, {
        construct(constructor, args, newTarget) {
          const socket = Reflect.construct(constructor, args, newTarget);
          const url = String(socket.url || args[0] || "");
          const socketId = observation.nextSocketId++;
          observation.sockets.set(socketId, { socket, url });
          let eventFeed = false;
          try {
            eventFeed = new URL(url).pathname === "/api/events";
          } catch {
            observation.overflow = true;
          }
          socket.addEventListener("open", () => push({ kind: "open", url }));
          socket.addEventListener("message", (event: MessageEvent) => {
            let text: string | undefined;
            if (eventFeed) {
              if (typeof event.data === "string") text = event.data;
              else if (event.data instanceof ArrayBuffer)
                text = new TextDecoder().decode(event.data);
              else observation.overflow = true;
            }
            push({ kind: "message", url, ...(text === undefined ? {} : { text }) });
          });
          socket.addEventListener("close", () => {
            observation.sockets.delete(socketId);
            push({ kind: "close", url });
          });
          return socket;
        },
      });
      Object.defineProperty(target, "WebSocket", {
        value: ObservedWebSocket,
        configurable: true,
        writable: true,
      });
    });
    const pty = createHermesPtyState();
    const pumpHermesSockets = async () => {
      const batch = await page.evaluate(() => {
        const observation = (globalThis as any).__nemoclawSocketObservation;
        if (!observation) return null;
        const records = observation.records.splice(0);
        const overflow = observation.overflow;
        observation.overflow = false;
        return { records, overflow };
      });
      assert(batch, "The in-page Hermes socket observer is missing");
      applyHermesSocketObservations(pty, origin.origin, batch);
    };
    page.on("request", (request: any) => {
      if (new URL(request.url()).origin === origin.origin)
        sessionToken ??= request.headers()["x-hermes-session-token"];
    });
    await page.goto(origin.origin + "/chat", {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, Math.min(30_000, 120_000 - (performance.now() - started))),
    });
    const terminal = page.locator(".xterm-helper-textarea").first();
    await terminal.waitFor({
      state: "attached",
      timeout: Math.max(1, Math.min(30_000, 120_000 - (performance.now() - started))),
    });
    while (!pty.usable() && performance.now() - started < 120_000) {
      if (observerFailure) throw observerFailure;
      await pumpHermesSockets();
      await sleep(100);
    }
    await pumpHermesSockets();
    results.startup.pty = pty.snapshot();
    try {
      results.startup.browser = await page.evaluate(() => {
        const target = globalThis as any;
        const observation = target.__nemoclawSocketObservation;
        const socketStates = observation
          ? [...observation.sockets.values()].slice(0, 16).map(({ socket, url }: any) => {
              const parsed = new URL(url);
              return {
                path: parsed.pathname,
                channel: parsed.searchParams.get("channel"),
                queryNames: [...parsed.searchParams.keys()].sort(),
                readyState: socket.readyState,
              };
            })
          : [];
        const bodyText = target.document.body?.innerText ?? "";
        const indicators = [
          "Session token unavailable.",
          "Chat is reconnecting.",
          "Chat disconnected.",
          "Session ended.",
        ].filter((value) => bodyText.includes(value));
        return {
          path: target.location.pathname,
          documentReadyState: target.document.readyState,
          title: target.document.title.slice(0, 256),
          authRequired: Boolean(target.__HERMES_AUTH_REQUIRED__),
          sessionTokenPresent: Boolean(target.__HERMES_SESSION_TOKEN__),
          socketObserverPresent: Boolean(observation),
          socketStates,
          terminalCount: target.document.querySelectorAll(".xterm-helper-textarea").length,
          reconnectControlCount: target.document.querySelectorAll('[aria-label="Reconnect chat"]')
            .length,
          indicators,
        };
      });
      results.startup.browser.events = browserEvents.map((event) => ({
        ...event,
        ...(event.text === undefined
          ? {}
          : {
              text: sanitizeHermesBrowserDiagnostic(event.text, [secret, sessionToken ?? ""]),
            }),
      }));
    } catch (error) {
      results.startup.browserCaptureError = sanitizedFailure(error, secret);
    }
    if (!pty.usable())
      await page
        .screenshot({ path: path.join(output, "dashboard-startup-failure.png"), fullPage: true })
        .catch((error: unknown) => {
          results.startup.screenshotError = sanitizedFailure(error, secret);
        });
    pty.assertHealthy();
    assert(
      pty.usable() && performance.now() - started < 120_000,
      "The real Hermes agent did not expose its usable prompt within the startup deadline",
    );
    assert.equal(
      await page
        .getByRole("alert")
        .filter({ hasText: /fatal|failed to start|connection failed/iu })
        .count(),
      0,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    results.startup.usablePromptElapsedMs = performance.now() - started;
    assert(results.startup.usablePromptElapsedMs < 120_000);
    results.startup.measurement =
      "guardian launch through actual PTY AIAgent-attached usable prompt";
    results.startup.pty = pty.snapshot();
    await page.screenshot({ path: path.join(output, "dashboard-ready.png"), fullPage: true });
    const api = async (route: string, allowNotFound = false) => {
      assert(route.startsWith("/api/") && !route.includes(".."));
      return await page.evaluate(
        async ({
          route,
          token,
          allowNotFound,
        }: {
          route: string;
          token?: string;
          allowNotFound: boolean;
        }) => {
          const response = await fetch(route, {
            headers: token ? { "X-Hermes-Session-Token": token } : {},
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (allowNotFound && response.status === 404) return null;
          if (!response.ok) throw new Error("Hermes dashboard API returned " + response.status);
          const text = await response.text();
          if (text.length > 2 * 1024 * 1024)
            throw new Error("Hermes API evidence exceeds its bound");
          return JSON.parse(text);
        },
        { route, token: sessionToken, allowNotFound },
      );
    };
    const config = await api("/api/config");
    assert.equal(config.web?.keyless_fallback, false);
    assert(config.agent?.disabled_toolsets?.includes("web"));
    assert.equal(config.security?.allow_lazy_installs, false);
    results.optionalConfiguration = {
      searchDisabled: true,
      keylessFallback: false,
      lazyInstalls: false,
      messagingRequested: false,
      tavilyLiveLookup: "not-tested-user-waiver",
    };
    let transcriptPoll = 0;
    const sessionMessages = async () => {
      const id = pty.storedSessionId(),
        profile = pty.profileName();
      if (!id || !profile) return [];
      // Hermes deliberately creates the stored row on the first prompt, so
      // the first bounded transcript poll can precede that row.
      // This is a live evidence read, not dashboard hydration. A unique URL
      // plus no-store prevents Chromium's HTTP cache from freezing the first
      // completed turn while later PTY turns continue and settle.
      const detail = await api(hermesTranscriptRoute(id, profile, ++transcriptPoll), true);
      if (detail === null) return [];
      assert.equal(detail.session_id, id);
      assert(Array.isArray(detail.messages));
      return hermesMessagesAfter(detail.messages, 0);
    };
    let lastTurnMark = 0;
    const submitPrompt = async (prompt: string) => {
      const channel = pty.snapshot().channel;
      assert(channel, "The actual Hermes PTY channel is unavailable");
      const frames = hermesPromptFrames(prompt);
      const result = await page.evaluate(
        ({ channel, frames, origin }: { channel: string; frames: string[]; origin: string }) => {
          const observation = (globalThis as any).__nemoclawSocketObservation;
          if (!observation?.sockets) return { matches: 0 };
          const matches = [...observation.sockets.values()].filter((entry: any) => {
            try {
              const url = new URL(entry.url);
              return (
                url.origin.replace(/^ws/u, "http") === origin &&
                url.pathname === "/api/pty" &&
                url.searchParams.get("channel") === channel &&
                entry.socket.readyState === 1
              );
            } catch {
              return false;
            }
          });
          if (matches.length === 1)
            return (async () => {
              for (const [index, frame] of frames.entries()) {
                matches[0].socket.send(frame);
                if (index + 1 < frames.length)
                  await new Promise((resolve) => setTimeout(resolve, 50));
              }
              return { matches: 1 };
            })();
          return { matches: matches.length };
        },
        { channel, frames, origin: origin.origin },
      );
      assert.equal(result.matches, 1, "The actual dashboard does not own one live PTY input");
    };
    const turn = async (prompt: string, accept: (messages: any[]) => unknown) => {
      const previous = await sessionMessages();
      const transcriptMark = previous.at(-1)?.id ?? 0;
      const mark = pty.markTurn();
      lastTurnMark = mark;
      const start = performance.now();
      let lastMessages: any[] = [];
      await submitPrompt(prompt);
      while (performance.now() - start < 120_000) {
        if (observerFailure) throw observerFailure;
        await pumpHermesSockets();
        pty.assertHealthy();
        const messages = hermesMessagesAfter(await sessionMessages(), transcriptMark);
        lastMessages = messages;
        const value = accept(messages);
        if (value && finalHermesTurn(messages) && pty.settledAfter(mark))
          return {
            conversationElapsedMs: performance.now() - start,
            measurement: "end-to-end conversation interval including model, tools and UI/protocol",
            isolatedProviderLatencyMs: null,
            value,
          };
        if (finalHermesTurn(messages) && pty.settledAfter(mark)) {
          results.failedTurn = {
            prompt,
            pty: pty.snapshot(),
            messages,
          };
          throw new Error(
            "The actual settled Hermes turn did not produce the required recorded result",
          );
        }
        await sleep(1000);
      }
      results.failedTurn = { prompt, pty: pty.snapshot(), messages: lastMessages };
      throw new Error("The real Hermes model/tool turn exceeded its unchanged two-minute deadline");
    };
    const nonce = randomBytes(10).toString("hex");
    phase = "nvidia-model";
    const reply = "NEMOCLAW_NVIDIA_" + nonce;
    results.nvidia = await turn("Reply with exactly " + reply + " and nothing else.", (messages) =>
      messages.find(
        (row) =>
          row.role === "assistant" &&
          typeof row.content === "string" &&
          row.content.trim() === reply,
      ),
    );
    phase = "real-tools";
    const sentinel = "NEMOCLAW_TOOLS_" + nonce;
    const script = hermesInstalledToolCommand(nonce);
    const code = hermesInstalledCodeCommand(nonce);
    results.tools = await turn(
      "Use both tools exactly as provided. First use terminal with this command.\n```sh\n" +
        script +
        "\n```\nThen use execute_code with this exact Python code to verify its real tool bootstrap.\n```python\n" +
        code +
        "\n```\nReply with completion only after both tools succeed.",
      (messages) => {
        const terminal = recordedHermesTerminal(messages, script, sentinel);
        const executeCode = recordedHermesCode(messages, code, "NEMOCLAW_EXECUTE_CODE_" + nonce);
        return terminal && executeCode ? { terminal, executeCode } : null;
      },
    );
    results.toolsScope = {
      bash: true,
      fileWriteReadDeleteViaTerminal: true,
      canonicalRipgrep: true,
      terminalPythonTemporaryCode: true,
      executeCodeToolBootstrap: true,
    };
    phase = "browser-tool";
    const browserSentinel = "Example Domain";
    const browserCode = [
      "expected=" + JSON.stringify(browserSentinel),
      "new_tab('https://example.com/')",
      "assert wait_for_element('h1', timeout=15.0, visible=True) is True",
      "actual=js(\"document.querySelector('h1').textContent\")",
      "assert actual == expected",
      "print(expected)",
    ].join("\n");
    results.browserTool = await turn(
      "Use browser_exec with this exact code and report completion only after it succeeds.\n```python\n" +
        browserCode +
        "\n```",
      (messages) => recordedHermesBrowser(messages, browserCode, browserSentinel),
    );
    results.browserToolScope = {
      browser: "native-arm64-microsoft-edge",
      transport: "authenticated-session-cdp-relay",
      localBundledBrowserExecuted: false,
      visibleSentinel: browserSentinel,
    };
    await page.screenshot({ path: path.join(output, "dashboard-model-tools.png"), fullPage: true });
    phase = "idle-measurement";
    pty.beginIdle(lastTurnMark);
    assert(
      performance.now() - started < 425_000,
      "Idle measurement must preserve the existing native Stop deadline",
    );
    results.idle = await sampleInstalledIdle(
      {
        agent: "hermes",
        stateRoot: ready.agentRuntimeRoot,
        windowsRoot: process.env.SystemRoot!,
        installRoot: install,
        guardianPid: guardian.pid!,
        guardianStartedUtc: latest.rootStartedUtc,
        hostPid: latest.hostPid,
        hostStartedUtc: latest.hostStartedUtc,
        runtimeId: identity.runtimeId,
        sourceRevision: identity.sourceRevision,
        manifestSha256: identity.manifestSha256,
      },
      path.join(output, "installed-idle.json"),
    );
    await pumpHermesSockets();
    results.idle.acceptedAsIdle =
      pty.settledAfter(lastTurnMark) && results.idle.status === "measured";
    results.settledPty = pty.snapshot();
    pty.assertHealthy();
    assert.equal(results.idle.acceptedAsIdle, true);
    pty.finish();
  } catch (error) {
    primary = error;
  } finally {
    if (browser) await browser.close().catch(() => cleanupErrors.push("automation browser"));
    if (observer && guardianClosed && observerClosed) {
      try {
        fs.writeFileSync(observerStopSentinel, "", { flag: "wx" });
        assert.equal(await bounded(guardianClosed, 130_000), 0);
        assert.equal(await bounded(observerClosed, 5000), 0);
        fs.unlinkSync(observerStopSentinel);
        assert(stopInvoked && stopCompleted, "Actual native Stop did not finish");
        const end = JSON.parse(
          fs.readFileSync(path.join(output, "session/dashboard-end.json"), "utf8"),
        );
        for (const key of [
          "sandboxDeleted",
          "gatewayStopped",
          "ephemeralRootsRemoved",
          "stateRetained",
          "leaseReleased",
          "cleanupSucceeded",
        ])
          assert.equal(end[key], true, key);
        for (const key of ["runtimeId", "manifestSha256", "sourceRevision"])
          assert.equal(end.runtimeIdentity[key], identity[key]);
        assert.equal(end.runtimeCounterSource, "held-runtime-session");
        assert.equal(end.runtimeBytesCopied, 0);
        assert.equal(end.runtimeFilesHashedAtLaunch, 0);
        results.cleanup = {
          ...end,
          guardianClosed: true,
          observerClosed: true,
          runtimeLeaseOwnerClosedWithGuardian: true,
        };
      } catch (error) {
        cleanupErrors.push("native Stop: " + JSON.stringify(sanitizedFailure(error, secret)));
      }
    }
    if (guardian?.exitCode === null && guardian.pid) {
      const value = await captureOwned(
        path.join(process.env.SystemRoot!, "System32/taskkill.exe"),
        ["/PID", String(guardian.pid), "/T", "/F"],
        environment,
        "",
        15_000,
      );
      if (value.exitCode !== 0) cleanupErrors.push("owned guardian emergency close");
      if (guardianClosed)
        await bounded(guardianClosed, 5000).catch(() =>
          cleanupErrors.push("guardian remained live"),
        );
    }
    if (observer?.exitCode === null) {
      observer.kill();
      if (observerClosed)
        await bounded(observerClosed, 5000).catch(() =>
          cleanupErrors.push("observer remained live"),
        );
    }
    if (!acceptanceProcessesStopped(guardian, observer)) {
      cleanupErrors.push(
        "Processes remain live or unconfirmed; saved data and credentials retained",
      );
    } else if (configurationOwned && (!preserve || primary !== undefined || cleanupErrors.length)) {
      try {
        await command("remove-data", ["--remove-native-data", "--agent", "hermes"]);
      } catch {
        cleanupErrors.push("configured Hermes data");
      }
      if (binding)
        try {
          await command("credential-delete", [
            "--credential-delete",
            "nvidia",
            "--binding",
            binding,
          ]);
        } catch {
          cleanupErrors.push("NVIDIA credential");
        }
    }
  }
  if (cleanupErrors.length) primary ??= new Error("Installed Hermes cleanup did not complete");
  results.configurationPreserved = preserve && primary === undefined;
  write("installed-hermes-acceptance.json", {
    schemaVersion: 1,
    classification: "installed-canonical-hermes-acceptance",
    controllerRun: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`,
    runtime: identity,
    verdict: primary === undefined ? "pass" : "fail",
    failedStage: primary === undefined ? null : phase,
    error: primary === undefined ? null : sanitizedFailure(primary, secret),
    results,
    cleanupErrors,
    fullInstalledQualification: false,
  });
  if (primary !== undefined) throw primary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(
      sanitizedFailure(
        error,
        process.env.NVIDIA_API_KEY || process.env.NVIDIA_INFERENCE_API_KEY || "",
      ),
    );
    process.exitCode = 1;
  });
