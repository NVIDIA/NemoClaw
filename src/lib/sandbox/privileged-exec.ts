// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dockerCapture, dockerRun } from "../adapters/docker/run";
import { resolveSandboxContainerOwner } from "../domain/sandbox/container-owner";
import { resolvePortableDemoPrivilegedExecTarget } from "../onboard/experimental/portable-demo-lifecycle";
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

export type StoppedDockerSandboxChannelStateCleanupFailure =
  | "sandbox-registry-unavailable"
  | "driver-not-docker"
  | "state-paths-invalid"
  | "docker-discovery-failed"
  | "no-eligible-stopped-container"
  | "container-ownership-invalid"
  | "container-inspection-failed"
  | "container-not-stopped"
  | "sandbox-volume-unavailable"
  | "cleanup-helper-image-unavailable"
  | "cleanup-helper-ownership-invalid"
  | "cleanup-helper-reconciliation-failed"
  | "cleanup-state-tree-unsafe"
  | "cleanup-deletion-unconfirmed"
  | "cleanup-helper-failed"
  | "container-revalidation-failed"
  | "lifecycle-authority-unavailable";

export type StoppedDockerSandboxChannelStateCleanupResult =
  | { readonly cleared: true }
  | {
      readonly cleared: false;
      readonly failure: StoppedDockerSandboxChannelStateCleanupFailure;
      readonly cleanupHelperName?: string;
    };

const DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS = 5000;
const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const DOCKER_VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const STOPPED_CHANNEL_STATE_PATH_RE = /^\/sandbox\/\.(?:openclaw|hermes)\/[A-Za-z0-9_-]+$/u;
const STOPPED_CHANNEL_CLEANUP_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const STOPPED_CHANNEL_CLEANUP_LABEL = "com.nvidia.nemoclaw.channel-cleanup";
const STOPPED_CHANNEL_CLEANUP_OWNER_LABEL = `${STOPPED_CHANNEL_CLEANUP_LABEL}.owner`;
const STOPPED_CHANNEL_CLEANUP_VOLUME_LABEL = `${STOPPED_CHANNEL_CLEANUP_LABEL}.volume`;
export function buildStoppedDockerSandboxChannelCleanupScript(root = "/sandbox"): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const targets = JSON.parse(process.argv[1]);
function lstat(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) { if (error && error.code === "ENOENT") return null; throw error; }
}
const rootMetadata = lstat(root);
if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) process.exit(40);
for (const target of targets) {
  if (typeof target !== "string" || !target.startsWith(root + "/.")) process.exit(41);
  const relative = path.posix.relative(root, target);
  const segments = relative.split("/");
  if (!relative || relative.startsWith("../") || segments.some((part) => !part || part === "." || part === "..")) process.exit(42);
  let parent = root;
  let absent = false;
  for (const segment of segments.slice(0, -1)) {
    parent = path.posix.join(parent, segment);
    const metadata = lstat(parent);
    if (!metadata) { absent = true; break; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) process.exit(43);
  }
  if (absent) continue;
  const metadata = lstat(target);
  if (!metadata) continue;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) process.exit(44);
  fs.rmSync(target, { force: false, maxRetries: 0, recursive: true });
  if (lstat(target)) process.exit(45);
}
`;
}
const STOPPED_CHANNEL_CLEANUP_SCRIPT = buildStoppedDockerSandboxChannelCleanupScript();
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
  let output: string;
  try {
    output = dockerCapture(
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
  } catch (error) {
    throw new DirectSandboxFallbackUnavailableError(
      `Stopped Docker sandbox discovery failed for '${sandboxName}'.`,
      { cause: error },
    );
  }
  const candidates = parseLabeledSandboxContainers(output);
  const selected = selectDirectSandboxContainer(sandboxName, output, names);
  if (/-nemoclaw-gpu-backup-\d+$/u.test(candidates[0]?.name ?? "")) return null;
  return selected;
}

type InspectedStoppedContainer = {
  readonly id: string;
  readonly running: boolean;
  readonly sandboxVolumeName: string;
};

type StoppedContainerInspection =
  | { readonly inspected: InspectedStoppedContainer }
  | { readonly failure: StoppedDockerSandboxChannelStateCleanupFailure };

/** Read immutable lifecycle and shared-state mount data for one container ID. */
function inspectStoppedContainer(containerId: string): StoppedContainerInspection {
  let result: ReturnType<typeof dockerRun>;
  try {
    result = dockerRun(
      ["inspect", "--format", "{{.Id}}\t{{.State.Running}}\t{{json .Mounts}}", containerId],
      OFFLINE_DOCKER_OPERATION_OPTIONS,
    );
  } catch {
    return { failure: "container-inspection-failed" };
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { failure: "container-inspection-failed" };
  }
  const [id, running, mountsJson, ...unexpected] = result.stdout.trim().split("\t");
  if (
    unexpected.length > 0 ||
    !id ||
    !FULL_CONTAINER_ID_RE.test(id) ||
    !mountsJson ||
    (running !== "true" && running !== "false")
  ) {
    return { failure: "container-ownership-invalid" };
  }
  let mounts: unknown;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return { failure: "sandbox-volume-unavailable" };
  }
  if (!Array.isArray(mounts)) return { failure: "sandbox-volume-unavailable" };
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
  return sandboxVolumeName
    ? { inspected: { id, running: running === "true", sandboxVolumeName } }
    : { failure: "sandbox-volume-unavailable" };
}

function stoppedDockerCleanupFailure(
  failure: StoppedDockerSandboxChannelStateCleanupFailure,
  cleanupHelperName?: string,
): StoppedDockerSandboxChannelStateCleanupResult {
  return cleanupHelperName
    ? { cleared: false, failure, cleanupHelperName }
    : { cleared: false, failure };
}

function stoppedDockerCleanupPaths(paths: readonly string[]): readonly string[] | null {
  if (
    paths.length === 0 ||
    paths.length > 4 ||
    new Set(paths).size !== paths.length ||
    paths.some((statePath) => !STOPPED_CHANNEL_STATE_PATH_RE.test(statePath))
  ) {
    return null;
  }
  return [...paths];
}

function cleanupIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanupHelperName(sandboxName: string): string {
  return `nemoclaw-channel-cleanup-${cleanupIdentity(sandboxName).slice(0, 24)}`;
}

function dockerResultText(result: ReturnType<typeof dockerRun>): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(result.error?.message ?? "")}`;
}

