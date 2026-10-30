// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fsSync from "node:fs";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";

export const NATIVE_PODMAN_STOP_FAULT_CANARY = "controlled-native-podman-stop-response-error";

interface StopFaultArm {
  readonly containerId: string;
  readonly correlationId: string;
}

interface StopFaultObservation extends StopFaultArm {
  readonly method: "POST";
  backendStatus: number | null;
  verifiedStopped: boolean;
  verificationFailed: boolean;
  clientDisconnected: boolean;
  faultInjected: boolean;
}

export interface NativePodmanStopFaultReceipt {
  readonly enabled: boolean;
  readonly armed: boolean;
  readonly closed: boolean;
  readonly faultCount: number;
  readonly observations: readonly Readonly<StopFaultObservation>[];
}

export interface NativePodmanStopResponseFault {
  readonly enabled: boolean;
  readonly socketPath: string | null;
  arm(input: StopFaultArm): void;
  disarm(): void;
  receipt(): NativePodmanStopFaultReceipt;
  close(): Promise<void>;
}

export interface NativePodmanStopResponseFaultOptions {
  readonly runtimeKind: "docker" | "podman";
  readonly backendSocketPath: string;
  readonly verifyStopped: (containerId: string) => Promise<boolean>;
}

export interface NativeGatewayLogCursor {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly offset: number;
}

export interface NativeGatewayLogWindow {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface NativeGatewayJournalCursor {
  readonly cursor: string;
  readonly invocationId: string;
}

type JournalCommand = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; maxBuffer: number; timeout: number },
) => {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status: number | null;
  stdout: string | null;
};

const NATIVE_GATEWAY_UNIT = "nemoclaw-openshell-gateway.service";
const JOURNAL_MAX_BYTES = 262_144;
const JOURNAL_TIMEOUT_MS = 10_000;

