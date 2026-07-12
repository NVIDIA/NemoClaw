// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createPrivateKey, sign as signPayload } from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { buildDockerDriverGatewayLaunch as buildDockerDriverGatewayLaunchSource } from "../../../src/lib/onboard/docker-driver-gateway-launch";
import type { ensureDockerDriverGatewayLocalTlsBundle as ensureDockerDriverGatewayLocalTlsBundleSource } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";

const SANDBOX_JWT_SUBJECT_PREFIX = "spiffe://openshell/sandbox/";
const DOCKER_GRPC_PROBE_IMAGE =
  "node:22-trixie-slim@sha256:2d9f5c76c8f4dd36e8f253bee5d828a83a6c09f36188f0b0414325232e0b175d";

const FORBIDDEN_AUTH_ARTIFACT_CONTENT: Array<{ label: string; pattern: RegExp }> = [
  { label: "authorization header", pattern: /["']?authorization["']?\s*[:=]/i },
  {
    label: "Bearer JWT",
    pattern: /\bBearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
  { label: "JWT signing-key path", pattern: /(?:^|[/\\])jwt[/\\]signing\.pem\b/i },
  { label: "JWT key-id path", pattern: /(?:^|[/\\])jwt[/\\]kid\b/i },
  { label: "gateway auth config path", pattern: /\bopenshell-gateway\.toml\b/i },
  {
    label: "gateway JWT configuration",
    pattern: /\[openshell\.gateway\.gateway_jwt\]/i,
  },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

type SkipFn = (message?: string) => void;

type ScenarioFixtures = {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  host: HostCliClient;
  skip: SkipFn;
};

export type GatewayAuthSourceContractDependencies = {
  buildDockerDriverGatewayLaunch: typeof buildDockerDriverGatewayLaunchSource;
  ensureDockerDriverGatewayLocalTlsBundle: typeof ensureDockerDriverGatewayLocalTlsBundleSource;
};

type GrpcResult = {
  body: string;
  error?: string;
  grpcMessage?: string;
  grpcStatus?: string;
  httpStatus: number;
};

export type SpawnResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

type SandboxTokenContainerProbeOptions = {
  authorization?: string;
  dockerBin: string;
  networkName: string;
  payload: Buffer;
  port: number;
  stateDir: string;
  useHostNetwork?: boolean;
};

const CONTAINER_PROBE_CA_PATH = "/tmp/nemoclaw-probe-ca.crt";
const CONTAINER_PROBE_CLIENT_CERT_PATH = "/tmp/nemoclaw-probe-client.crt";
const CONTAINER_PROBE_CLIENT_KEY_PATH = "/tmp/nemoclaw-probe-client.key";

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandOutput(result: SpawnResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function assertOpenShellGatewayAuthArtifactsSafe(rootDir: string): void {
  const root = path.resolve(rootDir);
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': non-regular file`,
        );
      }
      if (
        /^(?:.*\/)?jwt\/(?:signing\.pem|kid)$|(?:^|\/)openshell-gateway\.toml$/i.test(relativePath)
      ) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': sensitive auth file name`,
        );
      }
      const content = fs.readFileSync(absolutePath, "utf-8");
      const forbidden = FORBIDDEN_AUTH_ARTIFACT_CONTENT.find(({ pattern }) =>
        pattern.test(content),
      );
      if (forbidden) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': ${forbidden.label}`,
        );
      }
    }
  };
  visit(root);
}

export async function withOpenShellGatewayAuthArtifactSafety<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    assertOpenShellGatewayAuthArtifactsSafe(rootDir);
  }
}

