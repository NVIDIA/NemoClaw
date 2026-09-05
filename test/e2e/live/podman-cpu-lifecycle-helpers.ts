// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ContainerEngine } from "../../../src/lib/adapters/container-engine";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../../src/lib/onboard/runtime-provider/podman-lifecycle";
import { redactFull } from "../../../src/lib/security/redact";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import {
  type ShellProbe,
  type ShellProbeResult,
  trustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { stripAnsi } from "./json-envelope.ts";
import {
  type PodmanContainerArtifactSummary,
  sanitizePodmanInspectArtifact,
} from "./podman-cpu-lifecycle-artifacts.ts";

export const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? "";
export const GATEWAY_NAME = "podman-proof";
export const OPENSHELL_VERSION = OPENSHELL_V0106_QUALIFICATION.version;
export const SOCKET_PATH = process.env.E2E_PODMAN_SOCKET ?? "";

const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const MAX_GATEWAY_DIAGNOSTIC_CHARS = 32 * 1024;

function gatewayDiagnostic(output: string): string {
  return redactFull(stripAnsi(output)).slice(-MAX_GATEWAY_DIAGNOSTIC_CHARS);
}

interface ManagedContainerInspect {
  Config: {
    Cmd: string[];
    Entrypoint: string | string[];
    Labels: Record<string, string>;
  };
  Id: string;
  Name: string;
  State: { Paused: boolean; Running: boolean; Status: string };
}

interface CommandOptions {
  allowFailure?: boolean;
  artifactName: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: 1_000 | 10_000 | 60_000 | 240_000;
}

interface GatewayInfo {
  compute_drivers: Array<{ name: string }>;
  status: string;
  version: string;
}

interface CleanupOptions {
  cliEnv: NodeJS.ProcessEnv;
  completed: boolean;
  createdSandboxes: readonly string[];
  engine: ContainerEngine;
  gateway: ChildProcess | null;
  openshellBin: string;
  previousPortableProfile: string | undefined;
  root: string;
  shellProbe: ShellProbe;
}

export function executableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the exact installed component.
    }
  }
  throw new Error(`Required executable '${name}' was not found on PATH.`);
}

