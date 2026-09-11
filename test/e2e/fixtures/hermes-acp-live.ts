// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import type { ArtifactSink } from "./artifacts.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { type ChildProcessProgress, spawnObservedChild } from "./observed-child-process.ts";
import { superviseChild } from "../../helpers/process-supervisor.ts";

const ACP_SCENARIO_TIMEOUT_MS = 3 * 60_000;
const ACP_SCENARIO_START_MINIMUM_MS = 10_000;
const ACP_SESSION_SHUTDOWN_RESERVE_MS = 5_000;
const ACP_MESSAGE_LIMIT_BYTES = 1024 * 1024;
const OPENSHELL_GATEWAY_NAME = "nemoclaw";

export const HERMES_ACP_LIFECYCLE_BUDGET_MS = 12 * 60_000;

type JsonObject = Record<string, unknown>;

export type HermesAcpLiveScenario =
  | "cancel"
  | "client-disconnect"
  | "exchange"
  | "gateway-recovery"
  | "gateway-restart"
  | "initialize"
  | "remote-exit";

export interface HermesAcpLiveOptions {
  readonly artifacts: ArtifactSink;
  readonly deadlineAtMs?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly progress: ChildProcessProgress;
  readonly restartGateway?: () => Promise<void>;
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
  readonly scenario: HermesAcpLiveScenario;
}

export function hermesAcpLiveHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CURL_CA_BUNDLE",
    "XDG_CONFIG_HOME",
    "NEMOCLAW_OPENSHELL_BIN",
    "OPENSHELL_GATEWAY",
    "OPENSHELL_WORKSPACE",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export function isAcpResponse(message: unknown, id: number): message is JsonObject {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as JsonObject).jsonrpc === "2.0" &&
    (message as JsonObject).id === id
  );
}

export function acpMessageContainsPong(value: unknown): boolean {
  if (typeof value === "string") return /\bPONG\b/iu.test(value);
  if (Array.isArray(value)) return value.some(acpMessageContainsPong);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as JsonObject).some(acpMessageContainsPong)
  );
}

function messageSessionIds(message: JsonObject): string[] {
  const ids: string[] = [];
  for (const value of [message.params, message.result]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const sessionId = (value as JsonObject).sessionId;
    if (typeof sessionId === "string") ids.push(sessionId);
  }
  return ids;
}

export function createHermesAcpPromptEvidenceTracker(): {
  markPromptWritten(sessionId: string): void;
  observe(message: JsonObject): void;
  readonly pongObserved: boolean;
} {
  let promptSessionId: string | null = null;
  let pongObserved = false;
  return {
    markPromptWritten(sessionId) {
      promptSessionId = sessionId;
    },
    observe(message) {
      if (!promptSessionId || !acpMessageContainsPong(message)) return;
      const sessionIds = messageSessionIds(message);
      if (sessionIds.includes(promptSessionId)) {
        pongObserved = true;
      }
    },
    get pongObserved() {
      return pongObserved;
    },
  };
}

export function hermesAcpExchangeEvidencePassed(evidence: {
  pongObserved: boolean;
  promptCompleted: boolean;
  sessionCreated: boolean;
}): boolean {
  return evidence.sessionCreated && evidence.promptCompleted && evidence.pongObserved;
}

export function hermesAcpScenarioTimeoutMs(deadlineAtMs: number, nowMs: number): number | null {
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs < ACP_SCENARIO_START_MINIMUM_MS) return null;
  return Math.min(ACP_SCENARIO_TIMEOUT_MS, remainingMs);
}

function sessionIdFromResponse(message: JsonObject | null): string | null {
  const result = message?.result;
  if (!result || typeof result !== "object") return null;
  const sessionId = (result as JsonObject).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256
    ? sessionId
    : null;
}

async function writeRequest(
  stream: NodeJS.WritableStream,
  request: JsonObject,
  onWritten?: () => void,
): Promise<boolean> {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload, "utf8") > 16 * 1024) return false;
  try {
    const accepted = stream.write(payload);
    onWritten?.();
    if (!accepted) await once(stream, "drain");
    return true;
  } catch {
    return false;
  }
}

function signalAdapter(child: ReturnType<typeof spawnObservedChild>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The adapter may have exited between the scenario decision and the signal.
  }
}

