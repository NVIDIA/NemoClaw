// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { buildDockerDriverGatewayLaunch as buildDockerDriverGatewayLaunchSource } from "../../../src/lib/onboard/docker-driver-gateway-launch";
import type { ensureDockerDriverGatewayLocalTlsBundle as ensureDockerDriverGatewayLocalTlsBundleSource } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import {
  assertOpenShellGatewayAuthArtifactsSafe,
  enforceOpenShellGatewayAuthArtifactSafety,
} from "../../../tools/e2e/openshell-gateway-auth-artifact-safety.mts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  exactGatewayRelease,
  OPENSHELL_V013_QUALIFICATION,
} from "../fixtures/openshell-v0116-qualification.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import {
  DOCKER_GRPC_PROBE_IMAGE,
  getSandboxConfigRequest,
  runSandboxTokenContainerProbe,
} from "./openshell-gateway-auth-probe.ts";
import { verifyOpenShellTlsServerNameSourceBoundary } from "./openshell-v0116-tls-server-name-source.ts";

export { buildSandboxTokenContainerProbeInvocation } from "./openshell-gateway-auth-probe.ts";

// Only reads the launch bundle produced inside this test's private state directory.
// A handwritten legacy JWT cannot establish a persisted sandbox session.
export function createGatewayAuthSandbox(options: {
  cleanup: Pick<CleanupRegistry, "add">;
  configPath: string;
  port: number;
  stateDir: string;
}): { name: string; token: string } {
  const { cleanup, configPath, port, stateDir } = options;
  const env = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: path.join(stateDir, "client-config"),
    XDG_STATE_HOME: path.join(stateDir, "runtime-state"),
    XDG_DATA_HOME: path.join(stateDir, "client-data"),
    OPENSHELL_GATEWAY: "auth-contract",
    OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
    OPENSHELL_COLOR: "never",
  };
  const cli = (args: string[]): string => {
    const result = spawnSync("openshell", args, {
      env,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    // Keep stdout private; redact stderr before exposing bounded failure diagnostics.
    expect(
      result.status,
      `OpenShell auth fixture ${args[0]} ${args[1]} failed (${result.status}): ${redactString(result.stderr ?? result.error?.message ?? "").slice(0, 4096)}`,
    ).toBe(0);
    return result.stdout;
  };
  cli(["gateway", "add", `https://127.0.0.1:${port}`, "--local", "--name", "auth-contract"]);
  const name = "auth-contract";
  const policyPath = path.join(stateDir, "sandbox-policy.yaml");
  fs.writeFileSync(
    policyPath,
    `version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /bin, /lib, /lib64, /etc, /proc, /dev/urandom]
  read_write: [/tmp, /dev/null]
landlock:
  compatibility: best_effort
process:
  run_as_user: "65532"
  run_as_group: "65532"
network_policies: {}
`,
    { mode: 0o600 },
  );
  // Registered before creation so a partial create is reconciled before gateway teardown.
  cleanup.add("delete OpenShell auth contract sandbox", () => {
    cli(["sandbox", "delete", name]);
  });
  const created = JSON.parse(
    cli([
      "sandbox",
      "create",
      "--name",
      name,
      "--from",
      DOCKER_GRPC_PROBE_IMAGE,
      "--policy",
      policyPath,
      "--no-auto-providers",
      "--detach",
      "--no-tty",
      "-o",
      "json",
      "--",
      "/bin/sh",
      "-c",
      "sleep 600",
    ]),
  ) as { id?: string; name?: string; phase?: string };
  expect(created.id).toMatch(/^[a-f0-9-]{36}$/u);
  const namespace = fs
    .readFileSync(configPath, "utf8")
    .match(/^sandbox_label = "([a-zA-Z0-9_.-]+)"$/mu)?.[1];
  if (!namespace) throw new Error("OpenShell auth fixture sandbox namespace is missing");
  const bundlePath = path.join(
    env.XDG_STATE_HOME,
    "openshell",
    "docker-sandbox-tokens",
    namespace,
    created.id!,
    "supervisor-auth.json",
  );
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as { gateway_token?: string };
  expect(typeof bundle.gateway_token === "string" && bundle.gateway_token.length > 0).toBe(true);
  return { name, token: bundle.gateway_token! };
}

type SkipFn = (message?: string) => void;

type ScenarioFixtures = {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  host: HostCliClient;
  progress: TestProgress;
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

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    killSignal: "SIGKILL",
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

export { assertOpenShellGatewayAuthArtifactsSafe };

export async function withOpenShellGatewayAuthArtifactSafety<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    enforceOpenShellGatewayAuthArtifactSafety(rootDir);
  }
}

export function registerSandboxJwtArtifactRedaction(
  artifacts: ArtifactSink,
  sandboxToken: string,
): void {
  artifacts.addRedactionValues([sandboxToken]);
}