export async function runCommand(
  shellProbe: ShellProbe,
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  let result: ShellProbeResult;
  try {
    result = await shellProbe.run(
      trustedShellCommand({
        command,
        args,
        reason: "exercise the pinned OpenShell Podman CPU lifecycle",
      }),
      {
        artifactName: options.artifactName,
        env: options.env ?? buildAvailabilityProbeEnv(),
        timeoutMs: options.timeoutMs ?? 60_000,
      },
    );
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
  if (
    !options.allowFailure &&
    (result.timedOut || result.signal !== null || result.exitCode !== 0)
  ) {
    throw new Error(
      `${path.basename(command)} command failed (exit ${String(result.exitCode)}, ` +
        `signal ${String(result.signal)}, timed out ${String(result.timedOut)}). ` +
        `See ${result.artifacts.result}.`,
    );
  }
  return result.stdout.trim();
}

export async function startPinnedGateway(
  gatewayBin: string,
  gatewayEnv: Record<string, string>,
  progress: TestProgress,
  artifactDir = ARTIFACT_DIR,
): Promise<ChildProcess> {
  const child = spawnObservedChild(gatewayBin, [], {
    activityLabel: "command: pinned OpenShell 0.0.106 Podman gateway",
    progress,
    spawn: {
      env: { ...process.env, ...gatewayEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  const recordOutput = (chunk: unknown) => {
    output = `${output}${String(chunk)}`.slice(-MAX_GATEWAY_DIAGNOSTIC_CHARS * 2);
    if (!artifactDir) return;
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(artifactDir, "openshell-podman-gateway.log"),
      gatewayDiagnostic(output),
      { encoding: "utf-8", mode: 0o600 },
    );
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(output);
    if (/configuration error|invalid \[openshell[.]drivers[.]podman\] table/iu.test(plainOutput)) {
      await stopGateway(child);
      throw new Error(
        `Pinned OpenShell rejected the Podman configuration:\n${gatewayDiagnostic(output)}`,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await stopGateway(child);
      throw new Error(
        `Pinned OpenShell Podman gateway exited with ${String(child.exitCode)} ` +
          `(signal ${String(child.signalCode)}):\n${gatewayDiagnostic(output)}`,
      );
    }
    // This confirms that the pinned configuration was accepted. OpenShell logs
    // it before Podman initialization and listener binding, so the caller must
    // still poll a real authenticated gateway request before creating sandboxes.
    if (/Using compute driver\s+driver=podman/u.test(plainOutput)) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopGateway(child);
  throw new Error(
    `Pinned OpenShell Podman gateway did not initialize:\n${gatewayDiagnostic(output)}`,
  );
}

export async function waitForHealthyGateway(
  shellProbe: ShellProbe,
  openshellBin: string,
  cliEnv: NodeJS.ProcessEnv,
  child: ChildProcess,
): Promise<GatewayInfo> {
  const deadline = Date.now() + 120_000;
  let lastFailure = "gateway info was not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Pinned OpenShell Podman gateway exited before its authenticated endpoint became healthy ` +
          `(exit ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
      );
    }
    try {
      const info = JSON.parse(
        await runCommand(
          shellProbe,
          openshellBin,
          ["gateway", "info", "-g", GATEWAY_NAME, "-o", "json"],
          {
            artifactName: "podman-lifecycle-gateway-info",
            env: cliEnv,
            timeoutMs: 10_000,
          },
        ),
      ) as GatewayInfo;
      const hasPodman = info.compute_drivers?.some((driver) => driver.name === "podman") ?? false;
      if (info.status === "healthy" && info.version === OPENSHELL_VERSION && hasPodman) {
        return info;
      }
      lastFailure = `status=${String(info.status)}, version=${String(info.version)}, podman=${String(
        hasPodman,
      )}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Pinned OpenShell Podman gateway did not become healthy within 120 seconds: ${lastFailure}`,
  );
}

export function exactContainerId(engine: ContainerEngine, sandboxName: string): string {
  const result = engine.capture([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=${PODMAN_MANAGED_LABEL}=true`,
    "--filter",
    `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
    "--filter",
    `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
  ]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const rows = result.stdout
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(FULL_CONTAINER_ID);
  return rows[0]!;
}

export function inspectContainer(
  engine: ContainerEngine,
  sandboxName: string,
  expectedId?: string,
): ManagedContainerInspect {
  const containerId = exactContainerId(engine, sandboxName);
  if (expectedId) expect(containerId).toBe(expectedId);
  const result = engine.capture(["container", "inspect", containerId]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const entries = JSON.parse(result.stdout) as ManagedContainerInspect[];
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  const labels = entry.Config.Labels;
  const sandboxId = labels[PODMAN_SANDBOX_ID_LABEL];
  expect(entry.Id).toBe(containerId);
  expect(entry.Id).toMatch(FULL_CONTAINER_ID);
  expect(sandboxId).toBeTruthy();
  expect(entry.Name).toBe(`${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`);
  expect(labels).toMatchObject({
    [PODMAN_MANAGED_LABEL]: "true",
    [PODMAN_SANDBOX_NAME_LABEL]: sandboxName,
    [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
    [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
  });
  expect(entry.Config.Cmd).toEqual(["--workdir", "/sandbox"]);
  const entrypoint = Array.isArray(entry.Config.Entrypoint)
    ? entry.Config.Entrypoint
    : [entry.Config.Entrypoint];
  expect(entrypoint).toEqual(["/opt/openshell/bin/openshell-sandbox"]);
  return entry;
}

export function captureFailureContainerDiagnostics(
  engine: ContainerEngine,
  sandboxNames: readonly string[],
  artifactDir = ARTIFACT_DIR,
): void {
  if (!artifactDir) return;
  const diagnosticDir = path.join(artifactDir, "failure-containers");
  fs.mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
  const containers: PodmanContainerArtifactSummary[] = [];
  for (const sandboxName of sandboxNames) {
    const discovery = engine.capture([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=${PODMAN_MANAGED_LABEL}=true`,
      "--filter",
      `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--filter",
      `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
    ]);
    if (discovery.status !== 0 || discovery.error) continue;
    const containerIds = discovery.stdout
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .filter((row) => FULL_CONTAINER_ID.test(row));
    for (const containerId of containerIds) {
      const result = engine.capture(["container", "inspect", containerId], 30_000);
      if (result.status !== 0 || result.error) continue;
      try {
        containers.push(sanitizePodmanInspectArtifact(result.stdout));
      } catch {
        // Diagnostics are best effort and raw inspection must never be persisted.
      }
    }
  }
  fs.writeFileSync(
    path.join(diagnosticDir, "managed-container-summary.json"),
    `${JSON.stringify({ schemaVersion: 1, containers }, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

function gatewayStopped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForGatewayStop(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (gatewayStopped(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(stopped);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(gatewayStopped(child)), timeoutMs);
    child.once("close", onClose);
    if (gatewayStopped(child)) finish(true);
  });
}

async function stopGateway(child: ChildProcess | null): Promise<void> {
  if (!child || gatewayStopped(child)) return;
  child.kill("SIGTERM");
  if (await waitForGatewayStop(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForGatewayStop(child, 5_000))) {
    throw new Error("Pinned OpenShell Podman gateway did not stop after SIGKILL.");
  }
}

export async function cleanupPodmanLifecycle(options: CleanupOptions): Promise<void> {
  if (!options.completed) {
    try {
      captureFailureContainerDiagnostics(options.engine, options.createdSandboxes);
    } catch {
      // Diagnostics are best effort; lifecycle cleanup must still run.
    }
  }
  for (const sandboxName of [...options.createdSandboxes].reverse()) {
    await runCommand(
      options.shellProbe,
      options.openshellBin,
      ["sandbox", "delete", "-g", GATEWAY_NAME, sandboxName],
      {
        allowFailure: true,
        artifactName: `podman-lifecycle-delete-${sandboxName}`,
        env: options.cliEnv,
      },
    );
  }
  try {
    await stopGateway(options.gateway);
  } finally {
    if (options.previousPortableProfile === undefined) {
      delete process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;
    } else {
      process.env.NEMOCLAW_EXPERIMENTAL_PROFILE = options.previousPortableProfile;
    }
    fs.rmSync(options.root, { force: true, recursive: true });
  }
}
