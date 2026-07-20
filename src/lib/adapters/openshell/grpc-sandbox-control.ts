// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { EventEmitter } from "node:events";
import { isIP } from "node:net";
import path from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import {
  OPENSHELL_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
  OpenShellExecOutputLimitError,
  type OpenShellSandboxControl,
  openShellExecRequestValidationFailure,
  type SandboxExecRequest,
  type SandboxExecResult,
  validateOpenShellExecRequest,
} from "./sandbox-control";

const PROTO_VERSION = "0.0.72";

interface GetSandboxResponse {
  sandbox?: { metadata?: { id?: string } };
}

interface ExecSandboxEvent {
  stdout?: { data?: Buffer | Uint8Array | string };
  stderr?: { data?: Buffer | Uint8Array | string };
  exit?: { exitCode?: number };
}

interface ExecEventStream extends EventEmitter {
  cancel(): void;
}

export interface OpenShellGrpcApi {
  getSandbox(
    request: { name: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response?: GetSandboxResponse) => void,
  ): unknown;
  execSandbox(
    request: {
      sandboxId: string;
      command: readonly string[];
      stdin?: Buffer;
      timeoutSeconds?: number;
    },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): ExecEventStream;
  close(): void;
}

export interface OpenShellGrpcClientConfig {
  /** Full gateway URL, including http:// or https://. */
  endpoint: string;
  /** Optional private CA for a TLS gateway. System roots are used when omitted. */
  caCertificate?: Buffer;
  /** mTLS client certificate. Must be provided together with clientKey. */
  clientCertificate?: Buffer;
  /** mTLS client private key. Must be provided together with clientCertificate. */
  clientKey?: Buffer;
  /** Optional gateway authorization token. Allowed only with TLS. */
  bearerToken?: string;
}

export interface GrpcOpenShellSandboxControl extends OpenShellSandboxControl {
  close(): void;
}

export { OpenShellExecOutputLimitError as OpenShellGrpcOutputLimitError } from "./sandbox-control";