function resolveGatewayBin(): string | null {
  for (const candidate of [
    process.env.OPENSHELL_GATEWAY_BIN,
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/opt/homebrew/bin/openshell-gateway",
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
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
  port: number;
  stateDir: string;
}): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (options.gateway.exitCode !== null) {
      throw new Error(
        "openshell-gateway exited before readiness; output is available in the redacted gateway artifact",
      );
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
  throw new Error(
    "openshell-gateway did not become ready; output is available in the redacted gateway artifact",
  );
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
  { artifacts, cleanup, host, progress, skip }: ScenarioFixtures,
  dependencies: GatewayAuthSourceContractDependencies,
): Promise<void> {
  const gatewayBin = requireGatewayBin(skip);
  const dockerBin = requireDockerBin(skip);

  const version = run(gatewayBin, ["--version"]);
  expect(version.status, commandOutput(version)).toBe(0);
  expect(exactGatewayRelease(commandOutput(version))).toBe(OPENSHELL_V013_QUALIFICATION.version);

  await requireDockerDaemon({ dockerBin, host, skip });

  progress.phase("verify the exact OpenShell TLS server-name source boundary");
  const sourceBoundary = await verifyOpenShellTlsServerNameSourceBoundary();
  await artifacts.writeJson("tls-server-name-source-boundary.json", sourceBoundary);

  progress.phase("launch the mTLS and JWT-protected gateway");
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
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: OPENSHELL_V013_QUALIFICATION.supervisorImage,
    OPENSHELL_DRIVERS: "docker",
    OPENSHELL_GRPC_ENDPOINT: `https://127.0.0.1:${port}`,
    OPENSHELL_LOCAL_TLS_DIR: certBundle.localTlsDir,
    OPENSHELL_SERVER_PORT: String(port),
    OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
    OPENSHELL_SSH_GATEWAY_PORT: String(port),
    XDG_STATE_HOME: path.join(stateDir, "runtime-state"),
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

  await artifacts.writeJson("scenario.json", {
    contracts: [
      "NemoClaw-generated OPENSHELL_GATEWAY_CONFIG enables local mTLS and sandbox JWT auth",
      "inherited OPENSHELL_DISABLE_GATEWAY_AUTH is scrubbed before launch",
      "no-token Docker-origin access to user-callable gateway APIs is rejected or unreachable",
      "mTLS-only access without a sandbox identity or workspace scope does not return config",
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
  try {
    progress.event("OpenShell auth contract gateway started");
  } catch {
    // Progress diagnostics must never change gateway launch.
  }
  const gateway = spawnObservedChild(launch.command, launch.args, {
    activityLabel: "command: openshell-auth-contract-gateway",
    progress,
    spawn: {
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  gateway.stdout?.on("data", (chunk: Buffer) => {
    gatewayLog += chunk.toString("utf-8");
  });
  gateway.stderr?.on("data", (chunk: Buffer) => {
    gatewayLog += chunk.toString("utf-8");
  });
  gateway.once("close", () => {
    try {
      progress.event("OpenShell auth contract gateway stopped");
    } catch {
      // Progress diagnostics must never change gateway cleanup.
    }
  });
  cleanup.add("stop OpenShell auth contract gateway", () => stopGateway(gateway));

  try {
    await waitForGatewayReady({
      gateway,
      port,
      stateDir,
    });

    progress.phase("probe unauthenticated and mTLS-only access");
    const noToken = noTokenContainerProbe(dockerBin, networkName, port, useHostNetwork);
    await artifacts.writeJson("no-token-container-probe.json", noToken);
    skipUnavailableProbeImage(noToken, skip);
    expect(noTokenProbeWasRejected(noToken), commandOutput(noToken)).toBe(true);

    const configPath = String(launch.env.OPENSHELL_GATEWAY_CONFIG || "");
    const { name: sandboxId, token: sandboxToken } = createGatewayAuthSandbox({
      cleanup,
      configPath,
      port,
      stateDir,
    });
    registerSandboxJwtArtifactRedaction(artifacts, sandboxToken);
    const mtlsOnlyContainerCall = runSandboxTokenContainerProbe({
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

    progress.phase("probe sandbox JWT authorization boundaries");
    const sandboxCall = await callGrpc({
      authorization: `Bearer ${sandboxToken}`,
      path: "/openshell.v1.OpenShell/GetSandboxConfig",
      payload: getSandboxConfigRequest(sandboxId),
      port,
      stateDir,
    });
    await artifacts.writeJson("sandbox-jwt-probe.json", sandboxCall);
    expect(sandboxCall.httpStatus, JSON.stringify(sandboxCall)).toBe(200);
    expect(sandboxCall.grpcStatus, JSON.stringify(sandboxCall)).toBe("0");

    const sandboxContainerCall = runSandboxTokenContainerProbe({
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
    expect(sandboxContainerResult.grpcStatus, JSON.stringify(sandboxContainerResult)).toBe("0");

    const crossSandboxContainerCall = runSandboxTokenContainerProbe({
      authorization: `Bearer ${sandboxToken}`,
      dockerBin,
      networkName,
      payload: getSandboxConfigRequest("auth-other"),
      port,
      stateDir,
      useHostNetwork,
    });
    await artifacts.writeJson("cross-sandbox-jwt-container-probe.json", crossSandboxContainerCall);
    skipUnavailableProbeImage(crossSandboxContainerCall, skip);
    expect(crossSandboxContainerCall.status, commandOutput(crossSandboxContainerCall)).toBe(0);
    const crossSandboxResult = JSON.parse(crossSandboxContainerCall.stdout.trim()) as GrpcResult;
    expect(crossSandboxResult.httpStatus, JSON.stringify(crossSandboxResult)).toBe(200);
    expect(crossSandboxResult.grpcStatus, JSON.stringify(crossSandboxResult)).toBe("7");
  } finally {
    await artifacts.writeText("openshell-gateway.log", gatewayLog);
  }
}

export async function runOpenShellGatewayAuthSourceContractScenario(
  { artifacts, cleanup, host, progress, skip }: ScenarioFixtures,
  dependencies: GatewayAuthSourceContractDependencies,
): Promise<void> {
  await withOpenShellGatewayAuthArtifactSafety(artifacts.rootDir, () =>
    runOpenShellGatewayAuthSourceContractScenarioUnchecked(
      { artifacts, cleanup, host, progress, skip },
      dependencies,
    ),
  );
}
