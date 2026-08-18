// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createPrivateKey, sign as signPayload } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";

const SANDBOX_JWT_SUBJECT_PREFIX = "spiffe://openshell/sandbox/";
export const DOCKER_GRPC_PROBE_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const CONTAINER_PROBE_CA_PATH = "/tmp/nemoclaw-probe-ca.crt";
const CONTAINER_PROBE_CLIENT_CERT_PATH = "/tmp/nemoclaw-probe-client.crt";
const CONTAINER_PROBE_CLIENT_KEY_PATH = "/tmp/nemoclaw-probe-client.key";

export type GatewayAuthProbeResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

export type SandboxTokenContainerProbeOptions = {
  authorization?: string;
  dockerBin: string;
  hostGatewayIp?: string;
  networkName: string;
  payload: Buffer;
  port: number;
  stateDir: string;
  useHostNetwork?: boolean;
};

export type SandboxTokenContainerProbeInvocation = {
  args: string[];
  input: string;
};

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

export function getSandboxConfigRequest(sandboxId: string): Buffer {
  const bytes = Buffer.from(sandboxId, "utf-8");
  return Buffer.concat([Buffer.from([(1 << 3) | 2]), varint(bytes.length), bytes]);
}

function parseTomlString(toml: string, key: string): string {
  const match = toml.match(new RegExp(`^${key} = "([^"]+)"$`, "m"));
  if (!match?.[1]) throw new Error(`missing TOML key ${key}`);
  return match[1];
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export function mintSandboxJwt(options: { configPath: string; sandboxId: string }): string {
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

function containerProbeNetworkArgs(
  networkName: string,
  useHostNetwork: boolean,
  hostGatewayIp = "host-gateway",
): string[] {
  return useHostNetwork
    ? ["--network", "host", "--add-host", "host.openshell.internal:127.0.0.1"]
    : ["--network", networkName, "--add-host", `host.openshell.internal:${hostGatewayIp}`];
}

function sandboxTokenContainerProbeScript(): string {
  return `
const fs = require("node:fs");
const http2 = require("node:http2");

const port = process.env.PROBE_GATEWAY_PORT;
const path = process.env.PROBE_GRPC_PATH;
const authorization = fs.readFileSync(0, "utf8");
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

export function buildSandboxTokenContainerProbeInvocation(
  options: SandboxTokenContainerProbeOptions,
): SandboxTokenContainerProbeInvocation {
  const bundle = getDockerDriverGatewayLocalTlsBundle(options.stateDir);
  return {
    args: [
      "run",
      "--rm",
      "--interactive",
      ...containerProbeNetworkArgs(
        options.networkName,
        options.useHostNetwork ?? false,
        options.hostGatewayIp,
      ),
      "--volume",
      `${path.resolve(bundle.caPath)}:${CONTAINER_PROBE_CA_PATH}:ro`,
      "--volume",
      `${path.resolve(bundle.clientCertPath)}:${CONTAINER_PROBE_CLIENT_CERT_PATH}:ro`,
      "--volume",
      `${path.resolve(bundle.clientKeyPath)}:${CONTAINER_PROBE_CLIENT_KEY_PATH}:ro`,
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
      sandboxTokenContainerProbeScript(),
    ],
    input: options.authorization ?? "",
  };
}

export function runSandboxTokenContainerProbe(
  options: SandboxTokenContainerProbeOptions,
): GatewayAuthProbeResult {
  const invocation = buildSandboxTokenContainerProbeInvocation(options);
  const result = spawnSync(options.dockerBin, invocation.args, {
    encoding: "utf-8",
    env: process.env,
    input: invocation.input,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