export function isProcessAbsent(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function terminateRemoteHermesAcp(
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const processes = await sandbox.exec(sandboxName, ["pgrep", "-x", "hermes-acp"], {
    artifactName: "hermes-acp-remote-nonzero-process",
    env: hermesAcpLiveHostEnv(env),
    timeoutMs: 30_000,
  });
  const pids = processes.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[1-9][0-9]*$/u.test(line));
  if (processes.exitCode !== 0 || pids.length !== 1) return false;
  const result = await sandbox.exec(sandboxName, ["kill", "-TERM", pids[0]!], {
    artifactName: "hermes-acp-remote-nonzero-termination",
    env: hermesAcpLiveHostEnv(env),
    timeoutMs: 30_000,
  });
  return result.exitCode === 0;
}

async function verifyNoRemoteHermesAcpProcess(
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  artifactName: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await sandbox.exec(sandboxName, ["pgrep", "-x", "hermes-acp"], {
      artifactName: `${artifactName}-${String(attempt)}`,
      env: hermesAcpLiveHostEnv(env),
      timeoutMs: 30_000,
    });
    if (result.exitCode === 1) return true;
    if (result.exitCode !== 0) return false;
    await sleep(1_000);
  }
  return false;
}

type HermesAcpLiveReceipt = Readonly<{
  adapterProcessAbsent: boolean;
  deadlineExpired: boolean;
  exitCode: number | null;
  initialized: boolean;
  passed: boolean;
  pongObserved: boolean;
  promptCompleted: boolean;
  remoteProcessAbsent: boolean;
  scenarioStarted: boolean;
  sessionCreated: boolean;
  signal: NodeJS.Signals | null;
  stderrObserved: boolean;
  timedOut: boolean;
}>;

async function writeHermesAcpLiveReceipt(
  options: HermesAcpLiveOptions,
  receipt: HermesAcpLiveReceipt,
): Promise<void> {
  await options.artifacts.writeJson(`hermes-acp-${options.scenario}.json`, {
    schemaVersion: 1,
    scenario: options.scenario,
    ...receipt,
    rawAcpPayloadRetained: false,
  });
}

