// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Duplex, Readable, Writable } from "node:stream";
import type { ContainerEngine } from "../../adapters/container-engine";
import {
  createDockerOperationAuthority,
  type DockerOperationAuthority,
} from "./docker-operation-authority";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const SHA256 = /^[a-f0-9]{64}$/u;
const API_KEY_FILE_DESCRIPTOR = 3;
const STARTUP_STATUS_DESCRIPTOR = 4;
const AUTH_MODE = "api-key-fd3";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_HEADER_BYTES = Math.min(http.maxHeaderSize, 32 * 1024);
const MAX_OUTPUT_TOKENS = 4096;
// The recipe configures llama-server's socket read/write timeout. This fixed
// ceiling bounds total request duration and cannot be raised by a recipe.
const REQUEST_TIMEOUT_MS = 900_000;
const REJECTION_CLOSE_GRACE_MS = 500;
const REMOTE_CLEANUP_MS = 20_000;
const REQUEST_OWNER_LABEL = "io.nvidia.nemoclaw.host-local-inference.request-transaction-sha256";
const REQUEST_MODEL_LABEL = "io.nvidia.nemoclaw.host-local-inference.request-model-id";
const MODEL_OWNER_LABEL = "io.nvidia.nemoclaw.host-local-inference.transaction-sha256";
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const TOKEN_LIMIT_FIELDS = new Set(["max_tokens", "max_completion_tokens", "n_predict"]);
const READ_ONLY_ROUTES = new Set(["/health", "/v1/models", "/props", "/metrics"]);
const UNAUTHORIZED_BODY = `${JSON.stringify({
  error: {
    code: "unauthorized",
    message: "Authentication is required.",
    type: "authentication_error",
  },
})}\n`;

export interface LlamaCppPrivateBridgeArguments {
  readonly transactionId: string;
  readonly targetHost: string;
  readonly containerId?: string;
  readonly dockerAuthorityId?: string;
  readonly targetPort: number;
  readonly listenPort: number;
  readonly bindAddresses: readonly ["127.0.0.1"] | readonly ["127.0.0.1", string];
}

