// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import path from "node:path";

import { isIP } from "node:net";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import type { PreparedOpenClawLegacyImage } from "../build-context-stage";
import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";
import { resolveDockerGpuSandboxCreatePlan } from "../docker-gpu-sandbox-create-plan";
import {
  isSandboxBridgeGatewayReachable,
  verifySandboxBridgeGatewayReachableOrExit,
} from "../gateway-sandbox-reachability";
import {
  BUSYBOX_PROBE_IMAGE,
  dnsProbeName,
  type EnsureProbeImageCachedResult,
  ensureProbeImageCached,
  type ProbeContainerDnsOpts,
  type ProbeExecutionResult,
  probeContainerDns,
} from "../preflight";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";
import type { SandboxGpuCreateConfig } from "../sandbox-gpu-create";
import { detectWslDockerDesktopStatus } from "../wsl-docker-desktop-gpu";

const RETAINED_DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const RETAINED_DNS_PROBE_TIMEOUT_MS = 20_000;
const RETAINED_DOCKER_PULL_TIMEOUT_MS = 60_000;
const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

type DockerRunOptions = Record<string, unknown>;
type DockerRunResult = NonNullable<ReturnType<typeof dockerSpawnSync>>;

export interface RetainedOpenClawDockerRuntime {
  readonly deps: DockerGpuPatchDeps;
  dockerDesktopWsl(): boolean;
  ensureImageCached(image: string): EnsureProbeImageCachedResult;
  reverifyBridgeReachability(port: number): Promise<void>;
}

export interface RetainedOpenClawDockerRuntimeDeps {
  runDocker?: typeof dockerSpawnSync;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Re-resolve route policy from the bound engine before policy materialization. */
export function bindRetainedOpenClawGpuRoute(
  intent: SandboxCreateIntent,
  config: SandboxGpuCreateConfig,
  dockerDriverGateway: boolean,
  runtime: RetainedOpenClawDockerRuntime,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): SandboxCreateIntent {
  const plan = resolveDockerGpuSandboxCreatePlan(config, {
    dockerDriverGateway,
    dockerDesktopWsl: runtime.dockerDesktopWsl(),
    env: options.env,
    platform: options.platform,
  });
  return {
    ...intent,
    gpuRoutePlan: plan.gpuRoutePlan,
    sandboxGpuLogMessage: plan.logMessage,
  };
}

function timeoutFromOptions(options: DockerRunOptions | undefined, fallback: number): number {
  const timeout = options?.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : fallback;
}

function dockerErrorText(result: DockerRunResult): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(
    result.error?.message ?? "",
  )}`.trim();
}

function toProbeExecution(result: DockerRunResult): ProbeExecutionResult {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? null,
    signal: result.signal,
    timedOut: error?.code === "ETIMEDOUT",
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
  };
}

function validateProbeName(value: string): string {
  if (!/^[a-z0-9]([a-z0-9.-]{0,253})$/i.test(value)) {
    throw new Error(
      `probeName must be a plain DNS name (RFC 1035 label characters), got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Bind every Docker operation after destructive OpenClaw rebuild handoff to
 * the exact engine and selector that own the retained image.
 */