/** Drive the real packaged adapter while retaining only fixed boolean and exit evidence. */
export async function runHermesAcpLiveScenario(options: HermesAcpLiveOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  const scenarioTimeoutMs =
    options.deadlineAtMs === undefined
      ? ACP_SCENARIO_TIMEOUT_MS
      : hermesAcpScenarioTimeoutMs(options.deadlineAtMs, now());
  if (scenarioTimeoutMs === null) {
    await writeHermesAcpLiveReceipt(options, {
      adapterProcessAbsent: true,
      deadlineExpired: true,
      exitCode: null,
      initialized: false,
      passed: false,
      pongObserved: false,
      promptCompleted: false,
      remoteProcessAbsent: true,
      scenarioStarted: false,
      sessionCreated: false,
      signal: null,
      stderrObserved: false,
      timedOut: false,
    });
    return false;
  }
  const adapterTimeoutSeconds = Math.max(
    1,
    Math.floor((scenarioTimeoutMs - ACP_SESSION_SHUTDOWN_RESERVE_MS) / 1_000),
  );
  const child = spawnObservedChild(
    "nemoclaw-acp",
    [
      "--sandbox",
      options.sandboxName,
      "--gateway",
      OPENSHELL_GATEWAY_NAME,
      "--timeout",
      String(adapterTimeoutSeconds),
    ],
    {
      activityLabel: `command: hermes-acp-${options.scenario}`,
      progress: options.progress,
      spawn: {
        detached: true,
        env: hermesAcpLiveHostEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    },
  );
  const input = child.stdin!;

  let buffered = "";
  let observedBytes = 0;
  let protocolValid = true;
  const promptEvidence = createHermesAcpPromptEvidenceTracker();
  let stderrObserved = false;
  let childClosed = false;
  const inbox: JsonObject[] = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as unknown;
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        protocolValid = false;
      } else {
        promptEvidence.observe(message as JsonObject);
        inbox.push(message as JsonObject);
      }
    } catch {
      protocolValid = false;
    }
    if (!protocolValid) signalAdapter(child, "SIGTERM");
    notify();
  };
  const supervise = superviseChild(child, {
    timeoutMs: scenarioTimeoutMs,
    killGraceMs: 1_000,
    onStdout: (chunk) => {
      observedBytes += Buffer.byteLength(chunk, "utf8");
      if (observedBytes > ACP_MESSAGE_LIMIT_BYTES) {
        protocolValid = false;
        signalAdapter(child, "SIGTERM");
        notify();
        return;
      }
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    onStderr: () => {
      stderrObserved = true;
    },
  });
  child.once("close", () => {
    childClosed = true;
    notify();
  });

  const nextResponse = async (id: number): Promise<JsonObject | null> => {
    for (;;) {
      const index = inbox.findIndex((message) => isAcpResponse(message, id));
      if (index >= 0) return inbox.splice(index, 1)[0]!;
      if (!protocolValid || childClosed) return null;
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  };

  let scenarioValid = await writeRequest(input, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "nemoclaw-e2e", version: "1.0.0" },
    },
  });
  const initialize = scenarioValid ? await nextResponse(1) : null;
  const initialized = typeof initialize?.result === "object" && initialize.result !== null;
  scenarioValid &&= initialized;

  let sessionCreated = false;
  let promptCompleted = false;
  if (scenarioValid && options.scenario === "cancel") {
    signalAdapter(child, "SIGTERM");
  } else if (scenarioValid && options.scenario === "client-disconnect") {
    input.end();
    child.stdout?.destroy();
    child.stderr?.destroy();
  } else if (scenarioValid && options.scenario === "gateway-restart") {
    if (!options.restartGateway) {
      scenarioValid = false;
      signalAdapter(child, "SIGTERM");
    } else {
      await options.restartGateway();
    }
  } else if (scenarioValid && options.scenario === "remote-exit") {
    scenarioValid = await terminateRemoteHermesAcp(
      options.sandbox,
      options.sandboxName,
      options.env,
    );
  } else if (
    scenarioValid &&
    (options.scenario === "exchange" || options.scenario === "gateway-recovery")
  ) {
    scenarioValid = await writeRequest(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/sandbox", mcpServers: [] },
    });
    const createSession = scenarioValid ? await nextResponse(2) : null;
    const sessionId = sessionIdFromResponse(createSession);
    sessionCreated = sessionId !== null;
    scenarioValid &&= sessionCreated;
    if (scenarioValid) {
      scenarioValid = await writeRequest(
        input,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly one word: PONG" }],
          },
        },
        () => promptEvidence.markPromptWritten(sessionId!),
      );
      const prompt = scenarioValid ? await nextResponse(3) : null;
      promptCompleted = typeof prompt?.result === "object" && prompt.result !== null;
      scenarioValid &&= promptCompleted;
      input.end();
    }
  } else if (scenarioValid) {
    input.end();
  }
  if (!scenarioValid) signalAdapter(child, "SIGTERM");

  const result = await supervise;
  if (buffered.trim()) consumeLine(buffered);
  scenarioValid &&= protocolValid;
  const expectedExit = {
    cancel: 143,
    "client-disconnect": 1,
    exchange: 0,
    "gateway-recovery": 0,
    "gateway-restart": 255,
    initialize: 0,
    "remote-exit": null,
  }[options.scenario];
  const exitValid =
    expectedExit === null
      ? typeof result.exitCode === "number" && result.exitCode > 0 && result.exitCode !== 255
      : result.exitCode === expectedExit;
  const remoteProcessAbsent = await verifyNoRemoteHermesAcpProcess(
    options.sandbox,
    options.sandboxName,
    options.env,
    `hermes-acp-${options.scenario}-remote-process-cleanup`,
  );
  const adapterProcessAbsent = isProcessAbsent(child.pid);
  const passed =
    !result.timedOut &&
    !result.spawnError &&
    exitValid &&
    initialized &&
    scenarioValid &&
    adapterProcessAbsent &&
    remoteProcessAbsent &&
    (options.scenario !== "gateway-recovery" || stderrObserved) &&
    (!["exchange", "gateway-recovery"].includes(options.scenario) ||
      hermesAcpExchangeEvidencePassed({
        pongObserved: promptEvidence.pongObserved,
        promptCompleted,
        sessionCreated,
      }));

  await writeHermesAcpLiveReceipt(options, {
    adapterProcessAbsent,
    deadlineExpired: options.deadlineAtMs !== undefined && now() >= options.deadlineAtMs,
    exitCode: result.exitCode,
    initialized,
    passed,
    pongObserved: promptEvidence.pongObserved,
    promptCompleted,
    remoteProcessAbsent,
    scenarioStarted: true,
    sessionCreated,
    signal: result.signal,
    stderrObserved,
    timedOut: result.timedOut,
  });
  return passed;
}