function exactPort(value: string, label: string): number {
  const port = /^[0-9]{1,5}$/u.test(value) ? Number(value) : -1;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} is invalid`);
  }
  return port;
}

function isPrivateIpv4(value: string): boolean {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

export function parseLlamaCppPrivateBridgeArguments(
  argv: readonly string[],
): LlamaCppPrivateBridgeArguments {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("private bridge arguments must be exact key/value pairs");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const one = (key: string): string => {
    const candidates = values.get(key);
    if (!candidates || candidates.length !== 1) throw new Error(`${key} must be provided once`);
    return candidates[0]!;
  };
  const transactionId = one("--transaction");
  const targetHost = one("--target-host");
  const bindAddresses = values.get("--bind-address") ?? [];
  const supported = new Set([
    "--transaction",
    "--auth-mode",
    "--target-host",
    "--target-port",
    "--listen-port",
    "--bind-address",
    "--container-id",
    "--docker-authority",
  ]);
  if ([...values.keys()].some((key) => !supported.has(key))) {
    throw new Error("private bridge received an unsupported argument");
  }
  if (
    !SHA256.test(transactionId) ||
    one("--auth-mode") !== AUTH_MODE ||
    bindAddresses[0] !== "127.0.0.1" ||
    !(targetHost === "127.0.0.1"
      ? (bindAddresses.length === 1 ||
          (bindAddresses.length === 2 && isPrivateIpv4(bindAddresses[1]!))) &&
        SHA256.test(one("--container-id")) &&
        /^docker:[a-f0-9]{64}$/u.test(one("--docker-authority"))
      : isPrivateIpv4(targetHost) &&
        bindAddresses.length === 2 &&
        isPrivateIpv4(bindAddresses[1]!) &&
        bindAddresses[1] !== targetHost) ||
    values.has("--container-id") !== values.has("--docker-authority") ||
    (values.has("--container-id") &&
      (!SHA256.test(one("--container-id")) ||
        !/^docker:[a-f0-9]{64}$/u.test(one("--docker-authority"))))
  ) {
    throw new Error("private bridge authority is invalid");
  }
  return Object.freeze({
    transactionId,
    targetHost,
    ...(values.has("--container-id")
      ? { containerId: one("--container-id"), dockerAuthorityId: one("--docker-authority") }
      : {}),
    targetPort: exactPort(one("--target-port"), "target port"),
    listenPort: exactPort(one("--listen-port"), "listen port"),
    bindAddresses: Object.freeze([
      ...bindAddresses,
    ]) as LlamaCppPrivateBridgeArguments["bindAddresses"],
  });
}

function readPrivateBridgeApiKey(): string {
  let value: string;
  try {
    value = fs.readFileSync(API_KEY_FILE_DESCRIPTOR, "utf8").trim();
  } catch {
    throw new Error("private bridge credential is unavailable");
  } finally {
    try {
      fs.closeSync(API_KEY_FILE_DESCRIPTOR);
    } catch {
      // The inherited descriptor can already be closed after a failed read.
    }
  }
  if (!SHA256.test(value)) {
    throw new Error("private bridge credential is invalid");
  }
  return value;
}

function authorizationValues(request: http.IncomingMessage): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function hasValidBearerCredential(request: http.IncomingMessage, apiKey: string): boolean {
  const values = authorizationValues(request);
  if (values.length !== 1) return false;
  const value = values[0]!;
  if (value.length !== 7 + apiKey.length || value.slice(0, 7).toLowerCase() !== "bearer ") {
    return false;
  }
  const supplied = Buffer.from(value.slice(7), "utf8");
  const expected = Buffer.from(apiKey, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isUnauthenticatedHealthProbe(request: http.IncomingMessage): boolean {
  return request.method === "GET" && request.url === "/health";
}

function writeUnauthorized(response: http.ServerResponse): void {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(UNAUTHORIZED_BODY),
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(UNAUTHORIZED_BODY);
}

function writeUpstreamUnavailable(
  response: http.ServerResponse,
  options: { closeConnection?: boolean } = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${JSON.stringify({
    error: {
      code: "upstream_unavailable",
      message: "The managed inference server is unavailable.",
      type: "server_error",
    },
  })}\n`;
  response.writeHead(502, {
    "Cache-Control": "no-store",
    ...(options.closeConnection ? { Connection: "close" } : {}),
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

class PrivateBridgeRequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function invalidChatBody(): PrivateBridgeRequestFailure {
  return new PrivateBridgeRequestFailure(
    400,
    "invalid_json",
    "Chat Completions request must be one JSON object.",
  );
}

function boundedChatBody(body: Buffer): Buffer {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    // Bound nesting before JSON.parse allocates the object tree.
    let nesting = 0;
    let inString = false;
    let escape = false;
    for (const character of text) {
      if (inString) {
        if (escape) escape = false;
        else if (character === "\\") escape = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{" || character === "[") {
        if (++nesting > 10_000) throw invalidChatBody();
      } else if (character === "}" || character === "]") nesting -= 1;
    }
    value = JSON.parse(text);
  } catch {
    throw invalidChatBody();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidChatBody();

  // JSON.parse validates the document. Scan its top-level field boundaries to
  // retain duplicate-key rejection and the original integer-token semantics.
  const keys = new Set<string>();
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  let expectingKey = true;
  let key = "";
  let valueStart = -1;
  let rootEnd = -1;
  let boundedFieldPresent = false;
  const checkTokenLimit = (end: number) => {
    if (valueStart < 0 || !TOKEN_LIMIT_FIELDS.has(key)) return;
    boundedFieldPresent = true;
    const raw = text.slice(valueStart, end).trim();
    if (
      !/^[1-9][0-9]*$/u.test(raw) ||
      raw.length > 19 ||
      (raw.length === 19 && raw > "9223372036854775807")
    ) {
      throw new PrivateBridgeRequestFailure(
        400,
        "output_token_limit_invalid",
        "Output token limit must be a positive integer.",
      );
    }
    if (raw.length > 4 || Number(raw) > MAX_OUTPUT_TOKENS) {
      throw new PrivateBridgeRequestFailure(
        400,
        "output_token_limit_exceeded",
        "Output token limit exceeds the declared limit.",
      );
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (stringStart >= 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        if (depth === 1 && expectingKey) {
          key = JSON.parse(text.slice(stringStart, index + 1)) as string;
          if (keys.has(key)) {
            throw new PrivateBridgeRequestFailure(
              400,
              "duplicate_json_field",
              "Chat Completions request contains a duplicate field.",
            );
          }
          keys.add(key);
          expectingKey = false;
        }
        stringStart = -1;
      }
      continue;
    }
    if (character === '"') stringStart = index;
    else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      if (depth === 1) {
        checkTokenLimit(index);
        rootEnd = index;
      }
      depth -= 1;
    } else if (character === ":" && depth === 1) valueStart = index + 1;
    else if (character === "," && depth === 1) {
      checkTokenLimit(index);
      valueStart = -1;
      expectingKey = true;
    }
  }
  if (rootEnd < 0) throw invalidChatBody();
  if (boundedFieldPresent) return body;
  return Buffer.from(
    `${text.slice(0, rootEnd)}${keys.size > 0 ? "," : ""}"max_tokens":${MAX_OUTPUT_TOKENS}${text.slice(rootEnd)}`,
  );
}

function readBoundedRequestBody(
  request: http.IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (failure?: PrivateBridgeRequestFailure) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onError);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve(Buffer.concat(chunks, size));
      chunks.length = 0;
    };
    const onError = () =>
      finish(
        new PrivateBridgeRequestFailure(
          400,
          "request_body_unreadable",
          "Request body could not be read.",
        ),
      );
    const onAbort = () => {
      request.pause();
      onError();
    };
    const onEnd = () => finish();
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        request.pause();
        finish(
          new PrivateBridgeRequestFailure(
            413,
            "request_body_too_large",
            "Request body exceeds the declared limit.",
          ),
        );
      } else chunks.push(chunk);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onError);
    // Retain this listener through later stream errors after an early rejection.
    request.on("error", onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function endToEndHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...source };
  const connectionHeaders = String(source.connection ?? "")
    .toLowerCase()
    .split(",");
  for (const name of [
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    ...connectionHeaders.map((value) => value.trim()),
  ])
    delete headers[name];
  return headers;
}

