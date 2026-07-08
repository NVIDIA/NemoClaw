#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256 =
  "b604a8c355ca9ec67ae1ad368537861e78cadfa1441a55da02c43df3313aee68"; // gitleaks:allow -- checked-in SHA-256 integrity pin

export const LOCAL_CREDENTIAL_HELPER_HOST = "127.0.0.1";
export const LOCAL_CREDENTIAL_FORM_PATH = "/local-credential-form.html";
export const LOCAL_CREDENTIAL_SUBMIT_PATH = "/submit";
export const LOCAL_CREDENTIAL_CAPABILITY_HEADER = "x-nemoclaw-capability";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FORM_BYTES = 1024 * 1024;
const MAX_FIELD_COUNT = 16;
const MAX_FIELD_VALUE_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const FIELD_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,80}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINAL_FORM_SHA256_PATTERN = /^[a-f0-9]{64}$/;

// Keep this shape aligned with src/lib/security/credential-env.ts. This helper
// must remain standalone so a coding agent can run an integrity-checked copy
// before NemoClaw is installed.
export const CREDENTIAL_SHAPED_NAME_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|refresh[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|pass[_-]?code|personal[_-]?access[_-]?token|connection[_-]?string|webhook(?:[_-]?url)?|key|secret|token|password|passwd|passcode|auth|authorization|credential|credentials|bearer|bearer[_-]?token|cookie|cookies|pat|private|privatekey|pin|webhookurl|dsn|connectionstring)(?:$|[_-])/i;

const FORBIDDEN_CHILD_ENV_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "CLASSPATH",
  "COMSPEC",
  "ENV",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GLOBIGNORE",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_NODE_OPTIONS",
  "NPM_CONFIG_SCRIPT_SHELL",
  "NPM_CONFIG_USERCONFIG",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PERL5OPT",
  "PS4",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELL",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "_JAVA_OPTIONS",
]);

export type CredentialFieldType = "secret" | "text";

export type CredentialField = Readonly<{
  name: string;
  type: CredentialFieldType;
}>;

export type LocalCredentialHelperCliOptions = Readonly<{
  commandArgv: readonly string[];
  fields: readonly CredentialField[];
  formPath: string;
}>;

export type LocalCredentialHelperSession = Readonly<{
  completion: Promise<number>;
  origin: string;
  server: Server;
  url: string;
}>;

type SessionState = "pending" | "claimed" | "expired" | "closed";

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

function defaultFormPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "docs",
    "resources",
    "local-credential-form.html",
  );
}

export function isCredentialShapedName(name: string): boolean {
  return CREDENTIAL_SHAPED_NAME_PATTERN.test(name);
}

export function isForbiddenChildEnvName(name: string): boolean {
  return (
    FORBIDDEN_CHILD_ENV_NAMES.has(name) ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_") ||
    name === "GIT_CONFIG" ||
    name.startsWith("GIT_CONFIG_")
  );
}

export function parseCredentialField(spec: string): CredentialField {
  const parts = spec.split(":");
  if (parts.length !== 2) {
    throw new Error(`--field must use NAME:secret or NAME:text (received ${JSON.stringify(spec)})`);
  }

  const [name, rawType] = parts;
  if (!FIELD_NAME_PATTERN.test(name)) {
    throw new Error(
      `--field name must be an uppercase environment variable name: ${name || "<blank>"}`,
    );
  }
  if (rawType !== "secret" && rawType !== "text") {
    throw new Error(`--field type must be secret or text for ${name}`);
  }
  if (isForbiddenChildEnvName(name)) {
    throw new Error(`--field ${name} is a process-control environment variable and is not allowed`);
  }
  if (rawType === "text" && isCredentialShapedName(name)) {
    throw new Error(`--field ${name} looks credential-shaped and must use :secret`);
  }
  return Object.freeze({ name, type: rawType });
}