export function createRetainedOpenClawDockerRuntime(
  image: PreparedOpenClawLegacyImage,
  injected: RetainedOpenClawDockerRuntimeDeps = {},
): RetainedOpenClawDockerRuntime {
  const runDocker = injected.runDocker ?? dockerSpawnSync;
  let cachedDockerDesktopWsl: boolean | null = null;

  const runBoundDocker = (
    args: readonly string[],
    options: DockerRunOptions = {},
  ): DockerRunResult => {
    if (!image.verifyForCreate()) {
      throw new Error(
        "Retained OpenClaw rebuild Docker engine or image changed before a Docker operation.",
      );
    }
    const spawnOptions: SpawnSyncOptions = {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
      env: image.dockerEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutFromOptions(options, RETAINED_DOCKER_OPERATION_TIMEOUT_MS),
    };
    return runDocker(args, spawnOptions);
  };

  const dockerRun = (args: readonly string[], options: DockerRunOptions = {}): DockerRunResult =>
    runBoundDocker(args, options);

  const dockerCapture = (args: readonly string[], options: DockerRunOptions = {}): string => {
    const result = runBoundDocker(args, options);
    if (result.error == null && result.status === 0) return String(result.stdout ?? "").trim();
    if (options.ignoreError === true) return "";
    throw new Error(dockerErrorText(result) || "Bound Docker command failed.");
  };

  const dockerContainer =
    (command: string) =>
    (containerName: string, options: DockerRunOptions = {}): DockerRunResult =>
      runBoundDocker([command, containerName], options);

  const dockerLogs = (
    containerName: string,
    options: { tail?: number; timeout?: number } = {},
  ): string => {
    const result = runBoundDocker(
      ["logs", "--tail", String(options.tail ?? 30), containerName],
      options,
    );
    return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trim();
  };

  const runBoundProbe = (
    command: readonly string[],
    options: { timeout?: number } = {},
  ): ProbeExecutionResult => {
    if (command[0] !== "docker") {
      throw new Error("Retained OpenClaw Docker probe must invoke Docker directly.");
    }
    return toProbeExecution(
      runBoundDocker(command.slice(1), {
        timeout: options.timeout,
        ignoreError: true,
        suppressOutput: true,
      }),
    );
  };

  const ensureImageCached = (target: string): EnsureProbeImageCachedResult =>
    ensureProbeImageCached(target, {
      inspectProbeImpl: runBoundProbe,
      pullProbeImpl: runBoundProbe,
      pullTimeoutMs: RETAINED_DOCKER_PULL_TIMEOUT_MS,
    });

  const probeDns = (options: ProbeContainerDnsOpts = {}) => {
    const probeName = validateProbeName(options.probeName ?? dnsProbeName());
    const dnsServer = options.dnsServer ?? null;
    if (dnsServer !== null && isIP(dnsServer) === 0) {
      throw new Error(`dnsServer must be an IP address, got: ${JSON.stringify(dnsServer)}`);
    }
    const cached = ensureImageCached(BUSYBOX_PROBE_IMAGE);
    if (!cached.ok) {
      return probeContainerDns({
        ...options,
        probeName,
        ensureImageCachedOverride: cached,
        executionOverride: { exitCode: 1 },
      });
    }
    const dockerArgs = [
      "run",
      "--rm",
      "--pull=missing",
      ...(dnsServer === null ? [] : ["--dns", dnsServer]),
      BUSYBOX_PROBE_IMAGE,
      "nslookup",
      probeName,
    ];
    const execution = toProbeExecution(
      runBoundDocker(dockerArgs, {
        timeout: RETAINED_DNS_PROBE_TIMEOUT_MS,
        ignoreError: true,
        suppressOutput: true,
      }),
    );
    return probeContainerDns({
      ...options,
      probeName,
      command: ["docker", ...dockerArgs],
      ensureImageCachedOverride: { ok: true, alreadyCached: cached.alreadyCached },
      executionOverride: execution,
    });
  };

  const deps: DockerGpuPatchDeps = Object.freeze({
    dockerCapture,
    dockerRun,
    dockerRunDetached: (args, options) => runBoundDocker(["run", "-d", ...args], options),
    dockerRename: (oldName, newName, options) =>
      runBoundDocker(["rename", oldName, newName], options),
    dockerRm: dockerContainer("rm"),
    dockerStart: dockerContainer("start"),
    dockerStop: dockerContainer("stop"),
    dockerLogs,
    probeContainerDns: probeDns,
  });

  return Object.freeze({
    deps,
    dockerDesktopWsl: () => {
      if (cachedDockerDesktopWsl === null) {
        cachedDockerDesktopWsl =
          detectWslDockerDesktopStatus({
            platform: injected.platform,
            env: injected.env,
            dockerInfoFormat: (format, options) =>
              dockerCapture(["info", "--format", format], options),
          }) === "docker-desktop";
      }
      return cachedDockerDesktopWsl;
    },
    ensureImageCached,
    reverifyBridgeReachability: (port: number) =>
      verifySandboxBridgeGatewayReachableOrExit(true, {
        port,
        reachabilityImpl: (selected) =>
          isSandboxBridgeGatewayReachable({
            port: selected?.port ?? port,
            dockerCaptureImpl: dockerCapture,
            dockerRunImpl: dockerRun as typeof import("../../adapters/docker/run").dockerRun,
            ensureImageCachedImpl: ensureImageCached,
          }),
      }),
  });
}
