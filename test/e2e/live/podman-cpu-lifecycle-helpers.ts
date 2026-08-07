// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import { once } from "node:events";
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
import { expect } from "../fixtures/e2e-test.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { stripAnsi } from "./json-envelope.ts";

export const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? "";
export const GATEWAY_NAME = "podman-proof";
export const OPENSHELL_VERSION = "0.0.99";
export const SOCKET_PATH = process.env.E2E_PODMAN_SOCKET ?? "";

const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/u;

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
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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

function appendCommandLog(command: string, args: readonly string[], output: string): void {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    path.join(ARTIFACT_DIR, "openshell-podman-commands.log"),
    `$ ${path.basename(command)} ${args.join(" ")}\n${output}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    env: options.env ?? process.env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout:
      options.timeoutMs === 240_000 ? 240_000 : options.timeoutMs === 10_000 ? 10_000 : 60_000,
  });
  const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
  appendCommandLog(command, args, output);
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed (exit ${String(result.status)}):\n${
        result.error?.message ?? output
      }`,
    );
  }
  return String(result.stdout ?? "").trim();
}

export async function startPinnedGateway(
  gatewayBin: string,
  gatewayEnv: Record<string, string>,
  progress: TestProgress,
): Promise<ChildProcess> {
  const child = spawnObservedChild(gatewayBin, [], {
    activityLabel: "command: pinned OpenShell 0.0.99 Podman gateway",
    progress,
    spawn: {
      env: { ...process.env, ...gatewayEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  const recordOutput = (chunk: unknown) => {
    const text = String(chunk);
    output += text;
    if (!ARTIFACT_DIR) return;
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(ARTIFACT_DIR, "openshell-podman-gateway.log"), text, {
      encoding: "utf-8",
      mode: 0o600,
    });
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(output);
    if (/configuration error|invalid \[openshell[.]drivers[.]podman\] table/iu.test(plainOutput)) {
      child.kill("SIGTERM");
      throw new Error(`Pinned OpenShell rejected the Podman configuration:\n${output}`);
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Pinned OpenShell Podman gateway exited with ${String(child.exitCode)}:\n${output}`,
      );
    }
    // This confirms that the pinned configuration was accepted. OpenShell logs
    // it before Podman initialization and listener binding, so the caller must
    // still poll a real authenticated gateway request before creating sandboxes.
    if (/Using compute driver\s+driver=podman/u.test(plainOutput)) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Pinned OpenShell Podman gateway did not initialize:\n${output}`);
}

export async function waitForHealthyGateway(
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
        runCommand(openshellBin, ["gateway", "info", "-g", GATEWAY_NAME, "-o", "json"], {
          env: cliEnv,
          timeoutMs: 10_000,
        }),
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
  expectedAgent: string,
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
    "nemoclaw.agent": expectedAgent,
  });
  expect(entry.Config.Cmd).toEqual(["--workdir", "/sandbox"]);
  const entrypoint = Array.isArray(entry.Config.Entrypoint)
    ? entry.Config.Entrypoint
    : [entry.Config.Entrypoint];
  expect(entrypoint).toEqual(["/opt/openshell/bin/openshell-sandbox"]);
  return entry;
}

function captureFailureContainerDiagnostics(
  engine: ContainerEngine,
  sandboxNames: readonly string[],
): void {
  if (!ARTIFACT_DIR) return;
  const diagnosticDir = path.join(ARTIFACT_DIR, "failure-containers");
  fs.mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
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
    const containerIds = discovery.stdout
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .filter((row) => FULL_CONTAINER_ID.test(row));
    for (const containerId of containerIds) {
      for (const [suffix, args] of [
        ["inspect.json", ["container", "inspect", containerId]],
        ["log", ["logs", containerId]],
      ] as const) {
        const result = engine.capture(args, 30_000);
        fs.writeFileSync(
          path.join(diagnosticDir, `${sandboxName}-${containerId}-${suffix}`),
          `${result.stdout}${result.stderr}`,
          { encoding: "utf-8", mode: 0o600 },
        );
      }
    }
  }
}

async function stopGateway(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
    runCommand(options.openshellBin, ["sandbox", "delete", "-g", GATEWAY_NAME, sandboxName], {
      allowFailure: true,
      env: options.cliEnv,
    });
  }
  await stopGateway(options.gateway);
  if (options.previousPortableProfile === undefined) {
    delete process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;
  } else {
    process.env.NEMOCLAW_EXPERIMENTAL_PROFILE = options.previousPortableProfile;
  }
  fs.rmSync(options.root, { force: true, recursive: true });
}
