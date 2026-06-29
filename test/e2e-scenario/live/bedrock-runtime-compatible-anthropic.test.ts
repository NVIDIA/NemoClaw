// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as http2 from "node:http2";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import { redactString } from "../fixtures/redaction.ts";
import {
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_INVALID_STATE,
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_REMOVAL_CONDITION,
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SKIP_REASON,
  BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SOURCE_BOUNDARY,
  isPreContractEndpointValidationRateLimitEvidence,
} from "./bedrock-runtime-compatible-anthropic-rate-limit.ts";

// Direct Vitest migration for test/e2e/test-bedrock-runtime-compatible-anthropic.sh.
// Keep the same live system boundary: host fake Bedrock Runtime endpoint,
// /etc/hosts mapping, source CLI onboard, OpenShell provider route, sandbox
// config/runtime probes, adapter breadcrumbs, and leak scan.

const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const BEDROCK_HOSTNAME = "bedrock-runtime.us-east-1.amazonaws.com";
const BEDROCK_MOCK_PORT = Number(process.env.NEMOCLAW_BEDROCK_RUNTIME_MOCK_PORT ?? "18147");
const BEDROCK_ADAPTER_PORT = 11436;
const BEDROCK_ENDPOINT_URL = `http://${BEDROCK_HOSTNAME}:${BEDROCK_MOCK_PORT}`;
const BEDROCK_MODEL =
  process.env.NEMOCLAW_BEDROCK_RUNTIME_MODEL ?? "anthropic.claude-3-5-sonnet-20240620-v1:0";
const COMPATIBLE_KEY =
  process.env.NEMOCLAW_BEDROCK_RUNTIME_FAKE_KEY ?? "fake-pasted-bedrock-runtime-key-e2e";
const AGENT = process.env.NEMOCLAW_AGENT ?? "openclaw";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-bedrock-${AGENT}`;
const RUN_BEDROCK_TEST = shouldRunLiveE2EScenarios() ? test : test.skip;
const ONBOARD_TIMEOUT_MS = 30 * 60_000;
const TEST_TIMEOUT_MS = 60 * 60_000;
const SANDBOX_TIMEOUT_MS = 180_000;

type AgentName = "openclaw" | "hermes";
type CommandText = { stdout: string; stderr: string };
type EventHeader = { type: "string"; value: string };
type EventStreamCodec = {
  encode(message: { headers: Record<string, EventHeader>; body: Uint8Array }): Uint8Array;
};
type EventStreamCodecConstructor = new (
  toUtf8: (input: Uint8Array) => string,
  fromUtf8: (input: string) => Uint8Array,
) => EventStreamCodec;

interface RawRunResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly redactedStdout: string;
  readonly redactedStderr: string;
}

interface RawRunOptions {
  readonly artifactName: string;
  readonly artifacts: ArtifactSink;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly redactionValues?: readonly string[];
  readonly timeoutMs?: number;
}

interface MockBedrockRuntime {
  readonly port: number;
  readonly logs: readonly string[];
  readonly converseCount: number;
  readonly streamCount: number;
  close(): Promise<void>;
}

function resultText(result: CommandText): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function redactedResultText(
  result: Pick<RawRunResult, "redactedStdout" | "redactedStderr">,
): string {
  return [result.redactedStdout, result.redactedStderr].filter(Boolean).join("\n");
}

function evidenceTail(text: string): string {
  return text.slice(-4_000);
}

function expectExitZero(result: CommandText & { exitCode: number | null }, label: string): void {
  expect(result.exitCode, `${label} failed:\n${resultText(result)}`).toBe(0);
}

function isMissingSandboxCleanupOutput(text: string): boolean {
  return /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox (?:.* )?not found|no such sandbox/i.test(
    text,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sandboxShellArgs(script: string): string[] {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return ["sh", "-lc", `printf %s ${shellQuote(encoded)} | base64 -d | sh`];
}

function assertAgent(value: string): asserts value is AgentName {
  if (value !== "openclaw" && value !== "hermes") {
    throw new Error(`NEMOCLAW_AGENT must be openclaw or hermes, got ${value}`);
  }
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv({ ...process.env, HOME: home });
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), base.PATH].filter(Boolean).join(":"),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

function onboardEnv(home: string, agent: AgentName): NodeJS.ProcessEnv {
  return testEnv(home, {
    COMPATIBLE_ANTHROPIC_API_KEY: COMPATIBLE_KEY,
    NEMOCLAW_AGENT: agent,
    NEMOCLAW_ENDPOINT_URL: BEDROCK_ENDPOINT_URL,
    NEMOCLAW_MODEL: BEDROCK_MODEL,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "anthropicCompatible",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_YES: "1",
  });
}

function redactedCommand(command: readonly string[], values: readonly string[]): string[] {
  return command.map((part) => redactString(part, values));
}

async function runRawCommand(
  command: string,
  args: readonly string[],
  options: RawRunOptions,
): Promise<RawRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const redactionValues = [...(options.redactionValues ?? [])];
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? REPO_ROOT,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fullCommand = [command, ...args];
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError: Error | undefined;

  const killProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup("SIGTERM");
    setTimeout(() => killProcessGroup("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });
  clearTimeout(timeout);

  if (spawnError) {
    const message = redactString(spawnError.message, redactionValues);
    throw new Error(`failed to spawn ${redactString(command, redactionValues)}: ${message}`);
  }

  const redactedStdout = redactString(stdout, redactionValues);
  const redactedStderr = redactString(stderr, redactionValues);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stdout.txt`, redactedStdout);
  await options.artifacts.writeText(`raw-shell/${options.artifactName}.stderr.txt`, redactedStderr);
  await options.artifacts.writeJson(`raw-shell/${options.artifactName}.result.json`, {
    command: redactedCommand(fullCommand, redactionValues),
    exitCode,
    signal,
    timedOut,
    stdout: redactedStdout,
    stderr: redactedStderr,
  });

  return {
    command: fullCommand,
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    redactedStdout,
    redactedStderr,
  };
}