export function parseCliArguments(argv: readonly string[]): LocalCredentialHelperCliOptions {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("A literal -- separator followed by the approved command is required");
  }

  const optionArgs = argv.slice(0, separator);
  const commandArgv = argv.slice(separator + 1);
  if (commandArgv.length === 0 || commandArgv[0].length === 0) {
    throw new Error("An executable must follow the -- separator");
  }
  if (commandArgv.some((value) => value.includes("\0"))) {
    throw new Error("Command arguments must not contain NUL bytes");
  }

  let formPath = defaultFormPath();
  let formPathSeen = false;
  const fields: CredentialField[] = [];
  const fieldNames = new Set<string>();

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    if (option !== "--form" && option !== "--field") {
      throw new Error(`Unknown option before --: ${option}`);
    }
    const value = optionArgs[index + 1];
    if (value === undefined || value === "--form" || value === "--field") {
      throw new Error(`${option} requires a value`);
    }
    index += 1;

    if (option === "--form") {
      if (formPathSeen) throw new Error("--form may be specified only once");
      if (value.length === 0 || value.includes("\0")) {
        throw new Error("--form must be a non-empty path without NUL bytes");
      }
      formPath = path.resolve(value);
      formPathSeen = true;
      continue;
    }

    const field = parseCredentialField(value);
    if (fieldNames.has(field.name)) {
      throw new Error(`Duplicate --field name: ${field.name}`);
    }
    fieldNames.add(field.name);
    fields.push(field);
    if (fields.length > MAX_FIELD_COUNT) {
      throw new Error(`At most ${MAX_FIELD_COUNT} credential fields are allowed`);
    }
  }

  if (fields.length === 0) {
    throw new Error("At least one --field NAME:secret or --field NAME:text is required");
  }

  return Object.freeze({
    commandArgv: Object.freeze([...commandArgv]),
    fields: Object.freeze([...fields]),
    formPath,
  });
}

export function loadVerifiedCredentialForm(
  formPath: string,
  expectedSha256: string = EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256,
): Buffer {
  if (!FINAL_FORM_SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(
      "Local credential form SHA-256 is not finalized in scripts/local-credential-helper.mts",
    );
  }
  const bytes = readBoundedCredentialForm(formPath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (!timingSafeStringEqual(actualSha256, expectedSha256)) {
    throw new Error(`Local credential form SHA-256 mismatch: ${formPath}`);
  }
  return bytes;
}

function readBoundedCredentialForm(formPath: string): Buffer {
  const fileDescriptor = openSync(formPath, constants.O_RDONLY);
  try {
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile()) {
      throw new Error(`Local credential form is not a regular file: ${formPath}`);
    }
    if (stat.size <= 0 || stat.size > MAX_FORM_BYTES) {
      throw new Error(`Local credential form must be between 1 and ${MAX_FORM_BYTES} bytes`);
    }

    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fileDescriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) {
        throw new Error(`Local credential form changed while being read: ${formPath}`);
      }
      offset += count;
    }

    const extraByte = Buffer.alloc(1);
    if (readSync(fileDescriptor, extraByte, 0, 1, null) !== 0) {
      throw new Error(`Local credential form changed while being read: ${formPath}`);
    }
    return bytes;
  } finally {
    closeSync(fileDescriptor);
  }
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function rawHeaderValues(request: IncomingMessage, headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function requireSingleHeader(request: IncomingMessage, headerName: string): string {
  const values = rawHeaderValues(request, headerName);
  if (values.length !== 1) {
    throw new RequestError(400, `${headerName} header must appear exactly once`);
  }
  return values[0];
}

function capabilityMatches(request: IncomingMessage, expectedCapability: Buffer): boolean {
  const values = rawHeaderValues(request, LOCAL_CREDENTIAL_CAPABILITY_HEADER);
  if (values.length !== 1 || !CAPABILITY_PATTERN.test(values[0])) return false;
  const received = Buffer.from(values[0], "base64url");
  return (
    received.length === expectedCapability.length && timingSafeEqual(received, expectedCapability)
  );
}

function addCommonResponseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  addCommonResponseHeaders(response);
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    Connection: "close",
    "Content-Length": encoded.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

function sendRequestError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof RequestError ? error.status : 500;
  const message = error instanceof RequestError ? error.message : "Local helper request failed";
  sendJson(response, status, { error: message });
}

function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        wipeBuffers(chunks);
        bytes.fill(0);
        request.resume();
        reject(new RequestError(413, "Request body is too large"));
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks, total);
      wipeBuffers(chunks);
      resolve(body);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      wipeBuffers(chunks);
      reject(error);
    });
    request.on("aborted", () => {
      if (settled) return;
      settled = true;
      wipeBuffers(chunks);
      reject(new RequestError(400, "Request body was aborted"));
    });
  });
}

function wipeBuffers(buffers: Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
  buffers.length = 0;
}

function parseSubmittedValues(
  body: Buffer,
  fields: readonly CredentialField[],
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RequestError(400, "Request body must be valid JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !("values" in parsed)) {
    throw new RequestError(400, "Request body must contain only values");
  }
  const submitted = parsed.values;
  if (!isRecord(submitted)) {
    throw new RequestError(400, "values must be a JSON object");
  }

  const expectedNames = fields.map((field) => field.name).sort();
  const submittedNames = Object.keys(submitted).sort();
  if (
    expectedNames.length !== submittedNames.length ||
    expectedNames.some((name, index) => submittedNames[index] !== name)
  ) {
    throw new RequestError(400, "Submitted field names do not match the configured schema");
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of fields) {
    const value = submitted[field.name];
    if (typeof value !== "string" || value.length === 0) {
      throw new RequestError(400, `Submitted value for ${field.name} must be a non-empty string`);
    }
    if (value.includes("\0")) {
      throw new RequestError(400, `Submitted value for ${field.name} must not contain NUL bytes`);
    }
    if (Buffer.byteLength(value) > MAX_FIELD_VALUE_BYTES) {
      throw new RequestError(413, `Submitted value for ${field.name} is too large`);
    }
    values[field.name] = value;
  }
  return values;
}