function writeRequestFailure(
  response: http.ServerResponse,
  failure: PrivateBridgeRequestFailure,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${JSON.stringify({ error: { code: failure.code, message: failure.message, type: "invalid_request_error" } })}\n`;
  response.writeHead(failure.status, {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  // Content-Length lets the client consume the complete error immediately.
  // Defer the close briefly so queued upload bytes do not turn the error into
  // a TCP reset before the client reads it. The unread body stays paused.
  response.once("error", () => response.destroy());
  response.write(body);
  const finish = setTimeout(() => response.end(), REJECTION_CLOSE_GRACE_MS);
  finish.unref();
  response.once("close", () => clearTimeout(finish));
}

interface NativeContainerInspection {
  Id: string;
  Image: string;
  State: { Running: boolean; Pid: number; Status: string; ExitCode: number };
  Config: {
    Labels: Record<string, string>;
    Entrypoint: string[];
    Cmd: string[];
    User: string;
    Env: string[];
    OpenStdin: boolean;
    Tty: boolean;
  };
  Mounts: unknown[];
  HostConfig: {
    NetworkMode: string;
    PortBindings: Record<string, unknown> | null;
    PublishAllPorts: boolean;
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapAdd: string[] | null;
    CapDrop: string[];
    SecurityOpt: string[];
    Devices: unknown[];
    DeviceRequests: unknown[] | null;
    Memory: number;
    MemorySwap: number;
    PidsLimit: number;
    LogConfig: { Type: string };
    RestartPolicy: { Name: string };
  };
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
}

function remoteFailure(): Error {
  return new Error("Private bridge could not prove that its remote request stopped.");
}

function dockerCapture(
  engine: ContainerEngine,
  args: readonly string[],
  deadline: number,
  input?: Buffer,
): string {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw remoteFailure();
  const result = engine.capture(args, Math.max(1, Math.floor(Math.min(5_000, remaining))), input);
  if (result.error || result.status !== 0 || Date.now() >= deadline) throw remoteFailure();
  return result.stdout;
}

function inspectNativeContainer(
  engine: ContainerEngine,
  id: string,
  deadline: number,
): NativeContainerInspection {
  if (!SHA256.test(id)) throw remoteFailure();
  const values = JSON.parse(
    dockerCapture(engine, ["container", "inspect", id], deadline),
  ) as NativeContainerInspection[];
  if (!Array.isArray(values) || values.length !== 1 || values[0]?.Id !== id) throw remoteFailure();
  const state = values[0].State;
  if (
    !state ||
    typeof state.Running !== "boolean" ||
    !Number.isSafeInteger(state.Pid) ||
    state.Pid < 0 ||
    typeof state.Status !== "string" ||
    !Number.isSafeInteger(state.ExitCode)
  )
    throw remoteFailure();
  return values[0];
}

function empty(value: readonly unknown[] | Record<string, unknown> | null): boolean {
  return value === null || (typeof value === "object" && Object.keys(value).length === 0);
}

function requireNativeModel(
  engine: ContainerEngine,
  id: string,
  transactionId: string,
  deadline: number,
): NativeContainerInspection {
  const model = inspectNativeContainer(engine, id, deadline);
  if (
    model.Config.Labels?.[MODEL_OWNER_LABEL] !== transactionId ||
    !/^sha256:[a-f0-9]{64}$/u.test(model.Image)
  )
    throw remoteFailure();
  if (model.State.Running) {
    const networks = Object.values(model.NetworkSettings.Networks);
    if (
      networks.length !== 1 ||
      !SHA256.test(networks[0]!.NetworkID) ||
      !empty(model.HostConfig.PortBindings) ||
      model.HostConfig.PublishAllPorts
    )
      throw remoteFailure();
    const network = JSON.parse(
      dockerCapture(engine, ["network", "inspect", networks[0]!.NetworkID], deadline),
    ) as { Id: string; Internal: boolean }[];
    if (
      network.length !== 1 ||
      network[0]?.Id !== networks[0]!.NetworkID ||
      network[0]?.Internal !== true
    )
      throw remoteFailure();
  } else if (model.State.Pid !== 0) throw remoteFailure();
  return model;
}

function requireOwnedNativeClient(
  engine: ContainerEngine,
  id: string,
  transactionId: string,
  deadline: number,
): NativeContainerInspection {
  const client = inspectNativeContainer(engine, id, deadline);
  const modelId = client.Config.Labels?.[REQUEST_MODEL_LABEL];
  const host = client.HostConfig;
  if (
    client.Config.Labels?.[REQUEST_OWNER_LABEL] !== transactionId ||
    !SHA256.test(modelId ?? "") ||
    host.NetworkMode !== `container:${modelId}` ||
    !empty(client.Mounts) ||
    !empty(host.PortBindings) ||
    host.PublishAllPorts ||
    !host.ReadonlyRootfs ||
    host.Privileged ||
    !empty(host.CapAdd) ||
    !empty(host.Devices) ||
    !empty(host.DeviceRequests) ||
    host.CapDrop?.join() !== "ALL" ||
    host.SecurityOpt?.join() !== "no-new-privileges" ||
    host.Memory !== 64 * 1024 * 1024 ||
    host.MemorySwap !== host.Memory ||
    host.PidsLimit !== 32 ||
    host.LogConfig?.Type !== "none" ||
    host.RestartPolicy?.Name !== "no" ||
    client.Config.User !== "65532:65532" ||
    !client.Config.OpenStdin ||
    client.Config.Tty ||
    !client.Config.Env?.includes("NVIDIA_VISIBLE_DEVICES=void") ||
    client.Config.Entrypoint?.join() !== "/usr/bin/curl" ||
    client.Config.Cmd?.join("\0") !== "-q\0--config\0-"
  )
    throw remoteFailure();
  return client;
}

function curlInput(
  port: number,
  method: string,
  route: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
  seconds: number,
  wireResponse: boolean,
): Buffer {
  const quote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;
  const lines = [
    `max-time = ${seconds}`,
    'connect-timeout = "5"',
    "silent",
    "no-buffer",
    "http1.1",
    'proxy = ""',
    'noproxy = "*"',
    'proto = "=http"',
    `url = "http://127.0.0.1:${port}${route}"`,
    `request = ${quote(method)}`,
    'header = "Connection: close"',
    'header = "Expect:"',
    ...(wireResponse ? ["include", "raw"] : ["fail"]),
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "content-length" || name === "host") continue;
    for (const item of Array.isArray(value) ? value : [value])
      lines.push(`header = ${quote(`${name}: ${item}`)}`);
  }
  // curl reads the remaining stdin as binary data while parsing this final option.
  // Neither the credential nor the body enters Docker argv, configuration, or logs.
  lines.push('data-binary = "@-"');
  return Buffer.concat([Buffer.from(`${lines.join("\n")}\n`), body]);
}

function removeStoppedNativeClient(engine: ContainerEngine, id: string, deadline: number): void {
  const stopped = inspectNativeContainer(engine, id, deadline).State;
  if (stopped.Running || stopped.Pid !== 0) throw remoteFailure();
  dockerCapture(engine, ["rm", id], deadline);
  if (
    dockerCapture(
      engine,
      ["ps", "--all", "--no-trunc", "--quiet", "--filter", `id=${id}`],
      deadline,
    ).trim() !== ""
  )
    throw remoteFailure();
}

function finishNativeClient(
  engine: ContainerEngine,
  id: string,
  transactionId: string,
  apiKey: string | (() => string),
  port: number,
  deadline: number,
  generationRequested = true,
): void {
  let client = requireOwnedNativeClient(engine, id, transactionId, deadline);
  const neverStarted = client.State.Status === "created";
  if (client.State.Running) dockerCapture(engine, ["kill", "--signal", "KILL", id], deadline);
  client = requireOwnedNativeClient(engine, id, transactionId, deadline);
  if (client.State.Running || client.State.Pid !== 0) throw remoteFailure();
  if (neverStarted || !generationRequested) {
    removeStoppedNativeClient(engine, id, deadline);
    return;
  }
  const modelId = client.Config.Labels[REQUEST_MODEL_LABEL]!;
  let model: NativeContainerInspection;
  try {
    model = requireNativeModel(engine, modelId, transactionId, deadline);
  } catch (error) {
    if (
      dockerCapture(
        engine,
        ["ps", "--all", "--no-trunc", "--quiet", "--filter", `id=${modelId}`],
        deadline,
      ).trim() !== ""
    )
      throw error;
    removeStoppedNativeClient(engine, id, deadline);
    return;
  }
  if (model.Image !== client.Image) throw remoteFailure();
  if (model.State.Running) {
    const key = typeof apiKey === "string" ? apiKey : apiKey();
    if (!SHA256.test(key)) throw remoteFailure();
    let previous: number | undefined;
    for (;;) {
      const input = curlInput(
        port,
        "GET",
        "/metrics",
        { authorization: `Bearer ${key}` },
        Buffer.alloc(0),
        Math.min(4, (deadline - Date.now()) / 1_000),
        false,
      );
      const source = dockerCapture(
        engine,
        ["start", "--attach", "--interactive", id],
        deadline,
        input,
      );
      const state = inspectNativeContainer(engine, id, deadline).State;
      if (state.Running || state.Pid !== 0 || state.ExitCode !== 0) throw remoteFailure();
      const samples = new Map<string, number>();
      for (const line of source.split("\n")) {
        const match =
          /^(llamacpp:(?:requests_processing|requests_deferred|n_decode_total))\s+([0-9.eE+-]+)$/u.exec(
            line,
          );
        if (match) samples.set(match[1]!, Number(match[2]));
      }
      const decoded = samples.get("llamacpp:n_decode_total");
      if (
        samples.get("llamacpp:requests_processing") === 0 &&
        samples.get("llamacpp:requests_deferred") === 0 &&
        Number.isFinite(decoded)
      ) {
        if (previous === decoded) break;
        previous = decoded;
      } else previous = undefined;
      if (Date.now() >= deadline) throw remoteFailure();
      Atomics.wait(SLEEP_ARRAY, 0, 0, 50);
    }
  }
  removeStoppedNativeClient(engine, id, deadline);
}

/** Reconcile the existing bridge's request containers after shutdown or a crashed owner. */
export function cleanupLlamaCppPrivateBridgeRequests(
  engine: ContainerEngine,
  transactionId: string,
  apiKey: string | (() => string),
  port: number,
  deadline = Date.now() + REMOTE_CLEANUP_MS,
): void {
  if (
    engine.engineId !== "docker" ||
    engine.operation !== "host-local-inference" ||
    !SHA256.test(transactionId) ||
    (typeof apiKey === "string" && !SHA256.test(apiKey))
  )
    throw remoteFailure();
  exactPort(String(port), "target port");
  const source = dockerCapture(
    engine,
    [
      "ps",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=${REQUEST_OWNER_LABEL}=${transactionId}`,
    ],
    deadline,
  ).trim();
  for (const id of source ? source.split("\n") : [])
    finishNativeClient(engine, id, transactionId, apiKey, port, deadline);
}

