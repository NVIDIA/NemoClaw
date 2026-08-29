// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { dockerCapture, dockerRun } from "../adapters/docker/run";
import { resolveSandboxContainerOwner } from "../domain/sandbox/container-owner";
import { resolvePortableDemoPrivilegedExecTarget } from "../onboard/experimental/portable-demo-lifecycle";
import { isImmutableDockerImageId } from "../onboard/openshell-docker-sandbox-containers";
import {
  createFilePersistedEngineLifecycleStore,
  hasActivePersistedEngineStateMutationTarget,
  PERSISTED_ENGINE_LIFECYCLE_DIRECTORY,
} from "../onboard/runtime-provider/persisted-engine-lifecycle";
import { resolveShieldsStateDir, withShieldsTransitionLock } from "../shields/transition-lock";
import * as registry from "../state/registry";
import { compareAndSetLegacySandboxLifecycleGeneration } from "../state/registry/lifecycle-generation";

const OPENSHELL_MANAGED_BY_LABEL = "openshell.ai/managed-by";
const OPENSHELL_MANAGED_BY_VALUE = "openshell";
const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

type SandboxEntry = import("../state/registry").SandboxEntry;

type LabeledSandboxContainer = {
  id: string;
  name: string;
};

const DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS = 5000;
const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const DOCKER_VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const OFFLINE_WECHAT_STATE_PATHS = new Set([
  "/sandbox/.openclaw/wechat",
  "/sandbox/.openclaw/openclaw-weixin",
]);
const OFFLINE_WECHAT_CLEANUP_COMMAND =
  "rm -rf -- /sandbox/.openclaw/wechat /sandbox/.openclaw/openclaw-weixin && " +
  "test ! -e /sandbox/.openclaw/wechat && test ! -e /sandbox/.openclaw/openclaw-weixin";
const OFFLINE_DOCKER_OPERATION_OPTIONS = {
  encoding: "utf-8",
  ignoreError: true,
  suppressOutput: true,
  timeout: 30_000,
} as const;
const SANITIZED_PRIVILEGED_ENV = [
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;
const NEUTRALIZED_OFFLINE_HELPER_ENV = [
  "--env",
  "LD_AUDIT=",
  "--env",
  "LD_LIBRARY_PATH=",
  "--env",
  "LD_PRELOAD=",
  "--env",
  "BASH_ENV=",
  "--env",
  "ENV=",
] as const;

class DirectSandboxFallbackUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectSandboxFallbackUnavailableError";
  }
}

class PinnedSandboxContainerIdentityChangedError extends Error {
  constructor(sandboxName: string) {
    super(
      `OpenShell container identity changed for sandbox '${sandboxName}'; ` +
        "refusing privileged execution against a different container.",
    );
    this.name = "PinnedSandboxContainerIdentityChangedError";
  }
}

function normalizeDriver(driver: unknown): string | null {
  return typeof driver === "string" && driver.trim() ? driver.trim().toLowerCase() : null;
}

function readSandboxEntry(sandboxName: string): SandboxEntry | null {
  return registry.getSandbox?.(sandboxName) ?? null;
}

function registeredSandboxNames(sandboxName: string): string[] {
  const names = new Set<string>([sandboxName]);

  if (registry.listSandboxes) {
    const listed = registry.listSandboxes?.();
    if (Array.isArray(listed?.sandboxes)) {
      for (const entry of listed.sandboxes) {
        if (typeof entry.name === "string" && entry.name) names.add(entry.name);
      }
    }
  } else {
    const loaded = registry.load?.();
    const sandboxes = loaded?.sandboxes;
    if (sandboxes && typeof sandboxes === "object") {
      for (const [key, entry] of Object.entries(sandboxes)) {
        if (key) names.add(key);
        if (typeof entry?.name === "string" && entry.name) names.add(entry.name);
      }
    }
  }

  return Array.from(names).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function containerNameMatchesSandbox(containerName: string, sandboxName: string): boolean {
  return resolveSandboxContainerOwner(containerName, sandboxName, [sandboxName]) === containerName;
}

function owningRegisteredSandboxName(
  containerName: string,
  registeredNames: readonly string[],
): string | null {
  return registeredNames.find((name) => containerNameMatchesSandbox(containerName, name)) ?? null;
}

function parseLabeledSandboxContainers(output: string): LabeledSandboxContainer[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, ...unexpected] = line.split("\t");
      if (!id || !name || unexpected.length > 0 || /\s/.test(id)) {
        throw new Error("Docker returned malformed OpenShell sandbox container metadata.");
      }
      return { id, name };
    });
}