function loadEventStreamCodec(): EventStreamCodec {
  const loaded = require("@smithy/core/event-streams") as {
    EventStreamCodec: EventStreamCodecConstructor;
  };
  return new loaded.EventStreamCodec(
    (input) => Buffer.from(input).toString("utf8"),
    (input) => Buffer.from(input, "utf8"),
  );
}

function eventMessage(codec: EventStreamCodec, eventType: string, payload: unknown): Buffer {
  return Buffer.from(
    codec.encode({
      headers: {
        ":message-type": { type: "string", value: "event" },
        ":event-type": { type: "string", value: eventType },
        ":content-type": { type: "string", value: "application/json" },
      },
      body: Buffer.from(JSON.stringify(payload), "utf8"),
    }),
  );
}

function parseModelPath(
  pathname: string,
): { model: string; operation: "converse" | "converse-stream" } | null {
  const match = pathname.match(/^\/model\/(.+)\/(converse|converse-stream)$/);
  if (!match) return null;
  return {
    model: decodeURIComponent(match[1] ?? ""),
    operation: match[2] as "converse" | "converse-stream",
  };
}

function sendHttp2Json(stream: http2.ServerHttp2Stream, status: number, payload: unknown): void {
  stream.respond({
    [http2.constants.HTTP2_HEADER_STATUS]: status,
    [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/json",
  });
  stream.end(JSON.stringify(payload));
}

function conversePayload() {
  return {
    output: {
      message: {
        role: "assistant",
        content: [{ text: "PONG" }],
      },
    },
    stopReason: "end_turn",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    metrics: {
      latencyMs: 1,
    },
  };
}

function sendConverseStream(stream: http2.ServerHttp2Stream, codec: EventStreamCodec): void {
  stream.respond({
    [http2.constants.HTTP2_HEADER_STATUS]: 200,
    [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/vnd.amazon.eventstream",
    "x-amzn-bedrock-content-type": "application/json",
  });
  stream.write(eventMessage(codec, "messageStart", { role: "assistant" }));
  stream.write(
    eventMessage(codec, "contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: "PONG" },
    }),
  );
  stream.write(eventMessage(codec, "contentBlockStop", { contentBlockIndex: 0 }));
  stream.write(eventMessage(codec, "messageStop", { stopReason: "end_turn" }));
  stream.write(
    eventMessage(codec, "metadata", {
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 1 },
    }),
  );
  stream.end();
}

async function waitForTcpPort(port: number): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(value);
      };
      socket.on("connect", () => finish(true));
      socket.on("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`fake Bedrock Runtime endpoint did not listen on 127.0.0.1:${port}`);
}