export function buildCredentialFormCsp(formBytes: Buffer): string {
  const source = formBytes.toString("utf8");
  const script = extractSingleInlineTag(source, "script");
  const style = extractSingleInlineTag(source, "style");
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const styleHash = createHash("sha256").update(style).digest("base64");
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function extractSingleInlineTag(source: string, tagName: "script" | "style"): string {
  const matches = [...source.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "g"))];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(`Local credential form must contain exactly one inline <${tagName}> block`);
  }
  return matches[0][1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildFormRequestTarget(fields: readonly CredentialField[]): string {
  const params = new URLSearchParams();
  for (const field of fields) params.append("field", `${field.name}:${field.type}`);
  return `${LOCAL_CREDENTIAL_FORM_PATH}?${params.toString()}`;
}

function stopAcceptingConnections(server: Server): void {
  try {
    server.close();
  } catch {
    // Best-effort shutdown only.
  }
}

function destroySockets(sockets: ReadonlySet<Socket>, except?: Socket): void {
  for (const socket of sockets) {
    if (socket !== except) socket.destroy();
  }
}

// JavaScript strings and a spawned child's copied environment cannot be reliably
// zeroed. Drop helper-owned references promptly; only mutable buffers are wiped.
function clearCredentialReferences(
  values: Record<string, string>,
  fields: readonly CredentialField[],
): void {
  for (const field of fields) {
    if (Object.hasOwn(values, field.name)) values[field.name] = "";
    delete values[field.name];
  }
}

export async function startLocalCredentialHelper(options: {
  commandArgv: readonly string[];
  fields: readonly CredentialField[];
  formBytes: Buffer;
  timeoutMs?: number;
}): Promise<LocalCredentialHelperSession> {
  if (options.fields.length === 0 || options.fields.length > MAX_FIELD_COUNT) {
    throw new Error(`Local credential helper requires between 1 and ${MAX_FIELD_COUNT} fields`);
  }
  const fieldNames = new Set<string>();
  const fields = Object.freeze(
    options.fields.map((field) => {
      const validated = parseCredentialField(`${field.name}:${field.type}`);
      if (fieldNames.has(validated.name)) {
        throw new Error(`Duplicate credential field name: ${validated.name}`);
      }
      fieldNames.add(validated.name);
      return validated;
    }),
  );
  const commandArgv = Object.freeze([...options.commandArgv]);
  if (
    commandArgv.length === 0 ||
    !commandArgv[0] ||
    commandArgv.some((arg) => arg.includes("\0"))
  ) {
    throw new Error("Local credential helper requires a NUL-free executable and argv");
  }
  const timeoutMs = options.timeoutMs ?? SESSION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Local credential helper timeout must be a positive number");
  }
  const formBytes = Buffer.from(options.formBytes);
  const trustedEnv = Object.freeze({ ...process.env });
  const capabilityBytes = randomBytes(32);
  const capability = capabilityBytes.toString("base64url");
  const formRequestTarget = buildFormRequestTarget(fields);
  const formCsp = buildCredentialFormCsp(formBytes);
  const sockets = new Set<Socket>();
  let state: SessionState = "pending";
  let expectedHost = "";
  let expectedOrigin = "";
  let child: ChildProcess | null = null;
  let resolveCompletion: (code: number) => void = () => undefined;
  const completion = new Promise<number>((resolve) => {
    resolveCompletion = resolve;
  });

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      request.resume();
      sendRequestError(response, error);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  const finishWithoutChild = (nextState: "expired" | "closed", message: string): void => {
    if (state !== "pending") return;
    state = nextState;
    capabilityBytes.fill(0);
    stopAcceptingConnections(server);
    destroySockets(sockets);
    console.error(message);
    resolveCompletion(1);
  };

  const timeout = setTimeout(
    () => finishWithoutChild("expired", "Local credential helper expired before confirmation."),
    timeoutMs,
  );

  const launchApprovedCommand = (values: Record<string, string>): void => {
    const childEnv: NodeJS.ProcessEnv = { ...trustedEnv, ...values };
    try {
      child = spawn(commandArgv[0], commandArgv.slice(1), {
        env: childEnv,
        shell: false,
        stdio: "inherit",
      });
    } catch (error) {
      clearCredentialReferences(childEnv as Record<string, string>, fields);
      clearCredentialReferences(values, fields);
      console.error(
        `Local credential helper could not start the approved command: ${error instanceof Error ? error.message : String(error)}`,
      );
      resolveCompletion(1);
      return;
    }
    clearCredentialReferences(childEnv as Record<string, string>, fields);
    clearCredentialReferences(values, fields);
    console.error("Approved command started.");
    child.once("error", (error) => {
      console.error(`Approved command failed to start: ${error.message}`);
      resolveCompletion(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`Approved command exited after signal ${signal}.`);
        resolveCompletion(1);
        return;
      }
      resolveCompletion(code ?? 1);
    });
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = requireSingleHeader(request, "host");
    if (host !== expectedHost) throw new RequestError(421, "Request Host is not the local helper");

    if (request.method === "GET" && request.url === formRequestTarget) {
      if (state !== "pending")
        throw new RequestError(410, "Credential session is no longer active");
      addCommonResponseHeaders(response);
      response.writeHead(200, {
        "Content-Length": formBytes.length,
        "Content-Security-Policy": formCsp,
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(formBytes);
      return;
    }

    if (request.method !== "POST" || request.url !== LOCAL_CREDENTIAL_SUBMIT_PATH) {
      throw new RequestError(404, "Not found");
    }
    if (state !== "pending") throw new RequestError(409, "Credential session was already claimed");
    if (requireSingleHeader(request, "origin") !== expectedOrigin) {
      throw new RequestError(403, "Request Origin is not the local helper");
    }
    if (requireSingleHeader(request, "content-type").trim().toLowerCase() !== "application/json") {
      throw new RequestError(415, "Content-Type must be application/json");
    }
    if (rawHeaderValues(request, "content-encoding").length !== 0) {
      throw new RequestError(415, "Content-Encoding is not supported");
    }
    if (rawHeaderValues(request, "transfer-encoding").length !== 0) {
      throw new RequestError(400, "Transfer-Encoding is not supported");
    }
    if (!capabilityMatches(request, capabilityBytes)) {
      throw new RequestError(403, "Credential capability is invalid");
    }

    const contentLengthValues = rawHeaderValues(request, "content-length");
    if (contentLengthValues.length > 1) {
      throw new RequestError(400, "Content-Length must not be repeated");
    }
    if (contentLengthValues.length === 1) {
      const contentLength = Number(contentLengthValues[0]);
      if (!Number.isInteger(contentLength) || contentLength < 0) {
        throw new RequestError(400, "Content-Length is invalid");
      }
      if (contentLength > MAX_BODY_BYTES) throw new RequestError(413, "Request body is too large");
    }

    const body = await readBoundedBody(request);
    let values: Record<string, string>;
    try {
      values = parseSubmittedValues(body, fields);
    } finally {
      body.fill(0);
    }

    // Recheck after the asynchronous body read. JavaScript executes this claim
    // synchronously, so exactly one concurrent valid request can transition the
    // session and launch the approved command.
    if (state !== "pending") {
      clearCredentialReferences(values, fields);
      throw new RequestError(409, "Credential session was already claimed");
    }
    state = "claimed";
    clearTimeout(timeout);
    capabilityBytes.fill(0);
    stopAcceptingConnections(server);
    destroySockets(sockets, request.socket);
    response.once("finish", () => request.socket.destroy());
    sendJson(response, 202, { accepted: true });
    launchApprovedCommand(values);
  }

  server.once("error", (error) => {
    if (state === "pending") {
      state = "closed";
      clearTimeout(timeout);
      capabilityBytes.fill(0);
      stopAcceptingConnections(server);
      destroySockets(sockets);
      console.error(`Local credential helper server failed: ${error.message}`);
      resolveCompletion(1);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, LOCAL_CREDENTIAL_HELPER_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    finishWithoutChild("closed", "Local credential helper could not determine its local port.");
    throw new Error("Local credential helper did not acquire a TCP address");
  }
  expectedHost = `${LOCAL_CREDENTIAL_HELPER_HOST}:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const url = `${expectedOrigin}${formRequestTarget}#cap=${capability}`;

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child) {
      child.kill(signal);
      return;
    }
    clearTimeout(timeout);
    finishWithoutChild("closed", `Local credential helper stopped by ${signal}.`);
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  completion.finally(() => {
    clearTimeout(timeout);
    capabilityBytes.fill(0);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    stopAcceptingConnections(server);
    if (state !== "claimed") destroySockets(sockets);
  });

  return Object.freeze({ completion, origin: expectedOrigin, server, url });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseCliArguments(argv);
  const formBytes = loadVerifiedCredentialForm(options.formPath);
  const session = await startLocalCredentialHelper({
    commandArgv: options.commandArgv,
    fields: options.fields,
    formBytes,
  });
  console.error("Open this one-time local URL in the coding-agent browser:");
  console.log(session.url);
  return session.completion;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