function runJournalCommand(
  command: string,
  args: string[],
  _options: Parameters<JournalCommand>[2],
): ReturnType<JournalCommand> {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: JOURNAL_MAX_BYTES,
    timeout: JOURNAL_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function journalOutput(run: JournalCommand, command: string, args: string[]): string {
  const result = run(command, args, {
    encoding: "utf8",
    maxBuffer: JOURNAL_MAX_BYTES,
    timeout: JOURNAL_TIMEOUT_MS,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    Buffer.byteLength(result.stdout) > JOURNAL_MAX_BYTES
  ) {
    throw new Error("Owned native gateway journal evidence is unavailable or exceeds its bound.");
  }
  return result.stdout;
}

function nativeGatewayInvocationId(run: JournalCommand): string {
  const id = journalOutput(run, "/usr/bin/systemctl", [
    "--user",
    "show",
    NATIVE_GATEWAY_UNIT,
    "--property=InvocationID",
    "--value",
  ]).trim();
  if (!/^[a-f0-9]{32}$/u.test(id)) {
    throw new Error("Owned native gateway service invocation is unavailable.");
  }
  return id;
}

/** Pin the managed user service's journal position and invocation before the fault is armed. */
export function captureNativeGatewayJournalCursor(
  run: JournalCommand = runJournalCommand,
): NativeGatewayJournalCursor {
  const invocationId = nativeGatewayInvocationId(run);
  const output = journalOutput(run, "/usr/bin/journalctl", [
    "--user",
    `--unit=${NATIVE_GATEWAY_UNIT}`,
    "--no-pager",
    "--output=cat",
    "--lines=1",
    "--show-cursor",
  ]);
  const cursors = [...output.matchAll(/^-- cursor: ([A-Za-z0-9=;:_-]{1,512})$/gmu)];
  if (cursors.length !== 1 || nativeGatewayInvocationId(run) !== invocationId) {
    throw new Error("Owned native gateway journal cursor is unavailable or changed.");
  }
  return { cursor: cursors[0]![1]!, invocationId };
}

/** Read only entries appended to the same managed service invocation, with a hard output bound. */
export function readNativeGatewayJournalWindow(
  cursor: NativeGatewayJournalCursor,
  run: JournalCommand = runJournalCommand,
): NativeGatewayLogWindow {
  if (
    !/^[A-Za-z0-9=;:_-]{1,512}$/u.test(cursor.cursor) ||
    !/^[a-f0-9]{32}$/u.test(cursor.invocationId) ||
    nativeGatewayInvocationId(run) !== cursor.invocationId
  ) {
    throw new Error("Owned native gateway journal identity changed.");
  }
  const text = journalOutput(run, "/usr/bin/journalctl", [
    "--user",
    `--unit=${NATIVE_GATEWAY_UNIT}`,
    `--after-cursor=${cursor.cursor}`,
    "--no-pager",
    "--output=cat",
  ]);
  if (nativeGatewayInvocationId(run) !== cursor.invocationId) {
    throw new Error("Owned native gateway journal identity changed.");
  }
  return { text, startOffset: 0, endOffset: Buffer.byteLength(text) };
}

export interface NativePodmanStoppedInternalTrace {
  readonly requestId: string;
  readonly grpcStatus: 13;
  readonly containerId: string;
  readonly sandboxId: string;
  readonly driverLine: number;
  readonly stoppedLine: number;
  readonly responseLine: number;
  readonly stoppedBeforeResponse: boolean;
  readonly matchedRecords: Readonly<{ driver: string; stopped: string; response: string }>;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function gatewayLogOpenFlags(): number {
  if (typeof fsSync.constants.O_NOFOLLOW !== "number") {
    throw new Error("Native gateway log inspection requires O_NOFOLLOW.");
  }
  return fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK;
}

function assertOwnedGatewayLog(stat: fsSync.BigIntStats): void {
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    uid === undefined ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o077n) !== 0n ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Native gateway evidence requires one private owned regular log file.");
  }
}

/** Record the owned log identity and end position before the selected stop request. */
export function captureNativeGatewayLogCursor(logPath: string): NativeGatewayLogCursor {
  const descriptor = fsSync.openSync(logPath, gatewayLogOpenFlags());
  try {
    const stat = fsSync.fstatSync(descriptor, { bigint: true });
    assertOwnedGatewayLog(stat);
    return {
      path: logPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      offset: Number(stat.size),
    };
  } finally {
    fsSync.closeSync(descriptor);
  }
}

/** Read new bytes from the same owned log, rejecting replacement, truncation, and overflow. */
export async function readNativeGatewayLogWindow(
  cursor: NativeGatewayLogCursor,
  maximumBytes = 262_144,
): Promise<NativeGatewayLogWindow> {
  if (
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new Error("Native gateway log offsets and capture limits must be valid byte counts.");
  }
  const file = await fs.open(cursor.path, gatewayLogOpenFlags());
  try {
    const stat = await file.stat({ bigint: true });
    assertOwnedGatewayLog(stat);
    if (String(stat.dev) !== cursor.dev || String(stat.ino) !== cursor.ino) {
      throw new Error("Native gateway log identity changed after the cursor was recorded.");
    }
    const endOffset = Number(stat.size);
    if (endOffset < cursor.offset)
      throw new Error("Native gateway log was truncated after the cursor.");
    const length = endOffset - cursor.offset;
    if (length > maximumBytes)
      throw new Error("Native gateway log exceeds the bounded capture window.");
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, cursor.offset + read);
      if (result.bytesRead === 0)
        throw new Error("Native gateway log changed while reading evidence.");
      read += result.bytesRead;
    }
    if ((await file.stat({ bigint: true })).size < stat.size) {
      throw new Error("Native gateway log was truncated while reading evidence.");
    }
    return { text: bytes.toString("utf8"), startOffset: cursor.offset, endOffset };
  } finally {
    await file.close();
  }
}

function traceField(line: string, name: string): string | undefined {
  const key = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|[\\s{])${key}=(?:"([^"]*)"|([^\\s}]+))(?=[\\s}]|$)`, "u").exec(
    line,
  );
  return match?.[1] ?? match?.[2];
}