function dockerReportsMissingContainer(result: ReturnType<typeof dockerRun>): boolean {
  return result.status !== 0 && /No such (?:container|object)/iu.test(dockerResultText(result));
}

type CleanupHelperInspection =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "owned"; readonly id: string };

function inspectCleanupHelper(
  helperName: string,
  ownerIdentity: string,
  volumeIdentity: string,
): CleanupHelperInspection {
  let result: ReturnType<typeof dockerRun>;
  try {
    result = dockerRun(
      [
        "inspect",
        "--format",
        `{{.Id}}\t{{.Config.Image}}\t{{index .Config.Labels "${STOPPED_CHANNEL_CLEANUP_LABEL}"}}\t{{index .Config.Labels "${STOPPED_CHANNEL_CLEANUP_OWNER_LABEL}"}}\t{{index .Config.Labels "${STOPPED_CHANNEL_CLEANUP_VOLUME_LABEL}"}}`,
        helperName,
      ],
      OFFLINE_DOCKER_OPERATION_OPTIONS,
    );
  } catch {
    return { state: "invalid" };
  }
  if (dockerReportsMissingContainer(result)) return { state: "absent" };
  if (result.status !== 0 || typeof result.stdout !== "string") return { state: "invalid" };
  const [id, image, marker, owner, volume, ...unexpected] = result.stdout.trim().split("\t");
  return unexpected.length === 0 &&
    !!id &&
    FULL_CONTAINER_ID_RE.test(id) &&
    image === STOPPED_CHANNEL_CLEANUP_IMAGE &&
    marker === "1" &&
    owner === ownerIdentity &&
    volume === volumeIdentity
    ? { state: "owned", id }
    : { state: "invalid" };
}

function removeAndConfirmCleanupHelper(containerId: string): boolean {
  let removed: ReturnType<typeof dockerRun>;
  let confirmation: ReturnType<typeof dockerRun>;
  try {
    removed = dockerRun(["rm", "-f", containerId], OFFLINE_DOCKER_OPERATION_OPTIONS);
    if (removed.status !== 0) return false;
    confirmation = dockerRun(["inspect", containerId], OFFLINE_DOCKER_OPERATION_OPTIONS);
  } catch {
    return false;
  }
  return dockerReportsMissingContainer(confirmation);
}

function pinnedCleanupImageIsAvailable(): boolean {
  try {
    const result = dockerRun(
      ["image", "inspect", "--format", "{{.Id}}", STOPPED_CHANNEL_CLEANUP_IMAGE],
      OFFLINE_DOCKER_OPERATION_OPTIONS,
    );
    return result.status === 0 && /^sha256:[a-f0-9]{64}\s*$/u.test(String(result.stdout ?? ""));
  } catch {
    return false;
  }
}

function reconcileCleanupHelperAfterCreate(
  helperName: string,
  ownerIdentity: string,
  volumeIdentity: string,
): boolean {
  const helper = inspectCleanupHelper(helperName, ownerIdentity, volumeIdentity);
  return (
    helper.state === "absent" ||
    (helper.state === "owned" && removeAndConfirmCleanupHelper(helper.id))
  );
}

function classifyCleanupHelperFailure(
  result: ReturnType<typeof dockerRun> | null,
): StoppedDockerSandboxChannelStateCleanupFailure {
  if (result?.status === 45) return "cleanup-deletion-unconfirmed";
  if (typeof result?.status === "number" && result.status >= 40 && result.status <= 44) {
    return "cleanup-state-tree-unsafe";
  }
  return "cleanup-helper-failed";
}