function selectDirectSandboxContainer(
  sandboxName: string,
  labeledContainerRows: string,
  registeredNames: readonly string[] = [sandboxName],
): string | null {
  const names = Array.from(new Set([...registeredNames, sandboxName])).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const candidates = parseLabeledSandboxContainers(labeledContainerRows);
  if (
    candidates.some(
      ({ name }) =>
        !containerNameMatchesSandbox(name, sandboxName) ||
        owningRegisteredSandboxName(name, names) !== sandboxName,
    )
  ) {
    throw new Error(
      `OpenShell container labels and names disagree for sandbox '${sandboxName}'; ` +
        "refusing lifecycle execution.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple running OpenShell containers are labeled for sandbox '${sandboxName}'; ` +
        "refusing ambiguous lifecycle execution.",
    );
  }
  return candidates[0]?.id ?? null;
}

function expectedDirectContainerPattern(sandboxName: string): string {
  return (
    `openshell-${sandboxName}, openshell-${sandboxName}-*, or ` +
    `openshell-default--${sandboxName}-*`
  );
}

function findDirectSandboxContainer(sandboxName: string): string | null {
  const names = registeredSandboxNames(sandboxName);
  let output: string;
  try {
    output = dockerCapture(
      [
        "ps",
        "--no-trunc",
        "--filter",
        `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
        "--filter",
        `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      { timeout: DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DirectSandboxFallbackUnavailableError(
      `Direct sandbox container discovery failed for '${sandboxName}': ${detail}`,
      { cause: error },
    );
  }
  return selectDirectSandboxContainer(sandboxName, output, names);
}

/** Select one label-owned container across all states and reject GPU rollback siblings. */
function findStoppedDirectSandboxContainer(sandboxName: string): string | null {
  const names = registeredSandboxNames(sandboxName);
  const output = dockerCapture(
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    { timeout: DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS },
  );
  const candidates = parseLabeledSandboxContainers(output);
  const selected = selectDirectSandboxContainer(sandboxName, output, names);
  if (/-nemoclaw-gpu-backup-\d+$/u.test(candidates[0]?.name ?? "")) return null;
  return selected;
}

type InspectedStoppedContainer = {
  readonly id: string;
  readonly image: string;
  readonly running: boolean;
  readonly sandboxVolumeName: string | null;
};

/** Read immutable image, lifecycle, and shared-state mount data for one container ID. */
function inspectStoppedContainer(containerId: string): InspectedStoppedContainer | null {
  const result = dockerRun(
    [
      "inspect",
      "--format",
      "{{.Id}}\t{{.Image}}\t{{.State.Running}}\t{{json .Mounts}}",
      containerId,
    ],
    OFFLINE_DOCKER_OPERATION_OPTIONS,
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const [id, image, running, mountsJson, ...unexpected] = result.stdout.trim().split("\t");
  if (
    unexpected.length > 0 ||
    !id ||
    !FULL_CONTAINER_ID_RE.test(id) ||
    !image ||
    !isImmutableDockerImageId(image) ||
    !mountsJson ||
    (running !== "true" && running !== "false")
  ) {
    return null;
  }
  let mounts: unknown;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(mounts)) return null;
  const sandboxMounts = mounts.filter(
    (mount) =>
      typeof mount === "object" &&
      mount !== null &&
      (mount as Record<string, unknown>).Destination === "/sandbox",
  ) as Array<Record<string, unknown>>;
  const sandboxMount = sandboxMounts.length === 1 ? sandboxMounts[0] : undefined;
  const sandboxVolumeName =
    sandboxMount?.Type === "volume" &&
    sandboxMount.RW === true &&
    typeof sandboxMount.Name === "string" &&
    DOCKER_VOLUME_NAME_RE.test(sandboxMount.Name)
      ? sandboxMount.Name
      : null;
  return { id, image, running: running === "true", sandboxVolumeName };
}

/** Clear OpenClaw WeChat state without starting a failed Docker sandbox. */
function clearStoppedDockerSandboxChannelState(
  sandboxName: string,
  paths: readonly string[],
): boolean {
  const entry = readSandboxEntry(sandboxName);
  if (normalizeDriver(entry?.openshellDriver) !== "docker") return false;
  if (
    paths.length !== OFFLINE_WECHAT_STATE_PATHS.size ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !OFFLINE_WECHAT_STATE_PATHS.has(path))
  ) {
    return false;
  }

  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, "offline WeChat state cleanup", () => {
      const containerId = findStoppedDirectSandboxContainer(sandboxName);
      if (!containerId) return false;
      const inspected = inspectStoppedContainer(containerId);
      if (
        !inspected ||
        inspected.running ||
        inspected.id !== containerId ||
        !inspected.sandboxVolumeName
      ) {
        return false;
      }
      const cleared = dockerRun(
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--user",
          "0:0",
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "DAC_OVERRIDE",
          "--pids-limit",
          "64",
          ...NEUTRALIZED_OFFLINE_HELPER_ENV,
          "--mount",
          `type=volume,src=${inspected.sandboxVolumeName},dst=/sandbox,volume-nocopy`,
          "--entrypoint",
          "/usr/bin/env",
          inspected.image,
          "-i",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "/bin/sh",
          "-c",
          OFFLINE_WECHAT_CLEANUP_COMMAND,
        ],
        OFFLINE_DOCKER_OPERATION_OPTIONS,
      );
      if (cleared.status !== 0) return false;
      const confirmed = inspectStoppedContainer(containerId);
      return (
        confirmed?.id === inspected.id &&
        confirmed.sandboxVolumeName === inspected.sandboxVolumeName &&
        !confirmed.running
      );
    });
  } catch {
    return false;
  }
}