function createNativeClient(
  docker: DockerOperationAuthority,
  authority: LlamaCppPrivateBridgeArguments,
  deadline: number,
): string {
  const model = requireNativeModel(
    docker.engine,
    authority.containerId!,
    authority.transactionId,
    deadline,
  );
  if (!model.State.Running) throw remoteFailure();
  const id = dockerCapture(
    docker.engine,
    [
      "create",
      "--interactive",
      "--name",
      `nemoclaw-llama-request-${randomBytes(16).toString("hex")}`,
      "--label",
      `${REQUEST_OWNER_LABEL}=${authority.transactionId}`,
      "--label",
      `${REQUEST_MODEL_LABEL}=${model.Id}`,
      "--network",
      `container:${model.Id}`,
      "--read-only",
      "--user",
      "65532:65532",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "32",
      "--memory",
      "64m",
      "--memory-swap",
      "64m",
      "--log-driver",
      "none",
      "--restart",
      "no",
      "--no-healthcheck",
      "--env",
      "NVIDIA_VISIBLE_DEVICES=void",
      "--entrypoint",
      "/usr/bin/curl",
      model.Image,
      "-q",
      "--config",
      "-",
    ],
    deadline,
  ).trim();
  if (
    requireOwnedNativeClient(docker.engine, id, authority.transactionId, deadline).Image !==
    model.Image
  )
    throw remoteFailure();
  return id;
}