function resolveGatewayBin(): string | null {
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/opt/homebrew/bin/openshell-gateway",
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = run("sh", ["-c", "command -v openshell-gateway"]);
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

function resolveDockerBin(): string | null {
  for (const candidate of [
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/usr/bin/docker",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = run("sh", ["-c", "command -v docker"]);
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a TCP port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(value: string | string[] | number | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value == null ? "" : String(value);
}

function grpcFrame(payload: Uint8Array = new Uint8Array()): Buffer {
  const payloadBuffer = Buffer.from(payload);
  const frame = Buffer.alloc(5 + payloadBuffer.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payloadBuffer.length, 1);
  payloadBuffer.copy(frame, 5);
  return frame;
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  return Buffer.from(out);
}

function stringField(fieldNumber: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf-8");
  return Buffer.concat([Buffer.from([(fieldNumber << 3) | 2]), varint(bytes.length), bytes]);
}

function getSandboxConfigRequest(sandboxId: string): Buffer {
  return stringField(1, sandboxId);
}

function tlsOptions(stateDir: string, servername = "127.0.0.1"): http2.SecureClientSessionOptions {
  const bundle = getDockerDriverGatewayLocalTlsBundle(stateDir);
  return {
    ca: fs.readFileSync(bundle.caPath),
    cert: fs.readFileSync(bundle.clientCertPath),
    key: fs.readFileSync(bundle.clientKeyPath),
    rejectUnauthorized: true,
    servername,
  };
}

function callGrpc(options: {
  authorization?: string;
  payload?: Buffer;
  path: string;
  port: number;
  stateDir: string;
  timeoutMs?: number;
}): Promise<GrpcResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    let settled = false;
    let stream: http2.ClientHttp2Stream | null = null;
    const client = http2.connect(`https://127.0.0.1:${options.port}`, tlsOptions(options.stateDir));
    const chunks: Buffer[] = [];
    const result: GrpcResult = { body: "", httpStatus: 0 };

    const finish = (patch: Partial<GrpcResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream?.close();
      } catch {
        // best-effort cleanup
      }
      try {
        client.close();
      } catch {
        // best-effort cleanup
      }
      resolve({
        ...result,
        ...patch,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
    };

    const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    client.on("error", (error) => finish({ error: error.message }));

    stream = client.request({
      [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
      [http2.constants.HTTP2_HEADER_PATH]: options.path,
      [http2.constants.HTTP2_HEADER_SCHEME]: "https",
      [http2.constants.HTTP2_HEADER_AUTHORITY]: `127.0.0.1:${options.port}`,
      [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
      [http2.constants.HTTP2_HEADER_TE]: "trailers",
      ...(options.authorization ? { authorization: options.authorization } : {}),
    });
    stream.on("response", (headers) => {
      result.httpStatus = Number(headers[http2.constants.HTTP2_HEADER_STATUS] || 0);
      const status = headerValue(headers["grpc-status"]);
      const message = headerValue(headers["grpc-message"]);
      if (status) result.grpcStatus = status;
      if (message) result.grpcMessage = message;
    });
    stream.on("trailers", (headers) => {
      const status = headerValue(headers["grpc-status"]);
      const message = headerValue(headers["grpc-message"]);
      if (status) result.grpcStatus = status;
      if (message) result.grpcMessage = decodeURIComponent(message);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", (error) => finish({ error: error.message }));
    stream.on("end", () => finish());
    stream.end(grpcFrame(options.payload));
  });
}

async function waitForGatewayReady(options: {
  gateway: ChildProcess;
  logs: () => string;
  port: number;
  stateDir: string;
}): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (options.gateway.exitCode !== null) {
      throw new Error(`openshell-gateway exited early:\n${options.logs()}`);
    }
    const health = await callGrpc({
      path: "/openshell.v1.OpenShell/Health",
      port: options.port,
      stateDir: options.stateDir,
      timeoutMs: 2_000,
    });
    if (
      health.httpStatus === 200 &&
      (health.grpcStatus === "0" || health.grpcStatus === undefined)
    ) {
      return;
    }
    await delay(500);
  }
  throw new Error(`openshell-gateway did not become ready:\n${options.logs()}`);
}

function parseTomlString(toml: string, key: string): string {
  const match = toml.match(new RegExp(`^${key} = "([^"]+)"$`, "m"));
  if (!match?.[1]) throw new Error(`missing TOML key ${key}`);
  return match[1];
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function mintSandboxJwt(options: { configPath: string; sandboxId: string }): string {
  const toml = fs.readFileSync(options.configPath, "utf-8");
  const signingKeyPath = parseTomlString(toml, "signing_key_path");
  const kid = fs.readFileSync(parseTomlString(toml, "kid_path"), "utf-8").trim();
  const gatewayId = parseTomlString(toml, "gateway_id");
  const now = Math.floor(Date.now() / 1000);
  const identity = `openshell-gateway:${gatewayId}`;
  const header = base64UrlJson({ alg: "EdDSA", kid, typ: "JWT" });
  const payload = base64UrlJson({
    aud: identity,
    exp: now + 3600,
    iat: now,
    iss: identity,
    sandbox_id: options.sandboxId,
    sub: `${SANDBOX_JWT_SUBJECT_PREFIX}${options.sandboxId}`,
  });
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey(fs.readFileSync(signingKeyPath, "utf-8"));
  const signature = signPayload(null, Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function containerProbeNetworkArgs(networkName: string, useHostNetwork: boolean): string[] {
  return useHostNetwork
    ? ["--network", "host", "--add-host", "host.openshell.internal:127.0.0.1"]
    : ["--network", networkName, "--add-host", "host.openshell.internal:host-gateway"];
}

function noTokenContainerProbe(
  dockerBin: string,
  networkName: string,
  port: number,
  useHostNetwork: boolean,
): SpawnResult {
  const script = `
const http2 = require("node:http2");
const endpoint = "https://host.openshell.internal:${port}";
let settled = false;
const done = (status, value) => {
  if (settled) return;
  settled = true;
  console.log(JSON.stringify(value));
  process.exit(status);
};
const client = http2.connect(endpoint, { rejectUnauthorized: false });
const timer = setTimeout(() => done(3, { error: "timeout" }), 5000);
client.on("error", (error) => {
  clearTimeout(timer);
  done(2, { error: error.message });
});
const req = client.request({
  ":method": "POST",
  ":path": "/openshell.v1.OpenShell/ListSandboxes",
  ":scheme": "https",
  ":authority": "host.openshell.internal:${port}",
  "content-type": "application/grpc",
  "te": "trailers"
});
const result = { httpStatus: 0 };
req.on("response", (headers) => {
  result.httpStatus = Number(headers[":status"] || 0);
  if (headers["grpc-status"]) result.grpcStatus = String(headers["grpc-status"]);
  if (headers["grpc-message"]) result.grpcMessage = String(headers["grpc-message"]);
});
req.on("trailers", (headers) => {
  if (headers["grpc-status"]) result.grpcStatus = String(headers["grpc-status"]);
  if (headers["grpc-message"]) result.grpcMessage = String(headers["grpc-message"]);
});
req.on("error", (error) => {
  clearTimeout(timer);
  done(2, { error: error.message });
});
req.on("end", () => {
  clearTimeout(timer);
  client.close();
  done(0, result);
});
req.end(Buffer.alloc(5));
`;
  return run(dockerBin, [
    "run",
    "--rm",
    ...containerProbeNetworkArgs(networkName, useHostNetwork),
    DOCKER_GRPC_PROBE_IMAGE,
    "node",
    "-e",
    script,
  ]);
}

function sandboxTokenContainerProbeScript(): string {
  return `
const fs = require("node:fs");
const http2 = require("node:http2");

const port = process.env.PROBE_GATEWAY_PORT;
const path = process.env.PROBE_GRPC_PATH;
const authorization = process.env.PROBE_AUTHORIZATION;
const payload = Buffer.from(process.env.PROBE_PAYLOAD_B64 || "", "base64");

let settled = false;
const done = (status, value) => {
  if (settled) return;
  settled = true;
  console.log(JSON.stringify(value));
  process.exit(status);
};
const grpcFrame = Buffer.alloc(5 + payload.length);
grpcFrame.writeUInt8(0, 0);
grpcFrame.writeUInt32BE(payload.length, 1);
payload.copy(grpcFrame, 5);

const endpoint = \`https://host.openshell.internal:\${port}\`;
const client = http2.connect(endpoint, {
  ca: fs.readFileSync(process.env.PROBE_CA_PATH),
  cert: fs.readFileSync(process.env.PROBE_CLIENT_CERT_PATH),
  key: fs.readFileSync(process.env.PROBE_CLIENT_KEY_PATH),
  rejectUnauthorized: true,
  servername: "host.openshell.internal"
});
const chunks = [];
const result = { httpStatus: 0 };
const timer = setTimeout(() => done(3, { error: "timeout" }), 5000);

client.on("error", (error) => {
  clearTimeout(timer);
  done(2, { error: error.message });
});
const headers = {
  ":method": "POST",
  ":path": path,
  ":scheme": "https",
  ":authority": \`host.openshell.internal:\${port}\`,
  "content-type": "application/grpc",
  "te": "trailers"
};
if (authorization) headers.authorization = authorization;
const req = client.request(headers);
req.on("response", (headers) => {
  result.httpStatus = Number(headers[":status"] || 0);
  if (headers["grpc-status"]) result.grpcStatus = String(headers["grpc-status"]);
  if (headers["grpc-message"]) result.grpcMessage = String(headers["grpc-message"]);
});
req.on("trailers", (headers) => {
  if (headers["grpc-status"]) result.grpcStatus = String(headers["grpc-status"]);
  if (headers["grpc-message"]) result.grpcMessage = String(headers["grpc-message"]);
});
req.on("data", (chunk) => chunks.push(chunk));
req.on("error", (error) => {
  clearTimeout(timer);
  done(2, { error: error.message });
});
req.on("end", () => {
  clearTimeout(timer);
  client.close();
  result.body = Buffer.concat(chunks).toString("base64");
  done(0, result);
});
req.end(grpcFrame);
`;
}

export function buildSandboxTokenContainerProbeDockerArgs(
  options: SandboxTokenContainerProbeOptions,
): string[] {
  const bundle = getDockerDriverGatewayLocalTlsBundle(options.stateDir);
  const script = sandboxTokenContainerProbeScript();
  return [
    "run",
    "--rm",
    ...containerProbeNetworkArgs(options.networkName, options.useHostNetwork ?? false),
    "--volume",
    `${path.resolve(bundle.caPath)}:${CONTAINER_PROBE_CA_PATH}:ro`,
    "--volume",
    `${path.resolve(bundle.clientCertPath)}:${CONTAINER_PROBE_CLIENT_CERT_PATH}:ro`,
    "--volume",
    `${path.resolve(bundle.clientKeyPath)}:${CONTAINER_PROBE_CLIENT_KEY_PATH}:ro`,
    ...(options.authorization ? ["--env", `PROBE_AUTHORIZATION=${options.authorization}`] : []),
    "--env",
    "PROBE_GRPC_PATH=/openshell.v1.OpenShell/GetSandboxConfig",
    "--env",
    `PROBE_GATEWAY_PORT=${String(options.port)}`,
    "--env",
    `PROBE_PAYLOAD_B64=${options.payload.toString("base64")}`,
    "--env",
    `PROBE_CA_PATH=${CONTAINER_PROBE_CA_PATH}`,
    "--env",
    `PROBE_CLIENT_CERT_PATH=${CONTAINER_PROBE_CLIENT_CERT_PATH}`,
    "--env",
    `PROBE_CLIENT_KEY_PATH=${CONTAINER_PROBE_CLIENT_KEY_PATH}`,
    DOCKER_GRPC_PROBE_IMAGE,
    "node",
    "-e",
    script,
  ];
}

function sandboxTokenContainerProbe(options: SandboxTokenContainerProbeOptions): SpawnResult {
  return run(options.dockerBin, buildSandboxTokenContainerProbeDockerArgs(options));
}

function noTokenProbeWasRejected(result: SpawnResult): boolean {
  if (result.status !== 0) return true;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { grpcStatus?: string; httpStatus?: number };
    return parsed.grpcStatus === "16" || parsed.grpcStatus === "7" || parsed.httpStatus !== 200;
  } catch {
    return false;
  }
}

async function stopGateway(gateway: ChildProcess): Promise<void> {
  if (gateway.exitCode !== null) return;
  gateway.kill("SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (gateway.exitCode !== null) return;
    await delay(100);
  }
  gateway.kill("SIGKILL");
}

function requireGatewayBin(skip: SkipFn): string {
  const gatewayBin = resolveGatewayBin();
  if (!gatewayBin) skip("openshell-gateway binary is required");
  return gatewayBin ?? "";
}

function requireDockerBin(skip: SkipFn): string {
  const dockerBin = resolveDockerBin();
  if (!dockerBin) skip("Docker is required for the OpenShell gateway auth source contract");
  return dockerBin ?? "";
}

async function requireDockerDaemon(options: {
  dockerBin: string;
  host: HostCliClient;
  skip: SkipFn;
}): Promise<void> {
  const dockerInfo = await options.host.command(options.dockerBin, ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (dockerInfo.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error([dockerInfo.stdout, dockerInfo.stderr].filter(Boolean).join("\n"));
    }
    options.skip("Docker is required for the OpenShell gateway auth source contract");
  }
}

export function skipUnavailableProbeImage(
  result: SpawnResult,
  skip: SkipFn,
  githubActions = process.env.GITHUB_ACTIONS === "true",
): void {
  if (
    result.status !== 0 &&
    /pull access denied|manifest unknown|no matching manifest|i\/o timeout|TLS handshake timeout|toomanyrequests|network is unreachable/i.test(
      commandOutput(result),
    )
  ) {
    const message = `Docker probe image was unavailable: ${commandOutput(result).slice(0, 500)}`;
    if (githubActions) {
      throw new Error(
        `Docker probe image became unavailable during the live auth-contract runtime probe after the workflow pre-pull step: ${commandOutput(result).slice(0, 500)}`,
      );
    }
    skip(message);
  }
}

function probeDidNotReturnSandboxConfig(result: SpawnResult): boolean {
  if (result.status !== 0) return true;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { grpcStatus?: string; httpStatus?: number };
    return parsed.httpStatus !== 200 || parsed.grpcStatus !== "0";
  } catch {
    return false;
  }
}

function createDockerBindableTempDir(prefix: string): string {
  const root =
    process.env.NEMOCLAW_E2E_DOCKER_BIND_TMP ??
    path.join(os.homedir(), ".cache", "nemoclaw", "e2e-tmp");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return fs.mkdtempSync(path.join(root, prefix));
}

async function runOpenShellGatewayAuthSourceContractScenarioUnchecked(
  { artifacts, cleanup, host, skip }: ScenarioFixtures,
  dependencies: GatewayAuthSourceContractDependencies,
): Promise<void> {
  const gatewayBin = requireGatewayBin(skip);
  const dockerBin = requireDockerBin(skip);

  const version = run(gatewayBin, ["--version"]);
  expect(version.status, commandOutput(version)).toBe(0);
  expect(commandOutput(version)).toContain("0.0.72");

  await requireDockerDaemon({ dockerBin, host, skip });

  const port = await pickPort();
  const stateDir = createDockerBindableTempDir("nemoclaw-openshell-auth-contract-");
  const networkName = `nemoclaw-auth-contract-${process.pid}-${port}`;
  const useHostNetwork = process.platform === "linux";
  cleanup.add("remove OpenShell auth contract temp state", () =>
    fs.rmSync(stateDir, { recursive: true, force: true }),
  );
  cleanup.add("remove OpenShell auth contract Docker network", () => {
    run(dockerBin, ["network", "rm", networkName]);
  });

  const networkCreate = run(dockerBin, ["network", "create", networkName]);
  expect(networkCreate.status, commandOutput(networkCreate)).toBe(0);

  const certBundle = dependencies.ensureDockerDriverGatewayLocalTlsBundle({
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(stateDir, "xdg-config"),
    },
    gatewayBin,
    stateDir,
  });
  const gatewayEnv: Record<string, string> = {
    OPENSHELL_BIND_ADDRESS: "127.0.0.1",
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_DOCKER_NETWORK_NAME: networkName,
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE:
      "ghcr.io/nvidia/openshell/supervisor@sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d",
    OPENSHELL_DRIVERS: "docker",
    OPENSHELL_GRPC_ENDPOINT: `https://127.0.0.1:${port}`,
    OPENSHELL_LOCAL_TLS_DIR: certBundle.localTlsDir,
    OPENSHELL_SERVER_PORT: String(port),
    OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
    OPENSHELL_SSH_GATEWAY_PORT: String(port),
  };
  const launch = dependencies.buildDockerDriverGatewayLaunch({
    env: {
      ...process.env,
      NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0",
      OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
    },
    gatewayBin,
    gatewayEnv,
    hostGlibcVersion: "999.0",
    platform: process.platform,
    requiredGlibcVersions: [],
    stateDir,
  });
  expect(launch.mode).toBe("host");
  expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();

  await artifacts.writeJson("scenario.json", {
    contracts: [
      "NemoClaw-generated OPENSHELL_GATEWAY_CONFIG enables local mTLS and sandbox JWT auth",
      "inherited OPENSHELL_DISABLE_GATEWAY_AUTH is scrubbed before launch",
      "no-token Docker-origin access to user-callable gateway APIs is rejected or unreachable",
      "mTLS-only Docker-origin access without sandbox JWT does not return sandbox config",
      "valid sandbox JWT access from Docker origin to sandbox-allowlisted APIs reaches OpenShell auth",
      "a sandbox JWT minted for one sandbox cannot access another sandbox config",
    ],
    gatewayBin,
    networkName,
    containerProbeNetworkMode: useHostNetwork ? "host" : "bridge",
    port,
    stateDir,
  });

  let gatewayLog = "";
  const gateway = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout?.on("data", (chunk: Buffer) => {
    gatewayLog += chunk.toString("utf-8");
  });
  gateway.stderr?.on("data", (chunk: Buffer) => {
    gatewayLog += chunk.toString("utf-8");
  });
  cleanup.add("stop OpenShell auth contract gateway", () => stopGateway(gateway));

  await waitForGatewayReady({
    gateway,
    logs: () => gatewayLog,
    port,
    stateDir,
  });

  const noToken = noTokenContainerProbe(dockerBin, networkName, port, useHostNetwork);
  await artifacts.writeJson("no-token-container-probe.json", noToken);
  skipUnavailableProbeImage(noToken, skip);
  expect(noTokenProbeWasRejected(noToken), commandOutput(noToken)).toBe(true);

  const configPath = String(launch.env.OPENSHELL_GATEWAY_CONFIG || "");
  expect(configPath).toBe(path.join(stateDir, "openshell-gateway.toml"));
  const sandboxId = "sandbox-auth-contract";
  const mtlsOnlyContainerCall = sandboxTokenContainerProbe({
    dockerBin,
    networkName,
    payload: getSandboxConfigRequest(sandboxId),
    port,
    stateDir,
    useHostNetwork,
  });
  await artifacts.writeJson("mtls-only-container-probe.json", mtlsOnlyContainerCall);
  skipUnavailableProbeImage(mtlsOnlyContainerCall, skip);
  expect(
    probeDidNotReturnSandboxConfig(mtlsOnlyContainerCall),
    commandOutput(mtlsOnlyContainerCall),
  ).toBe(true);

  const sandboxToken = mintSandboxJwt({ configPath, sandboxId });
  const sandboxCall = await callGrpc({
    authorization: `Bearer ${sandboxToken}`,
    path: "/openshell.v1.OpenShell/GetSandboxConfig",
    payload: getSandboxConfigRequest(sandboxId),
    port,
    stateDir,
  });
  await artifacts.writeJson("sandbox-jwt-probe.json", sandboxCall);
  expect(sandboxCall.httpStatus, JSON.stringify(sandboxCall)).toBe(200);
  expect(sandboxCall.grpcStatus, JSON.stringify(sandboxCall)).toBeDefined();
  expect(["7", "16"]).not.toContain(sandboxCall.grpcStatus);

  const sandboxContainerCall = sandboxTokenContainerProbe({
    authorization: `Bearer ${sandboxToken}`,
    dockerBin,
    networkName,
    payload: getSandboxConfigRequest(sandboxId),
    port,
    stateDir,
    useHostNetwork,
  });
  await artifacts.writeJson("sandbox-jwt-container-probe.json", sandboxContainerCall);
  skipUnavailableProbeImage(sandboxContainerCall, skip);
  expect(sandboxContainerCall.status, commandOutput(sandboxContainerCall)).toBe(0);
  const sandboxContainerResult = JSON.parse(sandboxContainerCall.stdout.trim()) as GrpcResult;
  expect(sandboxContainerResult.httpStatus, JSON.stringify(sandboxContainerResult)).toBe(200);
  expect(sandboxContainerResult.grpcStatus, JSON.stringify(sandboxContainerResult)).toBeDefined();
  expect(["7", "16"]).not.toContain(sandboxContainerResult.grpcStatus);

  const crossSandboxContainerCall = sandboxTokenContainerProbe({
    authorization: `Bearer ${sandboxToken}`,
    dockerBin,
    networkName,
    payload: getSandboxConfigRequest("sandbox-auth-contract-other"),
    port,
    stateDir,
    useHostNetwork,
  });
  await artifacts.writeJson("cross-sandbox-jwt-container-probe.json", crossSandboxContainerCall);
  skipUnavailableProbeImage(crossSandboxContainerCall, skip);
  expect(
    probeDidNotReturnSandboxConfig(crossSandboxContainerCall),
    commandOutput(crossSandboxContainerCall),
  ).toBe(true);

  await artifacts.writeText("openshell-gateway.log", gatewayLog);
}

export async function runOpenShellGatewayAuthSourceContractScenario(
  { artifacts, cleanup, host, skip }: ScenarioFixtures,
  dependencies: GatewayAuthSourceContractDependencies,
): Promise<void> {
  await withOpenShellGatewayAuthArtifactSafety(artifacts.rootDir, () =>
    runOpenShellGatewayAuthSourceContractScenarioUnchecked(
      { artifacts, cleanup, host, skip },
      dependencies,
    ),
  );
}
