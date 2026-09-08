// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import type { ArtifactSink } from "./artifacts.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { type ChildProcessProgress, spawnObservedChild } from "./observed-child-process.ts";
import { superviseChild } from "./shell/supervisor.ts";

const ACP_SCENARIO_TIMEOUT_MS = 7 * 60_000;
const ACP_MESSAGE_LIMIT_BYTES = 1024 * 1024;
const OPENSHELL_GATEWAY_NAME = "nemoclaw";

type JsonObject = Record<string, unknown>;

export type HermesAcpLiveScenario =
  | "cancel"
  | "client-disconnect"
  | "exchange"
  | "gateway-recovery"
  | "initialize"
  | "remote-exit";

export interface HermesAcpLiveOptions {
  readonly artifacts: ArtifactSink;
  readonly env: NodeJS.ProcessEnv;
  readonly progress: ChildProcessProgress;
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

function sessionIdFromResponse(message: JsonObject | null): string | null {
  const result = message?.result;
  if (!result || typeof result !== "object") return null;
  const sessionId = (result as JsonObject).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256
    ? sessionId
    : null;
}

async function writeRequest(stream: NodeJS.WritableStream, request: JsonObject): Promise<boolean> {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload, "utf8") > 16 * 1024) return false;
  try {
    if (!stream.write(payload)) await once(stream, "drain");
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

async function stopOpenShellGateway(options: HermesAcpLiveOptions): Promise<boolean> {
  const result = await options.sandbox.openshell(
    ["gateway", "stop", "-g", OPENSHELL_GATEWAY_NAME],
    {
      artifactName: "hermes-acp-gateway-recovery-stop",
      env: hermesAcpLiveHostEnv(options.env),
      timeoutMs: 60_000,
    },
  );
  return result.exitCode === 0;
}

/** Drive the real packaged adapter while retaining only fixed boolean and exit evidence. */
export async function runHermesAcpLiveScenario(options: HermesAcpLiveOptions): Promise<boolean> {
  if (options.scenario === "gateway-recovery" && !(await stopOpenShellGateway(options))) {
    return false;
  }
  const child = spawnObservedChild(
    "nemoclaw-acp",
    ["--sandbox", options.sandboxName, "--gateway", OPENSHELL_GATEWAY_NAME, "--timeout", "360"],
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
  let pongObserved = false;
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
        pongObserved ||= acpMessageContainsPong(message);
        inbox.push(message as JsonObject);
      }
    } catch {
      protocolValid = false;
    }
    if (!protocolValid) signalAdapter(child, "SIGTERM");
    notify();
  };
  const supervise = superviseChild(child, {
    timeoutMs: ACP_SCENARIO_TIMEOUT_MS,
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
    child.stdout?.destroy();
    scenarioValid = await writeRequest(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "nemoclaw-e2e-disconnected", version: "1.0.0" },
      },
    });
  } else if (scenarioValid && options.scenario === "remote-exit") {
    scenarioValid = await terminateRemoteHermesAcp(
      options.sandbox,
      options.sandboxName,
      options.env,
    );
  } else if (scenarioValid && options.scenario === "exchange") {
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
      scenarioValid = await writeRequest(input, {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "Reply with exactly one word: PONG" }],
        },
      });
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
    (options.scenario !== "exchange" || (sessionCreated && promptCompleted && pongObserved));

  await options.artifacts.writeJson(`hermes-acp-${options.scenario}.json`, {
    schemaVersion: 1,
    scenario: options.scenario,
    initialized,
    sessionCreated,
    promptCompleted,
    pongObserved,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stderrObserved,
    adapterProcessAbsent,
    remoteProcessAbsent,
    rawAcpPayloadRetained: false,
    passed,
  });
  return passed;
}