async function startFakeBedrockRuntimeMock(options: {
  port: number;
  expectedBearer: string;
  expectedModel: string;
}): Promise<MockBedrockRuntime> {
  const codec = loadEventStreamCodec();
  const logs: string[] = [];
  let converseCount = 0;
  let streamCount = 0;
  const record = (line: string): void => {
    logs.push(line);
  };
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();

  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });

  server.on("stream", (rawStream, headers) => {
    const stream = rawStream as http2.ServerHttp2Stream;
    const method = String(headers[http2.constants.HTTP2_HEADER_METHOD] ?? "");
    const pathname = String(headers[http2.constants.HTTP2_HEADER_PATH] ?? "");
    const auth = String(headers[http2.constants.HTTP2_HEADER_AUTHORIZATION] ?? "");
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      try {
        const parsed = parseModelPath(pathname);
        if (method !== "POST" || !parsed) {
          sendHttp2Json(stream, 404, { message: "not found" });
          return;
        }

        const opLabel = parsed.operation === "converse-stream" ? "converse-stream" : "converse";
        if (auth !== `Bearer ${options.expectedBearer}`) {
          record(`POST /model/${opLabel} auth=missing`);
          sendHttp2Json(stream, 401, { message: "missing bearer credential" });
          return;
        }

        record(`POST /model/${opLabel} auth=ok`);
        if (parsed.operation === "converse-stream") streamCount += 1;
        else converseCount += 1;

        if (parsed.model !== options.expectedModel) {
          sendHttp2Json(stream, 400, { message: "unexpected model id" });
          return;
        }

        if (parsed.operation === "converse-stream") {
          sendConverseStream(stream, codec);
          return;
        }
        sendHttp2Json(stream, 200, conversePayload());
      } catch (error) {
        record(`stream_handler_error=${error instanceof Error ? error.message : String(error)}`);
        stream.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  server.on("sessionError", (err) => {
    record(`session_error=${err && "code" in err ? String(err.code) : "unknown"}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      record("fake_bedrock_runtime_ready");
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
  await waitForTcpPort(options.port);

  return {
    port: options.port,
    get logs() {
      return logs;
    },
    get converseCount() {
      return converseCount;
    },
    get streamCount() {
      return streamCount;
    },
    close: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        server.close(finish);
        for (const session of sessions) session.close();
        setTimeout(() => {
          for (const session of sessions) session.destroy();
          finish();
        }, 1_000).unref();
      }),
  };
}

async function bestEffort(run: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup must not hide the primary E2E failure.
  }
}

async function cleanupNemoClawSandbox(host: HostCliClient, home: string): Promise<void> {
  const result = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "cleanup-nemoclaw-destroy-bedrock-runtime",
    env: testEnv(home),
    timeoutMs: 180_000,
  });
  if (result.exitCode === 0 || isMissingSandboxCleanupOutput(resultText(result))) return;
  expectExitZero(result, `cleanup NemoClaw sandbox ${SANDBOX_NAME}`);
}

async function cleanupOpenShellSandbox(host: HostCliClient, home: string): Promise<void> {
  const result = await host.command(
    "bash",
    [
      "-lc",
      'if ! command -v openshell >/dev/null 2>&1; then exit 0; fi; openshell sandbox delete "$1"',
      "cleanup-openshell-sandbox-delete",
      SANDBOX_NAME,
    ],
    {
      artifactName: "cleanup-openshell-sandbox-delete-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 60_000,
    },
  );
  if (result.exitCode === 0 || isMissingSandboxCleanupOutput(resultText(result))) return;
  expectExitZero(result, `cleanup OpenShell sandbox ${SANDBOX_NAME}`);
}

async function cleanupOpenShellGateway(host: HostCliClient, home: string): Promise<void> {
  await host.command(
    "bash",
    [
      "-lc",
      "if ! command -v openshell >/dev/null 2>&1; then exit 0; fi; openshell gateway destroy -g nemoclaw",
    ],
    {
      artifactName: "cleanup-openshell-gateway-destroy-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 120_000,
    },
  );
}

async function cleanupSandboxState(host: HostCliClient, home: string): Promise<void> {
  await bestEffort(() => cleanupNemoClawSandbox(host, home));
  await bestEffort(() => cleanupOpenShellSandbox(host, home));
  await bestEffort(() => cleanupOpenShellGateway(host, home));
}

function stopBedrockAdapterBestEffort(home: string): void {
  const stateFile = path.join(home, ".nemoclaw", "bedrock-runtime-adapter.json");
  const pidFile = path.join(home, ".nemoclaw", "bedrock-runtime-adapter.pid");
  const tokenFile = path.join(home, ".nemoclaw", "bedrock-runtime-adapter-token");
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { endpointUrl?: unknown };
      if (state.endpointUrl !== BEDROCK_ENDPOINT_URL) return;
    }
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && isBedrockAdapterProcess(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already stopped.
        }
      }
    }
  } finally {
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(tokenFile, { force: true });
    fs.rmSync(stateFile, { force: true });
  }
}

function isBedrockAdapterProcess(pid: number): boolean {
  const expectedScript = "bedrock-runtime-adapter.js";
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    if (cmdline.includes(expectedScript)) return true;
  } catch {
    // Fall back to ps on platforms without procfs.
  }

  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return ps.status === 0 && ps.stdout.includes(expectedScript);
}

async function restoreHostsFile(
  host: HostCliClient,
  backupPath: string,
  backupDir: string,
  home: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("sudo", ["cp", backupPath, "/etc/hosts"], {
      artifactName: "restore-etc-hosts-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    }),
  );
  await bestEffort(() =>
    host.command("sudo", ["rm", "-rf", backupDir], {
      artifactName: "remove-etc-hosts-backup-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    }),
  );
  await bestEffort(() => fs.rmSync(backupDir, { recursive: true, force: true }));
}

async function mapBedrockHostToLoopback(
  host: HostCliClient,
  home: string,
  backupPath: string,
  skip: (note?: string) => never,
): Promise<void> {
  const sudo = await host.command("sudo", ["-n", "true"], {
    artifactName: "prereq-passwordless-sudo-bedrock-runtime",
    env: testEnv(home),
    timeoutMs: 30_000,
  });
  if (sudo.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(
        "passwordless sudo is required to edit /etc/hosts for Bedrock hostname mapping",
      );
    }
    skip("passwordless sudo is required to edit /etc/hosts for Bedrock hostname mapping");
  }

  expectExitZero(
    await host.command("sudo", ["cp", "/etc/hosts", backupPath], {
      artifactName: "backup-etc-hosts-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    }),
    "backup /etc/hosts",
  );
  expectExitZero(
    await host.command(
      "bash",
      [
        "-lc",
        `printf '\\n127.0.0.1 %s\\n' "$BEDROCK_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null`,
      ],
      {
        artifactName: "map-bedrock-hostname-to-loopback",
        env: testEnv(home, { BEDROCK_HOSTNAME }),
        timeoutMs: 30_000,
      },
    ),
    "map Bedrock hostname to loopback",
  );
  const probe = await host.command(
    "python3",
    [
      "-c",
      "import os,socket; raise SystemExit(0 if socket.gethostbyname(os.environ['BEDROCK_HOSTNAME']) == '127.0.0.1' else 1)",
    ],
    {
      artifactName: "probe-bedrock-hostname-loopback",
      env: testEnv(home, { BEDROCK_HOSTNAME }),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(probe, "Bedrock Runtime hostname maps to localhost");
}

async function prepareSourceCliAndOpenShell(host: HostCliClient, home: string): Promise<void> {
  expect(
    fs.existsSync(DIST_ENTRYPOINT),
    "run `npm run build:cli` before live Bedrock Runtime compatible Anthropic scenarios",
  ).toBe(true);
  expectExitZero(
    await host.command("node", [CLI_ENTRYPOINT, "--version"], {
      artifactName: "source-cli-version-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    }),
    "source CLI version",
  );

  const openshell = await host.command(
    "bash",
    ["-lc", "command -v openshell >/dev/null && openshell --version"],
    {
      artifactName: "prereq-openshell-version-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    },
  );
  if (openshell.exitCode === 0) return;

  const install = await host.command(
    "bash",
    [path.join(REPO_ROOT, "scripts", "install-openshell.sh")],
    {
      artifactName: "install-openshell-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 240_000,
    },
  );
  expectExitZero(install, "Install OpenShell CLI");
  expectExitZero(
    await host.command("bash", ["-lc", "openshell --version"], {
      artifactName: "post-install-openshell-version-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    }),
    "OpenShell CLI available after install",
  );
}

async function assertOnboardIdentity(home: string, agent: AgentName): Promise<void> {
  const sessionPath = path.join(home, ".nemoclaw", "onboard-session.json");
  const registryPath = path.join(home, ".nemoclaw", "sandboxes.json");
  const errors: string[] = [];
  const expectedProvider = "compatible-anthropic-endpoint";

  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as Record<string, unknown>;
    if (session.sandboxName !== SANDBOX_NAME)
      errors.push(`session sandboxName=${String(session.sandboxName)}`);
    if (session.agent != null && session.agent !== agent)
      errors.push(`session agent=${String(session.agent)}`);
    if (session.provider !== expectedProvider)
      errors.push(`session provider=${String(session.provider)}`);
    if (session.model !== BEDROCK_MODEL) errors.push(`session model=${String(session.model)}`);
  } catch (error) {
    errors.push(`session read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      sandboxes?: Record<string, Record<string, unknown>>;
    };
    const sandbox = registry.sandboxes?.[SANDBOX_NAME];
    if (!sandbox) {
      errors.push(`registry sandbox ${SANDBOX_NAME} missing`);
    } else {
      if (sandbox.agent != null && sandbox.agent !== agent)
        errors.push(`registry agent=${String(sandbox.agent)}`);
      if (sandbox.provider !== expectedProvider)
        errors.push(`registry provider=${String(sandbox.provider)}`);
      if (sandbox.model !== BEDROCK_MODEL) errors.push(`registry model=${String(sandbox.model)}`);
    }
  } catch (error) {
    errors.push(`registry read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  expect(errors).toEqual([]);
}

async function assertAdapterHealth(host: HostCliClient, home: string): Promise<void> {
  const health = await host.command(
    "curl",
    ["-sf", "--max-time", "5", `http://127.0.0.1:${BEDROCK_ADAPTER_PORT}/health`],
    {
      artifactName: "bedrock-runtime-adapter-health",
      env: testEnv(home),
      timeoutMs: 10_000,
    },
  );
  expectExitZero(health, "Bedrock Runtime adapter health endpoint");
  const parsed = JSON.parse(health.stdout) as {
    ok?: unknown;
    endpointUrl?: unknown;
    region?: unknown;
    tokenHash?: unknown;
  };
  expect(parsed.ok).toBe(true);
  expect(parsed.endpointUrl).toBe(BEDROCK_ENDPOINT_URL);
  expect(parsed.region).toBe("us-east-1");
  expect(typeof parsed.tokenHash).toBe("string");
  expect(String(parsed.tokenHash).length).toBeGreaterThan(0);
}

async function assertOpenShellProviderRoute(host: HostCliClient, home: string): Promise<void> {
  const route = await host.command(
    "bash",
    ["-lc", "openshell inference get -g nemoclaw 2>&1 || openshell inference get 2>&1"],
    {
      artifactName: "openshell-inference-route-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(route, "openshell inference get");
  const plainRoute = route.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plainRoute).toContain("Provider: compatible-anthropic-endpoint");
  expect(plainRoute).toContain(`Model: ${BEDROCK_MODEL}`);

  const provider = await host.command(
    "openshell",
    ["provider", "get", "-g", "nemoclaw", "compatible-anthropic-endpoint"],
    {
      artifactName: "openshell-provider-get-compatible-anthropic-endpoint",
      env: testEnv(home),
      timeoutMs: 30_000,
    },
  );
  expectExitZero(provider, "OpenShell provider registry exposes compatible-anthropic-endpoint");
  expect(provider.stdout || provider.stderr).toContain("compatible-anthropic-endpoint");
}

function parseChatContent(raw: string): string {
  const response = JSON.parse(raw) as {
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown };
      text?: unknown;
    }>;
  };
  const choice = response.choices?.[0];
  const content =
    choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.text ?? "";
  return typeof content === "string" ? content.trim() : "";
}

function parseOpenClawAgentText(raw: string): string {
  if (!raw.trim()) return "";
  const docs: unknown[] = [];
  try {
    docs.push(JSON.parse(raw));
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        docs.push(JSON.parse(raw.slice(first, last + 1)));
      } catch {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            docs.push(JSON.parse(trimmed));
          } catch {
            // Ignore non-JSON wrapper lines.
          }
        }
      }
    }
  }

  const parts: string[] = [];
  const visited = new Set<unknown>();
  const collect = (value: unknown): void => {
    if (value == null || visited.has(value)) return;
    if (typeof value === "string") {
      if (value.trim()) parts.push(value.trim());
      return;
    }
    if (typeof value !== "object") return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "reasoning_content"]) {
      collect(record[key]);
    }
    for (const choice of Array.isArray(record.choices) ? record.choices : []) {
      collect(choice);
    }
    for (const key of [
      "result",
      "payloads",
      "payload",
      "messages",
      "response",
      "data",
      "output",
      "outputs",
      "items",
      "segments",
      "delta",
      "message",
    ]) {
      collect(record[key]);
    }
  };

  for (const doc of docs) {
    const record =
      doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
    collect(record.result && typeof record.result === "object" ? record.result : doc);
  }
  return parts.join("\n");
}

async function assertOpenClawConfig(sandbox: SandboxClient, home: string): Promise<void> {
  const output = await sandbox.exec(
    SANDBOX_NAME,
    ["python3", "-c", OPENCLAW_CONFIG_PROBE, BEDROCK_MODEL],
    {
      artifactName: "openclaw-config-summary-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: SANDBOX_TIMEOUT_MS,
    },
  );
  expectExitZero(output, "OpenClaw config uses only managed inference.local provider");
}

const OPENCLAW_CONFIG_PROBE = [
  "import json,sys",
  "model=sys.argv[1]",
  'cfg=json.load(open("/sandbox/.openclaw/openclaw.json", encoding="utf-8"))',
  "errors=[]",
  'providers=cfg.get("models",{}).get("providers",{})',
  "provider_keys=sorted(providers.keys()) if isinstance(providers,dict) else []",
  'inference=providers.get("inference") if isinstance(providers,dict) else None',
  'errors.append("provider keys are %r" % provider_keys) if provider_keys != ["inference"] else None',
  'errors.append("models.providers.inference is missing") if not isinstance(inference,dict) else None',
  'errors.append("inference baseUrl is %r" % inference.get("baseUrl")) if isinstance(inference,dict) and inference.get("baseUrl") != "https://inference.local/v1" else None',
  'errors.append("inference apiKey is not the non-secret placeholder") if isinstance(inference,dict) and inference.get("apiKey") != "unused" else None',
  'errors.append("inference api is %r" % inference.get("api")) if isinstance(inference,dict) and inference.get("api") != "openai-completions" else None',
  'primary=cfg.get("agents",{}).get("defaults",{}).get("model",{}).get("primary")',
  'errors.append("primary model is %r" % primary) if primary != "inference/" + model else None',
  'print(json.dumps({"provider_keys":provider_keys,"inference_base":inference.get("baseUrl") if isinstance(inference,dict) else None,"inference_api_key":inference.get("apiKey") if isinstance(inference,dict) else None,"primary":primary,"errors":errors}))',
  "sys.exit(1 if errors else 0)",
].join("; ");

async function assertHermesConfig(sandbox: SandboxClient, home: string): Promise<void> {
  const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/config.yaml"], {
    artifactName: "hermes-config-bedrock-runtime",
    env: testEnv(home),
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  expectExitZero(config, "read Hermes config.yaml");
  const model: Record<string, string> = {};
  let inModel = false;
  for (const line of config.stdout.split("\n")) {
    if (/^model:\s*$/.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel && /^[A-Za-z0-9_-]+:/.test(line)) break;
    if (!inModel) continue;
    const match = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]?.trim() ?? "";
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      ['"', "'"].includes(value[0])
    ) {
      value = value.slice(1, -1);
    }
    model[match[1] ?? ""] = value;
  }

  const errors: string[] = [];
  if (model.default !== BEDROCK_MODEL) errors.push(`model.default=${String(model.default)}`);
  if (model.base_url !== "https://inference.local/v1")
    errors.push(`model.base_url=${String(model.base_url)}`);
  if (model.api_key === "<REDACTED>") {
    expectExitZero(
      await sandbox.exec(SANDBOX_NAME, ["python3", "-c", HERMES_CONFIG_API_KEY_PROBE], {
        artifactName: "hermes-config-api-key-probe-bedrock-runtime",
        env: testEnv(home),
        timeoutMs: SANDBOX_TIMEOUT_MS,
      }),
      "Hermes config api_key uses sk- placeholder",
    );
  } else if (!model.api_key?.startsWith("sk-")) {
    errors.push(`model.api_key=${String(model.api_key)}`);
  }
  if (/^models:\s*\n(?:[ \t].*\n)*?[ \t]+providers:/m.test(config.stdout)) {
    errors.push("OpenClaw-style models.providers block present");
  }
  if (config.stdout.includes("openshell:")) errors.push("OpenShell provider placeholder present");
  expect(errors).toEqual([]);
}

const HERMES_CONFIG_API_KEY_PROBE = [
  "import pathlib,re,sys",
  'text=pathlib.Path("/sandbox/.hermes/config.yaml").read_text(encoding="utf-8")',
  'section=re.search(r"(?ms)^model:\\s*\\n((?:[ \\t].*\\n)*)", text)',
  'body=section.group(1) if section else ""',
  'match=re.search(r"(?m)^[ \\t]+api_key:\\s*(.*?)\\s*$", body)',
  'value=match.group(1).strip() if match else ""',
  'value=value[1:-1] if len(value)>=2 and value[0]==value[-1] and value[0] in "\\"\'" else value',
  'ok=value.startswith("sk-")',
  'print("OK" if ok else "model.api_key missing sk- placeholder")',
  "sys.exit(0 if ok else 1)",
].join("; ");

async function assertSandboxInference(sandbox: SandboxClient, home: string): Promise<void> {
  const payload = JSON.stringify({
    model: BEDROCK_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 32,
  });
  const response = await sandbox.exec(
    SANDBOX_NAME,
    [
      "curl",
      "-sS",
      "--max-time",
      "90",
      "https://inference.local/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      payload,
    ],
    {
      artifactName: "sandbox-inference-local-bedrock-runtime",
      env: testEnv(home),
      redactionValues: [COMPATIBLE_KEY],
      timeoutMs: 120_000,
    },
  );
  expectExitZero(response, "sandbox inference.local chat completion");
  expect(parseChatContent(response.stdout)).toMatch(/PONG/i);
}

async function assertOpenClawAgentTurn(sandbox: SandboxClient, home: string): Promise<void> {
  const sessionId = `bedrock-openclaw-e2e-${Date.now()}-${randomUUID()}`;
  const remote = [
    `rm -f /sandbox/.openclaw/agents/main/sessions/${shellQuote(sessionId)}.jsonl.lock`,
    `rm -f /sandbox/.openclaw/agents/main/sessions/${shellQuote(sessionId)}.trajectory.jsonl 2>/dev/null || true`,
    `nemoclaw-start openclaw agent --agent main --json --session-id ${shellQuote(sessionId)} -m 'Reply with only: PONG'`,
  ].join("; ");
  const raw = await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", remote], {
    artifactName: "openclaw-agent-turn-bedrock-runtime",
    env: testEnv(home),
    redactionValues: [COMPATIBLE_KEY],
    timeoutMs: 240_000,
  });
  expect(resultText(raw)).not.toMatch(
    /SsrFBlockedError|Blocked hostname|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error|bedrock_runtime_error/i,
  );
  expectExitZero(raw, "OpenClaw agent turn through Bedrock adapter");
  expect(parseOpenClawAgentText(raw.stdout || raw.stderr)).toMatch(/PONG/i);
}

