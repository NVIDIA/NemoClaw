// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { getDockerDriverGatewayLocalTlsBundle } from "../../../dist/lib/onboard/docker-driver-gateway-local-tls";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  externalGatewayHealthProcessStopped,
  stopExternalGatewayHealthGateway,
} from "../fixtures/external-gateway-health-process.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { runBoundedRetry } from "../fixtures/retry-policy.ts";
import {
  type ShellProbe,
  type ShellProbeResult,
  trustedShellCommand,
} from "../fixtures/shell-probe.ts";

export const EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS = 3 * 60_000;
const BLUEPRINT_RUNNER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dist",
  "lib",
  "blueprint-runner.js",
);
type ScenarioFixtures = Readonly<{
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  progress: TestProgress;
  shellProbe: ShellProbe;
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

function pickPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a TCP port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function externalHostAddress(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("a non-loopback IPv4 address is required for external gateway health");
}

function parseRunnerStatus(output: string): Record<string, unknown> {
  const jsonStart = output.indexOf("{");
  if (jsonStart < 0) throw new Error("Blueprint Runner status did not produce JSON");
  const parsed: unknown = JSON.parse(output.slice(jsonStart));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Blueprint Runner status did not produce a JSON mapping");
  }
  return parsed as Record<string, unknown>;
}

type PortObservation = Readonly<{ errorCode?: string; ready: boolean }>;

function observeGatewayPort(host: string, port: number): Promise<PortObservation> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ready: true });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({ errorCode: error.code ?? "unknown", ready: false });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ errorCode: "timeout", ready: false });
    });
  });
}

async function waitForGatewayPort(options: {
  address: string;
  artifacts: ArtifactSink;
  gateway: ChildProcess;
  port: number;
}): Promise<void> {
  const execution = await runBoundedRetry({
    operation: "external-gateway-health.tcp-readiness",
    owner: "openshell-gateway",
    idempotence: "read-only",
    maxAttempts: 10,
    delayMs: 1_000,
    onEvidence: async (evidence) => {
      await options.artifacts.writeJson("external-gateway-readiness-retry.json", evidence);
    },
    run: () =>
      !externalGatewayHealthProcessStopped(options.gateway)
        ? observeGatewayPort(options.address, options.port)
        : Promise.resolve({ errorCode: "gateway-exited", ready: false }),
    classify: (value, error) => {
      if (error !== undefined || !value) {
        return { outcome: "failed", failureClass: "deterministic" };
      }
      if (value.ready) return { outcome: "passed" };
      return {
        outcome: "failed",
        failureClass: value.errorCode === "ECONNREFUSED" ? "transient-external" : "deterministic",
      };
    },
  });
  if (execution.outcome !== "passed") {
    throw new Error("OpenShell gateway did not open its configured listener");
  }
}

function requireProbeSuccess(result: ShellProbeResult, operation: string): void {
  if (!result.timedOut && result.signal === null && result.exitCode === 0) return;
  throw new Error(`${operation} failed. See the redacted E2E artifacts.`);
}

export async function runPackagedBlueprintRunnerStatus(
  shellProbe: ShellProbe,
  prepared: PreparedExternalGatewayHealthScenario,
): Promise<Record<string, unknown>> {
  const { blueprintRoot, privateStateRoot } = prepared;
  const result = await shellProbe.run(
    trustedShellCommand({
      command: process.execPath,
      args: [BLUEPRINT_RUNNER, "status", "--external-target"],
      reason: "observe public OpenShell health through the packaged Blueprint Runner",
    }),
    {
      artifactName: "external-gateway-blueprint-runner-health",
      captureLimitBytes: 64 * 1024,
      env: { NEMOCLAW_BLUEPRINT_PATH: blueprintRoot },
      redactionValues: [privateStateRoot],
      timeoutMs: 10_000,
    },
  );
  requireProbeSuccess(result, "Blueprint Runner public health observation");
  return parseRunnerStatus(result.stdout);
}