/** Bind a real StopSandbox error response to the owned native container and its stopped transition. */
export function parseNativePodmanStoppedInternalTrace(
  text: string,
  expected: Readonly<{ containerId: string; sandboxId: string }>,
): NativePodmanStoppedInternalTrace {
  if (!/^[a-f0-9]{64}$/u.test(expected.containerId) || !UUID.test(expected.sandboxId)) {
    throw new Error("Native stop trace requires immutable container and sandbox identities.");
  }
  const lines = text.replace(/\u001b\[[0-9;]*m/gu, "").split(/\r?\n/u);
  const drivers = lines.flatMap((line, index) =>
    line.includes("Stopping sandbox container") &&
    traceField(line, "rpc.method") === "StopSandbox" &&
    traceField(line, "driver.name") === "podman" &&
    traceField(line, "sandbox.id") === expected.sandboxId &&
    traceField(line, "container") === expected.containerId &&
    UUID.test(traceField(line, "request_id") ?? "")
      ? [{ line, index, requestId: traceField(line, "request_id") as string }]
      : [],
  );
  if (drivers.length !== 1) {
    throw new Error("Native stop trace requires exactly one owned StopSandbox driver record.");
  }
  const driver = drivers[0] as (typeof drivers)[number];
  const responses = lines.flatMap((line, index) =>
    index > driver.index &&
    line.includes("openshell_server::multiplex: response") &&
    traceField(line, "rpc.method") === "StopSandbox" &&
    traceField(line, "request_id") === driver.requestId &&
    traceField(line, "rpc.grpc.status_code") === "13" &&
    traceField(line, "status") === "200"
      ? [{ line, index }]
      : [],
  );
  if (responses.length !== 1) {
    throw new Error("Native stop trace requires the same-request gRPC status 13 response.");
  }
  const response = responses[0] as (typeof responses)[number];
  const stopped = lines.flatMap((line, index) =>
    index > driver.index &&
    line.includes("Sandbox phase changed") &&
    traceField(line, "sandbox_id") === expected.sandboxId &&
    traceField(line, "new_phase") === "Stopped"
      ? [{ line, index }]
      : [],
  )[0];
  if (!stopped) throw new Error("Native stop trace requires the owned Stopped transition.");
  return {
    requestId: driver.requestId,
    grpcStatus: 13,
    ...expected,
    driverLine: driver.index + 1,
    stoppedLine: stopped.index + 1,
    responseLine: response.index + 1,
    stoppedBeforeResponse: stopped.index < response.index,
    matchedRecords: { driver: driver.line, stopped: stopped.line, response: response.line },
  };
}

function disabledFault(): NativePodmanStopResponseFault {
  let closed = false;
  return {
    enabled: false,
    socketPath: null,
    arm: () => {
      throw new Error("The native Podman stop fault is not available for Docker.");
    },
    disarm: () => undefined,
    receipt: () => ({ enabled: false, armed: false, closed, faultCount: 0, observations: [] }),
    close: async () => {
      closed = true;
    },
  };
}

function matchingContainer(request: IncomingMessage): string | undefined {
  if (request.method !== "POST") return undefined;
  // The pinned OpenShell 0.0.116 Podman client uses the v5.0.0 libpod API.
  return /^(?:http:\/\/localhost)?\/v5\.0\.0\/libpod\/containers\/([a-f0-9]{64})\/stop(?:\?[^#]*)?$/u.exec(
    request.url ?? "",
  )?.[1];
}

/** Forward the real native API, then replace one owned stop response after confirmed completion. */
export async function createNativePodmanStopResponseFault(
  options: NativePodmanStopResponseFaultOptions,
): Promise<NativePodmanStopResponseFault> {
  if (options.runtimeKind === "docker") return disabledFault();
  const backend = options.backendSocketPath;
  if (
    !path.isAbsolute(backend) ||
    path.normalize(backend) !== backend ||
    /[\0\r\n]/u.test(backend)
  ) {
    throw new Error("The Podman backend must use one normalized absolute socket path.");
  }
  const backendIdentity = await fs.lstat(backend);
  if (
    !backendIdentity.isSocket() ||
    typeof process.getuid !== "function" ||
    backendIdentity.uid !== process.getuid()
  ) {
    throw new Error("The Podman backend must be a socket owned by the current user.");
  }

  // Keep the proxy inside the backend's protected directory chain.
  const directory = await fs.mkdtemp(path.join(path.dirname(backend), "nc-stop-fault-"));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, "podman.sock");
  const connections = new Set<Duplex>();
  const observations: StopFaultObservation[] = [];
  let armed: StopFaultArm | undefined;
  let previouslyArmed = false;
  let disarmed = false;
  let closed = false;
  let faultCount = 0;
  let closePromise: Promise<void> | undefined;

  const track = (connection: Duplex): void => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  };
  const fail = (response: ServerResponse): void => {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) response.destroy();
    else response.writeHead(502).end();
  };
  const forwardHeaders = (upstream: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(Number(upstream.statusCode ?? 502), upstream.headers);
  };
  const completeStop = async (
    upstream: IncomingMessage,
    response: ServerResponse,
    observation: StopFaultObservation,
  ): Promise<void> => {
    // A 204 has no response body. Consume it before changing the response.
    for await (const chunk of upstream) void chunk;
    try {
      observation.verifiedStopped = await options.verifyStopped(observation.containerId);
    } catch {
      observation.verificationFailed = true;
    }
    if (response.destroyed || response.writableEnded) return;
    if (!closed && !disarmed && observation.verifiedStopped) {
      const body = JSON.stringify({ message: NATIVE_PODMAN_STOP_FAULT_CANARY });
      // This records the proxy write. The gateway trace supplies the native RPC result.
      response.once("finish", () => {
        observation.faultInjected = true;
        faultCount += 1;
      });
      response.writeHead(500, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    } else {
      forwardHeaders(upstream, response);
      response.end();
    }
  };

  const server = http.createServer((request, response) => {
    const containerId = matchingContainer(request);
    const selected = armed && containerId === armed.containerId ? armed : undefined;
    // Claim before any asynchronous work so concurrent requests cannot inject twice.
    if (selected) armed = undefined;
    const observation: StopFaultObservation | undefined = selected
      ? {
          ...selected,
          method: "POST",
          backendStatus: null,
          verifiedStopped: false,
          verificationFailed: false,
          clientDisconnected: false,
          faultInjected: false,
        }
      : undefined;
    if (observation) observations.push(observation);
    const upstream = http.request({
      socketPath: backend,
      method: request.method,
      path: request.url,
      headers: request.headers,
      agent: false,
    });
    upstream.on("socket", track);
    upstream.on("error", () => fail(response));
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (observation && !response.writableFinished) observation.clientDisconnected = true;
      upstream.destroy();
    });
    upstream.on("response", (incoming) => {
      if (observation) observation.backendStatus = incoming.statusCode ?? null;
      if (observation && incoming.statusCode === 204) {
        void completeStop(incoming, response, observation).catch(() => fail(response));
      } else {
        forwardHeaders(incoming, response);
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      }
    });
    request.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (request, client, head) => {
    const upstream = net.createConnection({ path: backend });
    track(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      const headers = request.rawHeaders;
      const lines = [
        `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`,
      ];
      for (let index = 0; index < headers.length; index += 2) {
        lines.push(`${headers[index]}: ${headers[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    enabled: true,
    socketPath,
    arm(input) {
      if (closed || previouslyArmed)
        throw new Error("The native stop fault can be armed only once.");
      if (
        !/^[a-f0-9]{64}$/u.test(input.containerId) ||
        !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(input.correlationId)
      ) {
        throw new Error(
          "The native stop fault requires a full container ID and safe correlation ID.",
        );
      }
      previouslyArmed = true;
      disarmed = false;
      armed = Object.freeze({ ...input });
    },
    disarm() {
      armed = undefined;
      disarmed = true;
    },
    receipt: () => ({
      enabled: true,
      armed: Boolean(armed),
      closed,
      faultCount,
      observations: observations.map((entry) => Object.freeze({ ...entry })),
    }),
    close() {
      if (closePromise) return closePromise;
      closed = true;
      armed = undefined;
      closePromise = (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        for (const connection of connections) connection.destroy();
        try {
          await stopped;
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      })();
      return closePromise;
    },
  };
}
