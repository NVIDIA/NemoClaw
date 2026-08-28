// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../dist/lib/onboard/docker-driver-gateway-local-tls";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";

export const EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS = 3 * 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

type OpenShellHealthClient = Readonly<{
  raw: Readonly<{
    health(
      request: Record<string, never>,
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<unknown>;
  }>;
}>;

type OpenShellSdkModule = Readonly<{
  OpenShellClient: Readonly<{
    connect(options: Readonly<{ gateway: string; caCert: Buffer }>): Promise<OpenShellHealthClient>;
  }>;
}>;

type ScenarioFixtures = Readonly<{
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  progress: TestProgress;
  skip: (message?: string) => void;
}>;

function resolveGatewayBin(): string | null {
  for (const candidate of [
    process.env.OPENSHELL_GATEWAY_BIN,
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const result = spawnSync("sh", ["-c", "command -v openshell-gateway"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
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
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function loadSdk(): Promise<OpenShellSdkModule> {
  const packageName: string = "@nvidia/openshell-sdk";
  const loaded = (await import(packageName)) as Partial<OpenShellSdkModule>;
  if (!loaded.OpenShellClient || typeof loaded.OpenShellClient.connect !== "function") {
    throw new Error("the reviewed OpenShell SDK client export is unavailable");
  }
  return loaded as OpenShellSdkModule;
}

async function waitForPublicHealth(options: {
  caCert: Buffer;
  endpoint: string;
  gateway: ChildProcess;
}): Promise<Readonly<{ status: unknown; version: unknown }>> {
  const deadline = Date.now() + 60_000;
  const sdk = await loadSdk();
  const client = await sdk.OpenShellClient.connect({
    gateway: options.endpoint,
    caCert: options.caCert,
  });
  while (Date.now() < deadline) {
    if (options.gateway.exitCode !== null) {
      throw new Error("OpenShell gateway exited before the public health check completed");
    }
    try {
      const result = await client.raw.health(
        {},
        { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
      );
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        const health = result as Record<string, unknown>;
        if (health.version) return { status: health.status, version: health.version };
      }
    } catch {
      // The gateway can refuse connections until its listener is ready.
    }
    await delay(250);
  }
  throw new Error("OpenShell gateway public health did not become available");
}

export async function runExternalGatewayHealthScenario({
  artifacts,
  cleanup,
  progress,
  skip,
}: ScenarioFixtures): Promise<void> {
  const gatewayBin = resolveGatewayBin();
  if (!gatewayBin) skip("openshell-gateway 0.0.106 is required");

  progress.phase("confirm the exact OpenShell gateway and SDK prerequisites");
  const version = spawnSync(gatewayBin!, ["--version"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  expect(version.status, `${version.stdout}\n${version.stderr}`).toBe(0);
  expect(`${version.stdout}\n${version.stderr}`).toContain(OPENSHELL_V0106_QUALIFICATION.version);

  const port = await pickPort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-health-"));
  cleanup.add("remove external gateway health state", () =>
    fs.rmSync(stateDir, { recursive: true, force: true }),
  );
  const tls = ensureDockerDriverGatewayLocalTlsBundle({ gatewayBin: gatewayBin!, stateDir });
  const configPath = path.join(stateDir, "gateway.toml");
  fs.writeFileSync(
    configPath,
    [
      "[openshell]",
      "version = 1",
      "",
      "[openshell.gateway]",
      `bind_address = "127.0.0.1:${String(port)}"`,
      "compute_drivers = []",
      "disable_tls = false",
      "",
      "[openshell.gateway.tls]",
      `cert_path = ${JSON.stringify(tls.serverCertPath)}`,
      `key_path = ${JSON.stringify(tls.serverKeyPath)}`,
      "require_client_auth = false",
      "",
      "[openshell.gateway.auth]",
      "allow_unauthenticated_users = true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  progress.phase("launch a TLS gateway without client-certificate authentication");
  let gatewayOutput = "";
  const gateway = spawnObservedChild(gatewayBin!, [], {
    activityLabel: "command: external-gateway-health",
    progress,
    spawn: {
      env: {
        ...process.env,
        OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
        OPENSHELL_GATEWAY_CONFIG: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  gateway.stdout?.on("data", (chunk: Buffer) => {
    gatewayOutput += chunk.toString("utf8");
  });
  gateway.stderr?.on("data", (chunk: Buffer) => {
    gatewayOutput += chunk.toString("utf8");
  });
  cleanup.add("stop external gateway health gateway", () => stopGateway(gateway));

  try {
    progress.phase("observe public health through the reviewed SDK");
    const health = await waitForPublicHealth({
      caCert: fs.readFileSync(tls.caPath),
      endpoint: `https://127.0.0.1:${String(port)}`,
      gateway,
    });
    expect(health.version).toBe(OPENSHELL_V0106_QUALIFICATION.version);
    expect(health.status).toBe(1);
    await artifacts.writeJson("external-gateway-health.json", {
      expectedRelease: OPENSHELL_V0106_QUALIFICATION.version,
      reportedRelease: health.version,
      status: "healthy",
      transport: "https-explicit-ca",
    });
  } finally {
    await artifacts.writeText("external-gateway.log", gatewayOutput);
  }
}