function missingDirectContainerError(sandboxName: string, driver: string | null): Error {
  const driverLabel = driver ?? "unspecified";
  return new DirectSandboxFallbackUnavailableError(
    `No running direct OpenShell sandbox container found for '${sandboxName}' ` +
      `(driver: ${driverLabel}). Expected one OpenShell-managed container labeled ` +
      `'${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}' and named ` +
      `${expectedDirectContainerPattern(sandboxName)}. Is the sandbox running?`,
  );
}

function isDirectSandboxFallbackUnavailableError(
  error: unknown,
): error is DirectSandboxFallbackUnavailableError {
  return error instanceof DirectSandboxFallbackUnavailableError;
}

function isPinnedSandboxContainerIdentityChangedError(
  error: unknown,
): error is PinnedSandboxContainerIdentityChangedError {
  return error instanceof PinnedSandboxContainerIdentityChangedError;
}

function missingRegistryEntryError(sandboxName: string): Error {
  return new Error(
    `No NemoClaw registry entry found for '${sandboxName}'; ` +
      "refusing privileged exec without a registered sandbox owner.",
  );
}

function unsupportedDirectDriverError(sandboxName: string, driver: string): Error {
  return new Error(
    `Privileged direct-container control is unavailable for sandbox '${sandboxName}' ` +
      `(driver: ${driver}); refusing local Docker discovery for a non-direct driver.`,
  );
}