async function assertHermesApiChat(sandbox: SandboxClient, home: string): Promise<void> {
  const payload = JSON.stringify({
    model: BEDROCK_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 32,
  });
  const remote =
    "set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; " +
    `if [ -n "\${API_SERVER_KEY:-}" ]; then curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY}" -d ${shellQuote(payload)}; ` +
    `else curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d ${shellQuote(payload)}; fi`;
  const response = await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", remote], {
    artifactName: "hermes-local-chat-api-bedrock-runtime",
    env: testEnv(home),
    redactionValues: [COMPATIBLE_KEY],
    timeoutMs: 180_000,
  });
  expectExitZero(response, "Hermes local chat API through Bedrock adapter");
  expect(parseChatContent(response.stdout)).toMatch(/PONG/i);
}

function readAdapterToken(home: string): string {
  const tokenPath = path.join(home, ".nemoclaw", "bedrock-runtime-adapter-token");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  expect(token, "adapter token file was not created on the host").not.toBe("");
  return token;
}

function adapterLogPath(home: string): string {
  return path.join(home, ".nemoclaw", "bedrock-runtime-adapter.log");
}

function assertAdapterLogBreadcrumbs(home: string, agent: AgentName): void {
  const logPath = adapterLogPath(home);
  expect(fs.existsSync(logPath), "Bedrock Runtime adapter host log was not written").toBe(true);
  const log = fs.readFileSync(logPath, "utf8");
  expect(log).toContain('"event":"request_completed"');
  expect(log).toContain('"operation":"converse"');
  expect(log).toContain(BEDROCK_MODEL);
  if (agent === "openclaw") {
    expect(log).toContain('"operation":"converse_stream"');
  }
}