export type PreparedExternalGatewayHealthScenario = Readonly<{
  authenticationPath: string;
  blueprintRoot: string;
  expectedRelease: string;
  privateStateRoot: string;
}>;

export async function startPreparedExternalTlsGateway({
  artifacts,
  cleanup,
  progress,
  shellProbe,
  skip,
}: ScenarioFixtures): Promise<PreparedExternalGatewayHealthScenario> {
  const gatewayBin = resolveGatewayBin();
  if (!gatewayBin) skip("openshell-gateway 0.0.106 is required");

  progress.phase("confirm the exact OpenShell gateway and SDK prerequisites");
  const version = await shellProbe.run(
    trustedShellCommand({
      command: gatewayBin!,
      args: ["--version"],
      reason: "confirm the local OpenShell gateway release",
    }),
    {
      artifactName: "external-gateway-version",
      captureLimitBytes: 16 * 1024,
      redactionValues: [gatewayBin!],
      timeoutMs: 5_000,
    },
  );
  requireProbeSuccess(version, "OpenShell gateway version check");
  if (!`${version.stdout}\n${version.stderr}`.includes(OPENSHELL_V0106_QUALIFICATION.version)) {
    throw new Error("The OpenShell gateway release does not match the required release.");
  }

  const address = externalHostAddress();
  const port = await pickPort(address);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-health-"));
  artifacts.addRedactionValues([stateDir]);
  cleanup.add("remove external gateway health state", () =>
    fs.rmSync(stateDir, { recursive: true, force: true }),
  );
  const tls = getDockerDriverGatewayLocalTlsBundle(stateDir);
  const certificate = await shellProbe.run(
    trustedShellCommand({
      command: gatewayBin!,
      args: ["generate-certs", "--output-dir", tls.localTlsDir, "--server-san", address],
      reason: "create the temporary TLS identity for the local OpenShell gateway",
    }),
    {
      artifactName: "external-gateway-generate-certs",
      captureLimitBytes: 16 * 1024,
      redactionValues: [gatewayBin!, stateDir],
      timeoutMs: 15_000,
    },
  );
  requireProbeSuccess(certificate, "OpenShell gateway certificate generation");
  const configPath = path.join(stateDir, "gateway.toml");
  fs.writeFileSync(
    configPath,
    [
      "[openshell]",
      "version = 1",
      "",
      "[openshell.gateway]",
      `bind_address = "${address}:${String(port)}"`,
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
    activityLabel: "command: start-external-gateway-health",
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
  cleanup.add("write external gateway health log", async () => {
    await artifacts.writeText("external-gateway.log", gatewayOutput);
  });
  cleanup.add("stop external gateway health gateway", () =>
    stopExternalGatewayHealthGateway(gateway),
  );

  const blueprintRoot = path.join(stateDir, "blueprint");
  const authenticationPath = path.join(stateDir, "authentication");
  fs.mkdirSync(blueprintRoot);
  fs.writeFileSync(
    path.join(blueprintRoot, "blueprint.yaml"),
    YAML.stringify({
      version: "1.0.0",
      min_openshell_version: OPENSHELL_V0106_QUALIFICATION.version,
      max_openshell_version: OPENSHELL_V0106_QUALIFICATION.version,
      openshell_target: {
        endpoint: `https://${address}:${String(port)}`,
        workspace: "default",
        expected_release: OPENSHELL_V0106_QUALIFICATION.version,
        lifecycle: "external",
        trust: { ca_file: tls.caPath },
        authentication: { credential_file: authenticationPath },
      },
    }),
    { mode: 0o600 },
  );

  await waitForGatewayPort({ address, artifacts, gateway, port });
  return {
    authenticationPath,
    blueprintRoot,
    expectedRelease: OPENSHELL_V0106_QUALIFICATION.version,
    privateStateRoot: stateDir,
  };
}