export class OpenShellGrpcPreDispatchError extends Error {
  constructor(readonly cause: Error) {
    super(cause.message, { cause });
    this.name = "OpenShellGrpcPreDispatchError";
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  return (
    (version === 4 && normalized.startsWith("127.")) || (version === 6 && normalized === "::1")
  );
}

function parseEndpoint(endpoint: string): { target: string; secure: boolean } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`Invalid OpenShell gRPC endpoint: ${(error as Error).message}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenShell gRPC endpoint must use http:// or https://");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "OpenShell gRPC endpoint must not contain credentials, a path, query, or fragment",
    );
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("Plaintext OpenShell gRPC is restricted to loopback endpoints");
  }
  const secure = url.protocol === "https:";
  return {
    target: `${url.hostname}:${url.port || (secure ? "443" : "80")}`,
    secure,
  };
}

function validateBearerToken(token: string | undefined, secure: boolean): void {
  if (token === undefined) return;
  if (!secure) throw new Error("OpenShell gRPC bearer authentication requires TLS");
  if (!token || token.trim() !== token || /[\r\n]/.test(token)) {
    throw new Error(
      "OpenShell gRPC bearer token must be non-empty and contain no surrounding whitespace",
    );
  }
}

function validateTlsMaterial(config: OpenShellGrpcClientConfig, secure: boolean): void {
  const hasClientCertificate = config.clientCertificate !== undefined;
  const hasClientKey = config.clientKey !== undefined;
  if (hasClientCertificate !== hasClientKey) {
    throw new Error("OpenShell gRPC clientCertificate and clientKey must be provided together");
  }
  if (!secure && (config.caCertificate !== undefined || hasClientCertificate || hasClientKey)) {
    throw new Error("OpenShell gRPC TLS credentials require an https:// endpoint");
  }
}

export function validateOpenShellGrpcClientConfig(config: OpenShellGrpcClientConfig): void {
  const { secure } = parseEndpoint(config.endpoint);
  validateBearerToken(config.bearerToken, secure);
  validateTlsMaterial(config, secure);
}

function createChannelCredentials(
  config: OpenShellGrpcClientConfig,
  secure: boolean,
): grpc.ChannelCredentials {
  validateTlsMaterial(config, secure);
  if (!secure) {
    return grpc.credentials.createInsecure();
  }
  return grpc.credentials.createSsl(
    config.caCertificate ?? null,
    config.clientKey ?? null,
    config.clientCertificate ?? null,
  );
}

function protocolPath(): string {
  return path.resolve(
    __dirname,
    `../../../../third_party/openshell/v${PROTO_VERSION}/proto/openshell.proto`,
  );
}

export function createOpenShellGrpcApi(config: OpenShellGrpcClientConfig): OpenShellGrpcApi {
  validateOpenShellGrpcClientConfig(config);
  const { target, secure } = parseEndpoint(config.endpoint);
  const credentials = createChannelCredentials(config, secure);
  const protoFile = protocolPath();
  const packageDefinition = protoLoader.loadSync(protoFile, {
    defaults: false,
    enums: String,
    includeDirs: [path.dirname(protoFile)],
    keepCase: false,
    longs: String,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } };
  };
  return new loaded.openshell.v1.OpenShell(target, credentials) as unknown as OpenShellGrpcApi;
}

function callMetadata(bearerToken: string | undefined): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (bearerToken) metadata.set("authorization", `Bearer ${bearerToken}`);
  return metadata;
}

function sandboxId(
  client: OpenShellGrpcApi,
  sandboxName: string,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSandbox({ name: sandboxName }, metadata, options, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      const id = response?.sandbox?.metadata?.id;
      if (!id) {
        reject(new Error(`OpenShell returned sandbox '${sandboxName}' without an id`));
        return;
      }
      resolve(id);
    });
  });
}

function asBuffer(data: Buffer | Uint8Array | string | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function execute(
  client: OpenShellGrpcApi,
  id: string,
  request: SandboxExecRequest,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
): Promise<SandboxExecResult> {
  const maxOutputBytes = request.maxOutputBytes ?? OPENSHELL_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const timeoutSeconds =
      request.timeoutMs && request.timeoutMs > 0 ? Math.ceil(request.timeoutMs / 1000) : undefined;
    const stream = client.execSandbox(
      {
        sandboxId: id,
        command: request.command,
        stdin: request.stdin === undefined ? undefined : Buffer.from(request.stdin),
        timeoutSeconds,
      },
      metadata,
      options,
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let retainedBytes = 0;
    let status: number | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      const stdoutBytes = Buffer.concat(stdoutChunks);
      const stdout = request.stdoutEncoding === "buffer" ? "" : stdoutBytes.toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result: SandboxExecResult = { status, stdout, stderr };
      if (request.stdoutEncoding === "buffer") result.stdoutBytes = stdoutBytes;
      if (error) result.error = error;
      resolve(result);
    };

    const append = (destination: "stdout" | "stderr", data: Buffer) => {
      const remaining = maxOutputBytes - retainedBytes;
      const retained = data.subarray(0, Math.max(0, remaining));
      retainedBytes += retained.length;
      if (destination === "stdout") stdoutChunks.push(retained);
      else stderrChunks.push(retained);
      if (retained.length < data.length) {
        finish(new OpenShellExecOutputLimitError(maxOutputBytes));
        stream.cancel();
      }
    };

    stream.on("data", (event: ExecSandboxEvent) => {
      if (settled) return;
      if (event.stdout) append("stdout", asBuffer(event.stdout.data));
      else if (event.stderr) append("stderr", asBuffer(event.stderr.data));
      else if (event.exit) {
        // Rust/prost omits a proto3 scalar whose value is the default zero, so
        // a successful command arrives through proto-loader as `exit: {}`.
        // The enclosing oneof message is the exit-status signal; a missing
        // scalar inside that present message therefore means exit code 0.
        const exitCode = event.exit.exitCode === undefined ? 0 : event.exit.exitCode;
        if (Number.isInteger(exitCode)) status = exitCode;
      }
    });
    stream.on("error", (error: Error) => finish(error));
    stream.on("end", () => {
      if (status === null) {
        finish(new Error("OpenShell gRPC exec stream ended without an exit status"));
      } else {
        finish();
      }
    });
  });
}

export function createGrpcOpenShellSandboxControl(
  config: OpenShellGrpcClientConfig,
  injectedClient?: OpenShellGrpcApi,
): GrpcOpenShellSandboxControl {
  validateOpenShellGrpcClientConfig(config);
  const client = injectedClient ?? createOpenShellGrpcApi(config);
  return {
    close: () => client.close(),
    async exec(request): Promise<SandboxExecResult> {
      // Validate against the exact v0.0.72 UUID-width request before lookup so
      // transport-independent limits cannot cause any gateway activity.
      const validationError = validateOpenShellExecRequest(request);
      if (validationError) return openShellExecRequestValidationFailure(validationError);
      const metadata = callMetadata(config.bearerToken);
      const deadline =
        request.timeoutMs && request.timeoutMs > 0
          ? new Date(Date.now() + request.timeoutMs)
          : undefined;
      const options: grpc.CallOptions = deadline ? { deadline } : {};
      let id: string;
      try {
        id = await sandboxId(client, request.sandboxName, metadata, options);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: new OpenShellGrpcPreDispatchError(cause),
        };
      }
      const requestValidationError = validateOpenShellExecRequest(request, id);
      if (requestValidationError) {
        return openShellExecRequestValidationFailure(requestValidationError);
      }
      return execute(client, id, request, metadata, options);
    },
  };
}