const SNAPSHOT_SCRIPT = trustedSandboxShellScript(`
set +e
emit_file() {
  path="$1"
  [ -r "$path" ] || return 0
  size=$(wc -c <"$path" 2>/dev/null || echo 0)
  [ "$size" -le 1048576 ] || return 0
  printf '\\n@@NEMOCLAW_E2E_FILE@@ %s\\n' "$path"
  tr '\\000' '\\n' <"$path" 2>/dev/null || true
}

for root in /sandbox/.openclaw /sandbox/.hermes /etc/nemoclaw /tmp; do
  [ -e "$root" ] || continue
  find "$root" -maxdepth 4 -type f 2>/dev/null | while IFS= read -r file; do
    case "$file" in
      */node_modules/*|*/.git/*) continue ;;
    esac
    emit_file "$file"
  done
done

for proc_dir in /proc/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  for name in environ cmdline; do
    emit_file "$proc_dir/$name"
  done
done
`);

function findForbiddenLeaks(
  text: string,
  label: string,
  patterns: Array<[string, string]>,
): string[] {
  const locations: string[] = [];
  let current = label;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@NEMOCLAW_E2E_FILE@@ ")) {
      current = line.slice("@@NEMOCLAW_E2E_FILE@@ ".length);
      continue;
    }
    for (const [name, value] of patterns) {
      if (value && line.includes(value)) locations.push(`${name}: ${current}`);
    }
  }
  return [...new Set(locations)].sort();
}