function assertNoActiveStateMutationTarget(sandboxName: string): void {
  const stateDir = resolveShieldsStateDir();
  const lifecycleDirectory = path.join(stateDir, PERSISTED_ENGINE_LIFECYCLE_DIRECTORY);
  try {
    fs.lstatSync(lifecycleDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lifecycleStore = createFilePersistedEngineLifecycleStore(stateDir);
  if (hasActivePersistedEngineStateMutationTarget(lifecycleStore, sandboxName)) {
    throw new Error(
      `Runtime provider state mutation owns direct-container execution for sandbox '${sandboxName}'; retry after the provider fence is released.`,
    );
  }
}

/**
 * Serialize one ordinary direct-container execution against provider fence
 * acquisition. The callback must include both argv resolution and the complete
 * synchronous Docker subprocess lifetime. Taking the lock before checking the
 * durable target claim closes the check/acquire/exec race: an older exec drains
 * before the provider can publish its fence, while a later exec observes the
 * claim and is rejected before it can spawn.
 */
function withPrivilegedSandboxExecutionLease<T>(
  sandboxName: string,
  operation: string,
  fn: () => T,
): T {
  return withShieldsTransitionLock(
    sandboxName,
    `privileged direct-container execution: ${operation}`,
    () => {
      assertNoActiveStateMutationTarget(sandboxName);
      return fn();
    },
  );
}

function resolveDirectSandboxContainer(sandboxName: string, driver: string | null): string {
  const selected = findDirectSandboxContainer(sandboxName);
  if (selected) return selected;
  throw missingDirectContainerError(sandboxName, driver);
}

function privilegedSandboxExecArgv(
  sandboxName: string,
  cmd: string[],
  stdin = false,
  sanitizeEnvironment = false,
  expectedContainerId?: string,
): string[] {
  const entry = readSandboxEntry(sandboxName);
  if (!entry) throw missingRegistryEntryError(sandboxName);
  const driver = normalizeDriver(entry.openshellDriver);
  if (driver !== null && driver !== "docker" && driver !== "vm") {
    throw unsupportedDirectDriverError(sandboxName, driver);
  }
  assertNoActiveStateMutationTarget(sandboxName);
  const portableTarget =
    driver === "docker"
      ? resolvePortableDemoPrivilegedExecTarget(sandboxName, {
          ...(entry.lifecycleGeneration ? { registryGeneration: entry.lifecycleGeneration } : {}),
          backfillRegistryGeneration: (generation) =>
            compareAndSetLegacySandboxLifecycleGeneration(entry, generation),
        })
      : null;
  if (portableTarget) {
    if (expectedContainerId !== undefined && portableTarget.containerId !== expectedContainerId) {
      throw new PinnedSandboxContainerIdentityChangedError(sandboxName);
    }
    const sanitizedEnvArgs = sanitizeEnvironment
      ? SANITIZED_PRIVILEGED_ENV.flatMap((value) => ["--env", value])
      : [];
    portableTarget.assertRuntimeAuthority();
    return [
      "--host",
      portableTarget.dockerHost,
      "exec",
      ...(stdin ? ["-i"] : []),
      ...sanitizedEnvArgs,
      "--user",
      "0",
      portableTarget.containerId,
      ...cmd,
    ];
  }
  // Docker/direct-container is the only supported privileged mutation path.
  // Try it even when older registry entries do not record a driver, then fail
  // clearly if no matching sandbox container is running.
  const container = findDirectSandboxContainer(sandboxName);
  if (container) {
    if (expectedContainerId !== undefined && container !== expectedContainerId) {
      throw new PinnedSandboxContainerIdentityChangedError(sandboxName);
    }
    const sanitizedEnvArgs = sanitizeEnvironment
      ? SANITIZED_PRIVILEGED_ENV.flatMap((value) => ["--env", value])
      : [];
    return [
      "exec",
      ...(stdin ? ["-i"] : []),
      ...sanitizedEnvArgs,
      "--user",
      "root",
      container,
      ...cmd,
    ];
  }

  throw missingDirectContainerError(sandboxName, driver);
}

export {
  clearStoppedDockerSandboxChannelState,
  containerNameMatchesSandbox,
  isDirectSandboxFallbackUnavailableError,
  isPinnedSandboxContainerIdentityChangedError,
  privilegedSandboxExecArgv,
  resolveDirectSandboxContainer,
  selectDirectSandboxContainer,
  withPrivilegedSandboxExecutionLease,
};