/** Clear validated channel state without starting a failed Docker sandbox. */
function clearStoppedDockerSandboxChannelState(
  sandboxName: string,
  paths: readonly string[],
): StoppedDockerSandboxChannelStateCleanupResult {
  const cleanupPaths = stoppedDockerCleanupPaths(paths);
  if (!cleanupPaths) return stoppedDockerCleanupFailure("state-paths-invalid");
  const entry = readSandboxEntry(sandboxName);
  if (!entry) return stoppedDockerCleanupFailure("sandbox-registry-unavailable");
  if (normalizeDriver(entry?.openshellDriver) !== "docker") {
    return stoppedDockerCleanupFailure("driver-not-docker");
  }

  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, "offline channel state cleanup", () => {
      let containerId: string | null;
      try {
        containerId = findStoppedDirectSandboxContainer(sandboxName);
      } catch (error) {
        return stoppedDockerCleanupFailure(
          isDirectSandboxFallbackUnavailableError(error)
            ? "docker-discovery-failed"
            : "container-ownership-invalid",
        );
      }
      if (!containerId) return stoppedDockerCleanupFailure("no-eligible-stopped-container");
      const inspection = inspectStoppedContainer(containerId);
      if ("failure" in inspection) return stoppedDockerCleanupFailure(inspection.failure);
      const { inspected } = inspection;
      if (inspected.id !== containerId) {
        return stoppedDockerCleanupFailure("container-ownership-invalid");
      }
      if (inspected.running) return stoppedDockerCleanupFailure("container-not-stopped");
      if (!pinnedCleanupImageIsAvailable()) {
        return stoppedDockerCleanupFailure("cleanup-helper-image-unavailable");
      }
      const helperName = cleanupHelperName(sandboxName);
      const ownerIdentity = cleanupIdentity(sandboxName);
      const volumeIdentity = cleanupIdentity(inspected.sandboxVolumeName);
      const existingHelper = inspectCleanupHelper(helperName, ownerIdentity, volumeIdentity);
      if (existingHelper.state === "invalid") {
        return stoppedDockerCleanupFailure("cleanup-helper-ownership-invalid", helperName);
      }
      if (existingHelper.state === "owned" && !removeAndConfirmCleanupHelper(existingHelper.id)) {
        return stoppedDockerCleanupFailure("cleanup-helper-reconciliation-failed", helperName);
      }
      let created: ReturnType<typeof dockerRun>;
      try {
        created = dockerRun(
          [
            "create",
            "--name",
            helperName,
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
            "--label",
            `${STOPPED_CHANNEL_CLEANUP_LABEL}=1`,
            "--label",
            `${STOPPED_CHANNEL_CLEANUP_OWNER_LABEL}=${ownerIdentity}`,
            "--label",
            `${STOPPED_CHANNEL_CLEANUP_VOLUME_LABEL}=${volumeIdentity}`,
            "--mount",
            `type=volume,src=${inspected.sandboxVolumeName},dst=/sandbox,volume-nocopy`,
            "--entrypoint",
            "/usr/local/bin/node",
            STOPPED_CHANNEL_CLEANUP_IMAGE,
            "-e",
            STOPPED_CHANNEL_CLEANUP_SCRIPT,
            JSON.stringify(cleanupPaths),
          ],
          OFFLINE_DOCKER_OPERATION_OPTIONS,
        );
      } catch {
        return reconcileCleanupHelperAfterCreate(helperName, ownerIdentity, volumeIdentity)
          ? stoppedDockerCleanupFailure("cleanup-helper-failed")
          : stoppedDockerCleanupFailure("cleanup-helper-reconciliation-failed", helperName);
      }
      const helperId = String(created.stdout ?? "").trim();
      if (created.status !== 0 || !FULL_CONTAINER_ID_RE.test(helperId)) {
        return reconcileCleanupHelperAfterCreate(helperName, ownerIdentity, volumeIdentity)
          ? stoppedDockerCleanupFailure("cleanup-helper-failed")
          : stoppedDockerCleanupFailure("cleanup-helper-reconciliation-failed", helperName);
      }
      let cleared: ReturnType<typeof dockerRun> | null = null;
      try {
        cleared = dockerRun(["start", "--attach", helperId], OFFLINE_DOCKER_OPERATION_OPTIONS);
      } catch {
        cleared = null;
      }
      if (!removeAndConfirmCleanupHelper(helperId)) {
        return stoppedDockerCleanupFailure("cleanup-helper-reconciliation-failed", helperName);
      }
      if (!cleared || cleared.status !== 0 || cleared.error) {
        return stoppedDockerCleanupFailure(classifyCleanupHelperFailure(cleared));
      }
      const confirmation = inspectStoppedContainer(containerId);
      if ("failure" in confirmation) {
        return stoppedDockerCleanupFailure("container-revalidation-failed");
      }
      const { inspected: confirmed } = confirmation;
      return confirmed.id === inspected.id &&
        confirmed.sandboxVolumeName === inspected.sandboxVolumeName &&
        !confirmed.running
        ? { cleared: true }
        : stoppedDockerCleanupFailure("container-revalidation-failed");
    });
  } catch {
    return stoppedDockerCleanupFailure("lifecycle-authority-unavailable");
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