function isPreContractEndpointValidationRateLimit(options: {
  mock: MockBedrockRuntime | undefined;
  onboarding: RawRunResult;
}): boolean {
  return isPreContractEndpointValidationRateLimitEvidence({
    onboardingExitCode: options.onboarding.exitCode,
    redactedStdout: options.onboarding.redactedStdout,
    redactedStderr: options.onboarding.redactedStderr,
    mockConverseCount: options.mock?.converseCount ?? 0,
    mockConverseStreamCount: options.mock?.streamCount ?? 0,
  });
}

async function skipPreContractEndpointValidationRateLimit(options: {
  artifacts: ArtifactSink;
  mock: MockBedrockRuntime | undefined;
  onboarding: RawRunResult;
  skip: (note?: string) => never;
}): Promise<void> {
  if (!isPreContractEndpointValidationRateLimit(options)) return;
  await options.artifacts.writeJson("transient-provider-validation.skip.json", {
    id: "bedrock-runtime-compatible-anthropic",
    status: "skipped",
    reason: BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SKIP_REASON,
    sourceBoundary: BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SOURCE_BOUNDARY,
    invalidState: BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_INVALID_STATE,
    removalCondition: BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_REMOVAL_CONDITION,
    legacyContractNotExecuted: true,
    onboardExitCode: options.onboarding.exitCode,
    onboardSignal: options.onboarding.signal,
    onboardTimedOut: options.onboarding.timedOut,
    mockConverseCount: options.mock?.converseCount ?? 0,
    mockConverseStreamCount: options.mock?.streamCount ?? 0,
    redactedStdoutTail: evidenceTail(options.onboarding.redactedStdout),
    redactedStderrTail: evidenceTail(options.onboarding.redactedStderr),
  });
  await options.artifacts.writeJson("scenario-result.json", {
    id: "bedrock-runtime-compatible-anthropic",
    status: "skipped",
    reason: BEDROCK_PRE_CONTRACT_ENDPOINT_VALIDATION_SKIP_REASON,
    onboardExitCode: options.onboarding.exitCode,
  });
  options.skip(
    "NVIDIA endpoint validation was rate-limited/unavailable before the Bedrock Runtime contract could run",
  );
}