function createLlamaCppPrivateBridgeRequestHandler(
  authority: Pick<
    LlamaCppPrivateBridgeArguments,
    "targetHost" | "targetPort" | "containerId" | "dockerAuthorityId"
  > & { readonly transactionId?: string },
  apiKey: string,
  onFailure?: (error: Error) => void,
) {
  if (
    !SHA256.test(apiKey) ||
    (!isPrivateIpv4(authority.targetHost) && authority.targetHost !== "127.0.0.1")
  ) {
    throw new Error("private bridge HTTP authority is invalid");
  }
  const targetPort = exactPort(String(authority.targetPort), "target port");
  const canonicalAuthorization = `Bearer ${apiKey}`;
  const docker =
    authority.containerId === undefined
      ? undefined
      : createDockerOperationAuthority("host-local-inference");
  if (
    docker &&
    (!SHA256.test(authority.containerId!) ||
      !SHA256.test(authority.transactionId ?? "") ||
      docker.engine.authorityId !== authority.dockerAuthorityId)
  )
    throw remoteFailure();
  if (docker)
    cleanupLlamaCppPrivateBridgeRequests(
      docker.engine,
      authority.transactionId!,
      apiKey,
      targetPort,
    );
  let occupied = false;
  let failed = false;
  let failedCleanupDeadline: number | undefined;
  let closing = false;
  const aborts = new Set<AbortController>();
  const jobs = new Set<Promise<void>>();

  const handle: http.RequestListener = (request, response) => {
    const healthProbe = isUnauthenticatedHealthProbe(request);
    if (!healthProbe && !hasValidBearerCredential(request, apiKey)) {
      request.resume();
      writeUnauthorized(response);
      return;
    }

    const chat = request.method === "POST" && request.url === "/v1/chat/completions";
    if (!chat && !(request.method === "GET" && READ_ONLY_ROUTES.has(request.url ?? ""))) {
      request.pause();
      writeRequestFailure(
        response,
        new PrivateBridgeRequestFailure(
          404,
          "route_not_available",
          "The requested server route is not available.",
        ),
      );
      return;
    }
    if (occupied || closing || failed) {
      request.pause();
      response.writeHead(503, {
        "Cache-Control": "no-store",
        "Retry-After": "1",
        Connection: "close",
      });
      response.end();
      return;
    }
    occupied = true;
    const abort = new AbortController();
    aborts.add(abort);
    const requestDeadline = performance.now() + REQUEST_TIMEOUT_MS;
    const remainingRequestMilliseconds = () =>
      Math.min(REQUEST_TIMEOUT_MS, Math.max(0, requestDeadline - performance.now()));
    const expire = () => {
      writeRequestFailure(
        response,
        new PrivateBridgeRequestFailure(
          504,
          "request_timeout",
          "The inference request deadline expired.",
        ),
      );
      abort.abort();
    };
    const deadline = setTimeout(expire, REQUEST_TIMEOUT_MS);
    deadline.unref();
    response.once("close", () => {
      clearTimeout(deadline);
      if (!response.writableEnded) abort.abort();
    });
    const job = (async () => {
      let clientId: string | undefined;
      let creatingClient = false;
      let completedResponse = false;
      let child: ReturnType<DockerOperationAuthority["spawn"]> | undefined;
      try {
        if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BODY_BYTES) {
          throw new PrivateBridgeRequestFailure(
            413,
            "request_body_too_large",
            "Request body exceeds the declared limit.",
          );
        }
        const encoding = String(request.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        if (encoding !== "" && encoding !== "identity") {
          throw new PrivateBridgeRequestFailure(
            415,
            "content_encoding_unsupported",
            "Compressed request bodies are not supported.",
          );
        }
        if (
          chat &&
          String(request.headers["content-type"] ?? "")
            .split(";")[0]!
            .trim()
            .toLowerCase() !== "application/json"
        ) {
          throw new PrivateBridgeRequestFailure(
            415,
            "content_type_unsupported",
            "Chat Completions request must use application/json.",
          );
        }
        if (request.headers.expect?.toLowerCase() === "100-continue") response.writeContinue();
        const received = await readBoundedRequestBody(request, abort.signal);
        const body = chat ? boundedChatBody(received) : received;
        if (abort.signal.aborted || response.destroyed) return;
        if (remainingRequestMilliseconds() <= 0) {
          expire();
          return;
        }

        const headers = endToEndHeaders(request.headers);
        headers.host = `${authority.targetHost}:${String(targetPort)}`;
        headers["content-length"] = String(body.length);
        if (healthProbe) delete headers.authorization;
        else headers.authorization = canonicalAuthorization;
        for (const name of [
          "forwarded",
          "x-forwarded-for",
          "x-forwarded-host",
          "x-forwarded-proto",
        ])
          delete headers[name];
        if (docker) {
          creatingClient = true;
          clientId = createNativeClient(
            docker,
            authority as LlamaCppPrivateBridgeArguments,
            Date.now() + Math.min(REMOTE_CLEANUP_MS, remainingRequestMilliseconds()),
          );
          child = docker.spawn(["start", "--attach", "--interactive", clientId], {
            stdio: ["pipe", "pipe", "ignore"],
          });
        }
        await new Promise<void>((resolve, reject) => {
          let complete = false;
          const upstream = http.request(
            {
              headers,
              host: authority.targetHost,
              method: request.method,
              path: request.url,
              port: targetPort,
              signal: abort.signal,
              ...(child === undefined
                ? {}
                : {
                    // curl emits the original HTTP/1.1 framing (--include --raw).
                    // Keep Node's existing HTTP parser; curl owns sending the request.
                    createConnection: () =>
                      Duplex.fromWeb({
                        readable: Readable.toWeb(child!.stdout!),
                        writable: Writable.toWeb(
                          new Writable({
                            write(_chunk, _encoding, callback) {
                              callback();
                            },
                          }),
                        ),
                      }) as net.Socket,
                  }),
            },
            (upstreamResponse) => {
              if (abort.signal.aborted || response.destroyed || response.headersSent) {
                upstreamResponse.destroy();
                reject(remoteFailure());
                return;
              }
              const responseHeaders = endToEndHeaders(upstreamResponse.headers);
              // End the HTTP response only after the remote cleanup proof. A
              // forwarded Content-Length would let clients finish reading early.
              delete responseHeaders["content-length"];
              response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
              upstreamResponse.once("error", reject);
              upstreamResponse.once("end", () => {
                complete = true;
                resolve();
              });
              upstreamResponse.pipe(response, { end: false });
            },
          );
          upstream.once("error", reject);
          response.once("error", () => abort.abort());
          if (child) {
            child.once("error", () => upstream.destroy(remoteFailure()));
            child.once("close", (code) => {
              if (!complete && code !== 0) upstream.destroy(remoteFailure());
            });
            child.stdin?.once("error", () => upstream.destroy(remoteFailure()));
            if (!child.stdin || !child.stdout) {
              upstream.destroy(remoteFailure());
              return;
            }
            // Docker start is asynchronous. Prove the owned process is running
            // before giving it the credential and request body.
            const startedDeadline = Date.now() + Math.min(5_000, remainingRequestMilliseconds());
            while (
              !requireOwnedNativeClient(
                docker!.engine,
                clientId!,
                authority.transactionId!,
                startedDeadline,
              ).State.Running
            ) {
              if (Date.now() >= startedDeadline) {
                upstream.destroy(remoteFailure());
                return;
              }
              Atomics.wait(SLEEP_ARRAY, 0, 0, 20);
            }
            if (remainingRequestMilliseconds() <= 0) {
              expire();
              return;
            }
            child.stdin.end(
              curlInput(
                targetPort,
                request.method!,
                request.url!,
                headers,
                body,
                Math.max(0.001, remainingRequestMilliseconds() / 1_000),
                true,
              ),
            );
          }
          upstream.end(body);
        });
        completedResponse = true;
      } catch (error) {
        request.pause();
        if (!abort.signal.aborted) {
          if (remainingRequestMilliseconds() <= 0) expire();
          else if (error instanceof PrivateBridgeRequestFailure)
            writeRequestFailure(response, error);
          else writeUpstreamUnavailable(response);
        }
      } finally {
        const cleanupDeadline = Date.now() + REMOTE_CLEANUP_MS;
        try {
          if (docker && clientId)
            finishNativeClient(
              docker.engine,
              clientId,
              authority.transactionId!,
              apiKey,
              targetPort,
              cleanupDeadline,
              chat,
            );
          else if (docker && creatingClient) {
            // A timed-out create can have committed remotely. Reconcile its
            // ownership labels, and keep admission closed after uncertainty.
            failed = true;
            cleanupLlamaCppPrivateBridgeRequests(
              docker.engine,
              authority.transactionId!,
              apiKey,
              targetPort,
              cleanupDeadline,
            );
          }
        } catch {
          failed = true;
          if (!response.destroyed) response.destroy();
        } finally {
          child?.kill("SIGKILL");
          aborts.delete(abort);
          clearTimeout(deadline);
          if (!failed) occupied = false;
          if (completedResponse && !response.destroyed && !response.writableEnded) response.end();
          if (failed) {
            failedCleanupDeadline = cleanupDeadline;
            onFailure?.(
              new Error(
                `Native request cleanup could not be verified for transaction ${authority.transactionId}, request ${clientId ?? "create-in-progress"}. Restart through managed onboarding after correcting the Docker or ownership failure.`,
              ),
            );
          }
        }
      }
    })();
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  return {
    handle,
    close: async () => {
      // Reconciliation shares the failed request's budget; shutdown must not
      // grant another full cleanup window after that budget has expired.
      const cleanupDeadline = Math.min(
        failedCleanupDeadline ?? Infinity,
        Date.now() + REMOTE_CLEANUP_MS,
      );
      closing = true;
      for (const abort of aborts) abort.abort();
      await Promise.all([...jobs]);
      if (docker)
        cleanupLlamaCppPrivateBridgeRequests(
          docker.engine,
          authority.transactionId!,
          apiKey,
          targetPort,
          cleanupDeadline,
        );
    },
  };
}

export function createLlamaCppPrivateBridgeServer(
  authority: Pick<
    LlamaCppPrivateBridgeArguments,
    "targetHost" | "targetPort" | "containerId" | "dockerAuthorityId"
  > & { readonly transactionId?: string },
  apiKey: string,
): http.Server & { closeOwnedWork: () => Promise<void> } {
  const handler = createLlamaCppPrivateBridgeRequestHandler(authority, apiKey);
  return privateBridgeServer(handler);
}

function privateBridgeServer(
  handler: ReturnType<typeof createLlamaCppPrivateBridgeRequestHandler>,
): http.Server & { closeOwnedWork: () => Promise<void> } {
  const server = http.createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES });
  server.on("checkContinue", handler.handle);
  server.on("request", handler.handle);
  return Object.assign(server, { closeOwnedWork: handler.close });
}

