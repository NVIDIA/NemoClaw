// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare const requestAnimationFrame: typeof globalThis.requestAnimationFrame;
// CI-only acceptance of the real installed Hermes dashboard and native Stop owner.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { captureOwned } from "./qualify-finished-package.mts";
import { childEnvironment, sanitizedFailure } from "./qualify-installed-openclaw.mts";
import { nativeCredentialBinding } from "../runtime/native-security.mts";
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

export function createHermesPtyState() {
  let channel: string | null = null,
    sessionId: string | null = null,
    storedSessionId: string | null = null;
  let ptyOpen = false,
    receivedPtyData = false,
    lastSeq = 0,
    completeSeq = 0,
    settledSeq = 0;
  let readyInfo: any = null,
    failure: string | null = null,
    idle = false,
    observing = true;
  const openEventFeeds = new Map<string, number>();
  const eventFeedOpen = () => channel !== null && (openEventFeeds.get(channel) ?? 0) > 0;
  const pending: { channel: string; value: any }[] = [];
  const events: { type: string; seq: number; sessionId: string }[] = [];
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
    if (event.session_id == null && event.seq === undefined) return;
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
    const usable =
      event.type === "session.info" &&
      payload.version === "0.21.1" &&
      payload.lazy !== true &&
      payload.running === false;
    if (!sessionId) {
      if (!usable) return;
      sessionId = event.session_id;
    }
    if (event.session_id !== sessionId) {
      failure = "The actual PTY changed its runtime session";
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
      ptyOpen = true;
      for (const item of pending.splice(0)) receive(item.channel, item.value);
    },
    receive,
    bindEvents(value: string) {
      assert.match(value, /^[A-Za-z0-9_-]{1,128}$/u);
      assert(openEventFeeds.has(value) || openEventFeeds.size < 8);
      openEventFeeds.set(value, (openEventFeeds.get(value) ?? 0) + 1);
    },
    eventsClosed(value: string) {
      openEventFeeds.set(value, Math.max(0, (openEventFeeds.get(value) ?? 0) - 1));
      if (observing && value === channel && !eventFeedOpen())
        failure = "The actual PTY event feed closed";
    },
    ptyData() {
      receivedPtyData = true;
    },
    ptyClosed() {
      ptyOpen = false;
      if (observing) failure = "The actual PTY socket closed";
    },
    assertHealthy() {
      assert.equal(failure, null, failure ?? undefined);
      assert(ptyOpen, "The actual PTY socket is not live");
      assert(eventFeedOpen(), "The actual PTY event feed is not live");
    },
    usable() {
      return (
        failure === null && ptyOpen && eventFeedOpen() && receivedPtyData && readyInfo !== null
      );
    },
    markTurn() {
      assert(failure === null && ptyOpen && readyInfo);
      idle = false;
      return lastSeq;
    },
    settledAfter(mark: number) {
      return (
        failure === null &&
        ptyOpen &&
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
    snapshot() {
      return {
        channel,
        eventFeedOpen: eventFeedOpen(),
        runtimeSessionId: sessionId,
        storedSessionId,
        receivedPtyData,
        lastSeq,
        completeSeq,
        settledSeq,
        readyInfo,
        failure,
        events: [...events],
      };
    },
  };
}

export function finalHermesAssistant(messages: any[], prompt: string) {
  const user = messages.findIndex((row) => row.role === "user" && row.content === prompt);
  if (user < 0) return false;
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content !== "string" || !last.content.trim())
    return false;
  const calls = typeof last.tool_calls === "string" ? JSON.parse(last.tool_calls) : last.tool_calls;
  return messages.length > user + 1 && (!calls || calls.length === 0);
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
  assert(!fs.existsSync(output));
  fs.mkdirSync(output, { recursive: true });
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
    binding = nativeCredentialBinding(configuration);
    if (!reuse) {
      assert(!fs.existsSync(state), "Fresh Hermes acceptance requires no saved configuration");
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
    const saved = JSON.parse(fs.readFileSync(path.join(state, "native-windows.json"), "utf8"));
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
      { env: observerEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
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
    const pty = createHermesPtyState();
    page.on("websocket", (socket: any) => {
      const url = new URL(socket.url());
      if (url.origin.replace(/^ws/u, "http") !== origin.origin) return;
      const channel = url.searchParams.get("channel");
      if (!channel) return;
      if (url.pathname === "/api/pty") {
        pty.bindPty(channel);
        socket.on("framereceived", () => pty.ptyData());
        socket.on("close", () => pty.ptyClosed());
      } else if (url.pathname === "/api/events") {
        pty.bindEvents(channel);
        socket.on("close", () => pty.eventsClosed(channel));
        socket.on("framereceived", ({ payload }: { payload: string | Buffer }) => {
          try {
            const text = typeof payload === "string" ? payload : payload.toString("utf8");
            assert(text.length <= 1024 * 1024);
            pty.receive(channel, JSON.parse(text));
          } catch {
            observerFailure = new Error("The actual PTY event frame is invalid or oversized");
          }
        });
      }
    });
    let sessionToken: string | undefined;
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
      await sleep(100);
    }
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
    const api = async (route: string) => {
      assert(route.startsWith("/api/") && !route.includes(".."));
      return await page.evaluate(
        async ({ route, token }: { route: string; token?: string }) => {
          const response = await fetch(route, {
            headers: token ? { "X-Hermes-Session-Token": token } : {},
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Hermes dashboard API returned " + response.status);
          const text = await response.text();
          if (text.length > 2 * 1024 * 1024)
            throw new Error("Hermes API evidence exceeds its bound");
          return JSON.parse(text);
        },
        { route, token: sessionToken },
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
    const messagesFor = async (prompt: string) => {
      const id = pty.storedSessionId();
      if (!id) return [];
      const detail = await api(
        "/api/sessions/" + encodeURIComponent(id) + "/messages?limit=500&order=latest",
      );
      assert.equal(detail.session_id, id);
      assert(Array.isArray(detail.messages));
      return detail.messages.some((row: any) => row.role === "user" && row.content === prompt)
        ? detail.messages
        : [];
    };
    let lastTurnMark = 0;
    const turn = async (prompt: string, accept: (messages: any[]) => unknown) => {
      const mark = pty.markTurn();
      lastTurnMark = mark;
      const start = performance.now();
      let lastMessages: any[] = [];
      await terminal.focus();
      await page.keyboard.insertText(prompt);
      await page.keyboard.press("Enter");
      while (performance.now() - start < 120_000) {
        if (observerFailure) throw observerFailure;
        pty.assertHealthy();
        const messages = await messagesFor(prompt);
        lastMessages = messages;
        const value = accept(messages);
        if (value && finalHermesAssistant(messages, prompt) && pty.settledAfter(mark))
          return {
            conversationElapsedMs: performance.now() - start,
            measurement: "end-to-end conversation interval including model, tools and UI/protocol",
            isolatedProviderLatencyMs: null,
            value,
          };
        if (finalHermesAssistant(messages, prompt) && pty.settledAfter(mark)) {
          results.failedTurn = {
            prompt,
            pty: pty.snapshot(),
            messages: messages.slice(
              messages.findIndex((row: any) => row.role === "user" && row.content === prompt),
            ),
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
        observer.stdin!.end("stop\n");
        assert.equal(await bounded(guardianClosed, 130_000), 0);
        assert.equal(await bounded(observerClosed, 5000), 0);
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
    if (!preserve || primary !== undefined || cleanupErrors.length) {
      try {
        if (fs.existsSync(state))
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
  write("installed-hermes-acceptance.json", {
    schemaVersion: 1,
    classification: "installed-canonical-hermes-acceptance",
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