async function assertNoBedrockLeaks(options: {
  artifacts: ArtifactSink;
  home: string;
  mock: MockBedrockRuntime;
  onboarding: RawRunResult;
  sandbox: SandboxClient;
  redact: (text: string, extraValues?: string[]) => string;
}): Promise<void> {
  const adapterToken = readAdapterToken(options.home);
  const patterns: Array<[string, string]> = [
    ["fake user key", COMPATIBLE_KEY],
    ["adapter token", adapterToken],
    ["AWS bearer env name", "AWS_BEARER_TOKEN_BEDROCK"],
    ["adapter token env name", "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
    ["raw Bedrock hostname", BEDROCK_HOSTNAME],
  ];
  const snapshot = await runRawCommand(
    "openshell",
    ["sandbox", "exec", "-n", SANDBOX_NAME, "--", ...sandboxShellArgs(SNAPSHOT_SCRIPT)],
    {
      artifactName: "sandbox-snapshot-bedrock-runtime",
      artifacts: options.artifacts,
      env: testEnv(options.home),
      redactionValues: [COMPATIBLE_KEY, adapterToken],
      timeoutMs: 180_000,
    },
  );
  const adapterLog = fs.existsSync(adapterLogPath(options.home))
    ? fs.readFileSync(adapterLogPath(options.home), "utf8")
    : "";
  const hostLogs = [
    "@@NEMOCLAW_E2E_FILE@@ onboard stdout",
    options.onboarding.stdout,
    "@@NEMOCLAW_E2E_FILE@@ onboard stderr",
    options.onboarding.stderr,
    "@@NEMOCLAW_E2E_FILE@@ adapter log",
    adapterLog,
    "@@NEMOCLAW_E2E_FILE@@ fake Bedrock mock log",
    options.mock.logs.join("\n"),
  ].join("\n");
  await options.artifacts.writeText(
    "host-bedrock-runtime-logs.txt",
    options.redact(hostLogs, [COMPATIBLE_KEY, adapterToken]),
  );

  const leaks = [
    ...findForbiddenLeaks(snapshot.stdout, "sandbox snapshot", patterns),
    ...findForbiddenLeaks(hostLogs, "host logs", patterns),
  ];
  expect(leaks).toEqual([]);
}

RUN_BEDROCK_TEST(
  "bedrock runtime compatible Anthropic endpoint routes through managed inference.local",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    assertAgent(AGENT);
    validateSandboxName(SANDBOX_NAME);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-runtime-home-"));
    const hostsBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-hosts-"));
    const hostsBackup = path.join(hostsBackupDir, "hosts");
    let mock: MockBedrockRuntime | undefined;
    let onboarding: RawRunResult | undefined;

    cleanup.add(`remove Bedrock Runtime test home ${home}`, () =>
      fs.rmSync(home, { recursive: true, force: true }),
    );
    cleanup.add(`destroy Bedrock Runtime sandbox ${SANDBOX_NAME}`, () =>
      cleanupSandboxState(host, home),
    );
    cleanup.add("restore /etc/hosts after Bedrock Runtime mapping", () =>
      restoreHostsFile(host, hostsBackup, hostsBackupDir, home),
    );
    cleanup.add("stop Bedrock Runtime adapter", () => stopBedrockAdapterBestEffort(home));
    cleanup.add("stop fake Bedrock Runtime endpoint", async () => {
      if (mock) await mock.close();
    });
    cleanup.add("write fake Bedrock Runtime log", async () => {
      if (mock) {
        await artifacts.writeText(
          "fake-bedrock-runtime.log",
          secrets.redact(mock.logs.join("\n"), [COMPATIBLE_KEY]),
        );
      }
    });

    await artifacts.writeJson("scenario.json", {
      id: "bedrock-runtime-compatible-anthropic",
      runner: "vitest",
      legacySource: "test/e2e/test-bedrock-runtime-compatible-anthropic.sh",
      refs: ["#3767", "#5098"],
      agent: AGENT,
      sandboxName: SANDBOX_NAME,
      boundary: "host-bedrock-mock-source-cli-onboard-and-sandbox-exec",
      contracts: [
        "Docker, python3, source CLI, and OpenShell are available",
        "bedrock-runtime.us-east-1.amazonaws.com maps to the host fake endpoint",
        "non-interactive anthropicCompatible onboarding selects compatible-anthropic-endpoint",
        "OpenShell owns the hidden Bedrock adapter token while sandbox config uses inference.local",
        "OpenClaw and Hermes runtime paths return PONG through inference.local",
        "fake Bedrock Runtime endpoint observes authenticated Converse traffic",
        "adapter host log records safe request breadcrumbs",
        "sandbox configs, env, proc, and host logs contain no Bedrock token or hostname leaks",
      ],
      workflowRetirement: "legacy bash lane remains until #5098 Phase 11 shell retirement",
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-bedrock-runtime",
      env: testEnv(home),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for Bedrock Runtime compatible Anthropic E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for Bedrock Runtime compatible Anthropic E2E");
    }
    expectExitZero(
      await host.command("python3", ["--version"], {
        artifactName: "prereq-python-version-bedrock-runtime",
        env: testEnv(home),
        timeoutMs: 30_000,
      }),
      "python3 is available",
    );

    await prepareSourceCliAndOpenShell(host, home);
    await mapBedrockHostToLoopback(host, home, hostsBackup, skip);
    mock = await startFakeBedrockRuntimeMock({
      port: BEDROCK_MOCK_PORT,
      expectedBearer: COMPATIBLE_KEY,
      expectedModel: BEDROCK_MODEL,
    });

    await cleanupSandboxState(host, home);
    onboarding = await runRawCommand(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: `onboard-bedrock-runtime-${AGENT}`,
        artifacts,
        env: onboardEnv(home, AGENT),
        redactionValues: [COMPATIBLE_KEY],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    await skipPreContractEndpointValidationRateLimit({
      artifacts,
      mock,
      onboarding,
      skip,
    });
    expect(onboarding.exitCode, redactedResultText(onboarding)).toBe(0);

    await assertOnboardIdentity(home, AGENT);
    await assertAdapterHealth(host, home);
    await assertOpenShellProviderRoute(host, home);
    if (AGENT === "hermes") {
      await assertHermesConfig(sandbox, home);
    } else {
      await assertOpenClawConfig(sandbox, home);
    }

    await assertSandboxInference(sandbox, home);
    if (AGENT === "hermes") {
      await assertHermesApiChat(sandbox, home);
    } else {
      await assertOpenClawAgentTurn(sandbox, home);
    }

    expect(
      mock.converseCount,
      "fake Bedrock Runtime endpoint observed authenticated Converse traffic",
    ).toBeGreaterThanOrEqual(1);
    if (AGENT === "openclaw") {
      expect(
        mock.streamCount,
        "fake Bedrock Runtime endpoint observed authenticated ConverseStream traffic",
      ).toBeGreaterThanOrEqual(1);
    }
    assertAdapterLogBreadcrumbs(home, AGENT);
    await assertNoBedrockLeaks({
      artifacts,
      home,
      mock,
      onboarding,
      sandbox,
      redact: (text, extraValues) => secrets.redact(text, extraValues),
    });

    await artifacts.writeJson("scenario-result.json", {
      id: "bedrock-runtime-compatible-anthropic",
      agent: AGENT,
      assertions: {
        onboardCompleted: onboarding.exitCode === 0,
        providerIdentity: "compatible-anthropic-endpoint",
        adapterHealthy: true,
        converseRequests: mock.converseCount,
        converseStreamRequests: mock.streamCount,
        leakScanPassed: true,
      },
    });
  },
);