export async function runLlamaCppPrivateBridge(
  authority: LlamaCppPrivateBridgeArguments,
  apiKey: string,
  onReady?: () => void,
): Promise<void> {
  const servers: http.Server[] = [];
  let failure: Error | undefined;
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const close = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    stop();
  };
  const handler = createLlamaCppPrivateBridgeRequestHandler(authority, apiKey, (error) => {
    failure = error;
    close();
  });
  servers.push(...authority.bindAddresses.map(() => privateBridgeServer(handler)));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  try {
    await Promise.all(
      servers.map(
        (server, index) =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(
              {
                host: authority.bindAddresses[index]!,
                port: authority.listenPort,
                exclusive: true,
              },
              () => resolve(),
            );
          }),
      ),
    );
    onReady?.();
    await Promise.race([
      stopped,
      new Promise<void>((_resolve, reject) => {
        for (const server of servers) server.once("error", reject);
      }),
    ]);
    if (failure) throw failure;
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    close();
    try {
      await handler.close();
    } catch (error) {
      throw failure ?? error;
    }
  }
}

if (require.main === module) {
  let startupReported = false;
  const reportStartup = (status: "READY" | "FAILED") => {
    if (startupReported) return;
    startupReported = true;
    try {
      fs.writeSync(STARTUP_STATUS_DESCRIPTOR, status);
    } catch {
      // The parent may have timed out and closed its startup descriptor.
    } finally {
      try {
        fs.closeSync(STARTUP_STATUS_DESCRIPTOR);
      } catch {
        // The descriptor may already be closed after a failed write.
      }
    }
  };
  Promise.resolve()
    .then(() =>
      runLlamaCppPrivateBridge(
        parseLlamaCppPrivateBridgeArguments(process.argv.slice(2)),
        readPrivateBridgeApiKey(),
        () => reportStartup("READY"),
      ),
    )
    .catch((error: unknown) => {
      reportStartup("FAILED");
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
