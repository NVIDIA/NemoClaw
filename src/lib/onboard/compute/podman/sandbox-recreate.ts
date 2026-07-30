// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NAME_VALID_PATTERN } from "../../../name-validation";
import type { PodmanGpuAttachment } from "./gpu-attachment";
import {
  buildPodmanManagedSandboxCreatePlan,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  type PodmanManagedSandboxCreatePlan,
  type PodmanManagedSandboxInspect,
  type PodmanUlimit,
  parsePodmanManagedSandboxInspect,
  podmanImageMountSources,
  podmanWatcherInvisibleBackupLabels,
} from "./sandbox-recreate-spec";
import { assertPodmanSocketAuthority, type PodmanSocketAuthority } from "./socket-authority";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_CONTAINER_NAME_LENGTH = 253;
const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/u;
const FULL_IMAGE_ID = /^(?:sha256:)?[0-9a-f]{64}$/iu;

export interface PodmanCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
}

export type RunQualifiedPodmanCommand = (
  command: "podman",
  args: readonly string[],
  options: SpawnSyncOptions,
) => PodmanCommandResult;

export interface PodmanManagedSandboxRecreateDeps {
  readonly assertSocketAuthority?: (expected: PodmanSocketAuthority) => void;
  readonly now?: () => Date;
  readonly run?: RunQualifiedPodmanCommand;
  readonly socketAuthority?: PodmanSocketAuthority;
}

export interface PodmanManagedSandboxRecreateTransaction {
  readonly applied: true;
  readonly backupContainerId: string;
  readonly backupContainerName: string;
  readonly backupSemanticDigest: string;
  readonly command: readonly string[];
  readonly containerCommand?: readonly string[];
  readonly containerEntrypoint?: readonly string[];
  readonly driverName: "podman";
  readonly immutableImage: string;
  readonly gpuAttachment?: PodmanGpuAttachment | null;
  readonly originalGpuAttachment?: PodmanGpuAttachment | null;
  readonly newContainerId: string;
  readonly oldContainerId: string;
  readonly originalLabels: Readonly<Record<string, string>>;
  readonly originalName: string;
  readonly originalSemanticDigest: string;
  readonly requiredUlimits: readonly PodmanUlimit[];
  readonly sandboxName: string;
  readonly semanticDigest: string;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly socketPath: string;
  readonly transactionIdentity?: string;
}

export interface PodmanManagedSandboxRollbackOutcome {
  readonly originalRecreated: boolean;
  readonly originalStarted: boolean;
  readonly replacementRemoved: boolean;
  readonly rolledBack: boolean;
}

export interface PodmanManagedSandboxFinalizeOutcome {
  readonly backupRemoved: boolean;
  readonly rolledBack: boolean;
}

export class PodmanManagedSandboxRecreateError extends Error {
  readonly rolledBack: boolean | null;

  constructor(message: string, rolledBack: boolean | null = null) {
    super(message);
    this.name = "PodmanManagedSandboxRecreateError";
    this.rolledBack = rolledBack;
  }
}

const WATCHER_LEASE = Symbol("podman-openshell-watcher-stopped");
const WATCHER_CONTROLLER = Symbol("podman-openshell-watcher-controller");

export interface PodmanOpenShellWatcherStoppedLease {
  readonly [WATCHER_LEASE]: true;
  assertStillStopped(): void;
  resumeAndProve(): void;
}

export interface PodmanOpenShellWatcherController {
  readonly [WATCHER_CONTROLLER]: true;
  quiesceAndProve(): PodmanOpenShellWatcherStoppedLease;
}

/**
 * Build the only supported watcher-stop lease.
 *
 * The integration owns exact gateway process/service identity. It must stop
 * that process, return durable stop evidence, prove the same watcher remains
 * absent on every assertion, and restart the same gateway before release.
 * `stopAndProve` must restore the watcher itself before throwing because no
 * receipt is then available to this layer; `resumeAndProve` must idempotently
 * ensure that exact watcher is healthy rather than blindly launch a duplicate.
 * The recreator additionally proves that the pinned rootless Podman API stays
 * reachable while the lease is held.
 */
export function createPodmanOpenShellWatcherController<TReceipt>(deps: {
  readonly assertStopped: (receipt: TReceipt) => void;
  readonly resumeAndProve: (receipt: TReceipt) => void;
  readonly stopAndProve: () => TReceipt;
}): PodmanOpenShellWatcherController {
  return {
    [WATCHER_CONTROLLER]: true,
    quiesceAndProve(): PodmanOpenShellWatcherStoppedLease {
      const receipt = deps.stopAndProve();
      try {
        deps.assertStopped(receipt);
      } catch (error) {
        let recoveryError: unknown = null;
        try {
          deps.resumeAndProve(receipt);
        } catch (caught) {
          recoveryError = caught;
        }
        const message = error instanceof Error ? error.message : String(error);
        const recoveryMessage =
          recoveryError === null
            ? "The watcher was resumed."
            : `Watcher recovery also failed: ${
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
              }.`;
        throw new PodmanManagedSandboxRecreateError(
          `OpenShell watcher stop proof failed: ${message}. ${recoveryMessage}`,
          recoveryError === null,
        );
      }
      let active = true;
      return {
        [WATCHER_LEASE]: true,
        assertStillStopped(): void {
          if (!active) {
            throw new PodmanManagedSandboxRecreateError(
              "OpenShell watcher-stop lease has already been released.",
            );
          }
          deps.assertStopped(receipt);
        },
        resumeAndProve(): void {
          if (!active) {
            throw new PodmanManagedSandboxRecreateError(
              "OpenShell watcher-stop lease has already been released.",
            );
          }
          deps.assertStopped(receipt);
          deps.resumeAndProve(receipt);
          active = false;
        },
      };
    },
  };
}

function requireWatcherLease(value: unknown): PodmanOpenShellWatcherStoppedLease {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<PodmanOpenShellWatcherStoppedLease>)[WATCHER_LEASE] !== true
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox cutover requires a proven OpenShell watcher-stop lease.",
    );
  }
  return value as PodmanOpenShellWatcherStoppedLease;
}

function requireWatcherController(value: unknown): PodmanOpenShellWatcherController {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<PodmanOpenShellWatcherController>)[WATCHER_CONTROLLER] !== true ||
    typeof (value as Partial<PodmanOpenShellWatcherController>).quiesceAndProve !== "function"
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox cutover requires an OpenShell watcher controller.",
    );
  }
  return value as PodmanOpenShellWatcherController;
}

function defaultRun(
  command: "podman",
  args: readonly string[],
  options: SpawnSyncOptions,
): PodmanCommandResult {
  return spawnSync(command, [...args], options);
}

function commandDeps(deps: PodmanManagedSandboxRecreateDeps): {
  readonly now: () => Date;
  readonly run: RunQualifiedPodmanCommand;
} {
  return {
    now: deps.now ?? (() => new Date()),
    run: deps.run ?? defaultRun,
  };
}

function output(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf-8") : "";
}

function detail(result: PodmanCommandResult, sensitiveValues: readonly string[] = []): string {
  let message = [result.error?.message, output(result.stderr), output(result.stdout)]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" | ")
    .replace(/\s+/gu, " ")
    .trim();
  const redactions = new Set<string>();
  for (const entry of sensitiveValues) {
    redactions.add(entry);
    const separator = entry.indexOf("=");
    const value = separator >= 0 ? entry.slice(separator + 1) : entry;
    if (value.length >= 4) redactions.add(value);
  }
  for (const value of [...redactions].sort((left, right) => right.length - left.length)) {
    message = message.split(value).join("[REDACTED]");
  }
  return message.slice(-400);
}

function socketUrl(socketPath: string): string {
  const normalized = socketPath.trim();
  if (!path.isAbsolute(normalized) || /[\0\r\n]/u.test(normalized)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox recreation requires a safe absolute socket path.",
    );
  }
  return `unix://${normalized}`;
}

function runPodman(
  socketPath: string,
  args: readonly string[],
  deps: PodmanManagedSandboxRecreateDeps,
  options: { readonly input?: string } = {},
): PodmanCommandResult {
  try {
    if (deps.socketAuthority) {
      if (deps.socketAuthority.socketPath !== socketPath) {
        throw new PodmanManagedSandboxRecreateError(
          "Podman socket authority does not match the requested managed-sandbox socket.",
        );
      }
      (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(deps.socketAuthority);
    }
    return commandDeps(deps).run("podman", ["--url", socketUrl(socketPath), ...args], {
      encoding: "utf-8",
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      status: null,
    };
  }
}

function bindSocketAuthority(
  socketPath: string,
  socketAuthority: PodmanSocketAuthority,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxRecreateDeps {
  if (socketAuthority.socketPath !== socketPath) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman socket authority does not match the requested managed-sandbox socket.",
    );
  }
  try {
    (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(socketAuthority);
  } catch (error) {
    throw new PodmanManagedSandboxRecreateError(
      `Podman socket authority could not be revalidated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { ...deps, socketAuthority };
}

function requireZero(result: PodmanCommandResult, action: string): void {
  if (result.status === 0) return;
  const suffix = detail(result);
  throw new PodmanManagedSandboxRecreateError(
    `${action} failed with non-zero or unavailable Podman status${suffix ? `: ${suffix}` : "."}`,
  );
}

function podmanRuntimeFingerprint(
  socketPath: string,
  deps: PodmanManagedSandboxRecreateDeps,
): string {
  const result = runPodman(socketPath, ["info", "--format", "json"], deps);
  requireZero(result, "Podman API health proof during OpenShell watcher cutover");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output(result.stdout));
  } catch {
    throw new PodmanManagedSandboxRecreateError(
      "Podman API health proof returned unreadable JSON.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman API health proof did not return an object.",
    );
  }
  const root = parsed as Record<string, unknown>;
  const hostValue = root.host ?? root.Host;
  const storeValue = root.store ?? root.Store;
  const host =
    typeof hostValue === "object" && hostValue !== null && !Array.isArray(hostValue)
      ? (hostValue as Record<string, unknown>)
      : null;
  const securityValue = host?.security ?? host?.Security;
  const security =
    typeof securityValue === "object" && securityValue !== null && !Array.isArray(securityValue)
      ? (securityValue as Record<string, unknown>)
      : null;
  const store =
    typeof storeValue === "object" && storeValue !== null && !Array.isArray(storeValue)
      ? (storeValue as Record<string, unknown>)
      : null;
  const rootless = security?.rootless ?? security?.Rootless;
  const graphRoot = store?.graphRoot ?? store?.GraphRoot;
  const runRoot = store?.runRoot ?? store?.RunRoot;
  if (
    rootless !== true ||
    typeof graphRoot !== "string" ||
    !path.isAbsolute(graphRoot) ||
    typeof runRoot !== "string" ||
    !path.isAbsolute(runRoot)
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "OpenShell watcher cutover requires the same healthy rootless Podman API and absolute storage roots.",
    );
  }
  return createHash("sha256").update(`${graphRoot}\0${runRoot}`).digest("hex");
}

function proveWatcherStoppedWithPodman(
  lease: PodmanOpenShellWatcherStoppedLease,
  socketPath: string,
  expectedFingerprint: string | null,
  deps: PodmanManagedSandboxRecreateDeps,
): string {
  lease.assertStillStopped();
  const fingerprint = podmanRuntimeFingerprint(socketPath, deps);
  if (expectedFingerprint !== null && fingerprint !== expectedFingerprint) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman runtime identity changed while the OpenShell watcher was stopped.",
    );
  }
  lease.assertStillStopped();
  return fingerprint;
}

function sandboxContainerName(sandboxName: string): string {
  if (
    typeof sandboxName !== "string" ||
    !NAME_VALID_PATTERN.test(sandboxName) ||
    sandboxName.length === 0
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox recreation requires a valid canonical sandbox name.",
    );
  }
  return `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}`;
}

function parseDiscovery(outputValue: string, expectedName: string): string[] {
  const lines = outputValue
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const fields = line.split("\t");
    if (
      fields.length !== 2 ||
      fields[1] !== expectedName ||
      !FULL_CONTAINER_ID.test(fields[0] ?? "")
    ) {
      throw new PodmanManagedSandboxRecreateError(
        "Podman discovery did not return an exact name and full immutable container ID.",
      );
    }
    return fields[0] as string;
  });
}

export function findPodmanManagedSandboxContainerIds(
  socketPath: string,
  sandboxName: string,
  deps: PodmanManagedSandboxRecreateDeps = {},
): string[] {
  const name = sandboxContainerName(sandboxName);
  const result = runPodman(
    socketPath,
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^${name}$`,
      "--filter",
      `label=${PODMAN_MANAGED_LABEL}=true`,
      "--filter",
      `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    deps,
  );
  requireZero(result, "Podman managed sandbox discovery");
  return parseDiscovery(output(result.stdout), name);
}

function discoverManagedSandbox(
  socketPath: string,
  sandboxName: string,
  deps: PodmanManagedSandboxRecreateDeps,
): string {
  const ids = findPodmanManagedSandboxContainerIds(socketPath, sandboxName, deps);
  if (ids.length !== 1) {
    throw new PodmanManagedSandboxRecreateError(
      `Podman discovery must identify exactly one '${sandboxContainerName(
        sandboxName,
      )}' managed container.`,
    );
  }
  return ids[0] as string;
}

interface ExpectedManagedContainer {
  readonly containerId: string;
  readonly identityMode?: "managed" | "watcher-invisible-backup";
  readonly name: string;
  readonly requireRunning?: boolean;
  readonly sandboxId?: string;
  readonly sandboxName: string;
}

function inspectContainer(
  socketPath: string,
  expected: ExpectedManagedContainer,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxInspect {
  const result = runPodman(socketPath, ["container", "inspect", expected.containerId], deps);
  requireZero(result, `Podman inspect for '${expected.name}'`);
  return parsePodmanManagedSandboxInspect(output(result.stdout), expected);
}

function tryInspectContainer(
  socketPath: string,
  expected: ExpectedManagedContainer,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxInspect | null {
  try {
    return inspectContainer(socketPath, expected, deps);
  } catch {
    return null;
  }
}

function startAndVerifyContainer(
  socketPath: string,
  expected: Omit<ExpectedManagedContainer, "requireRunning">,
  deps: PodmanManagedSandboxRecreateDeps,
): boolean {
  runPodman(socketPath, ["start", expected.containerId], deps);
  return (
    tryInspectContainer(socketPath, { ...expected, requireRunning: true }, deps)?.running === true
  );
}

function containerExists(
  socketPath: string,
  containerId: string,
  deps: PodmanManagedSandboxRecreateDeps,
): boolean | null {
  const result = runPodman(socketPath, ["container", "exists", containerId], deps);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Quiesce only one exact identity-bound Podman workload.
 *
 * OpenShell deletion is mutable-name only, so managed bootstrap retains the
 * stopped workload for operator-coordinated cleanup.
 */
export function quiesceExactPodmanManagedSandbox(
  options: {
    readonly containerId: string;
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly socketAuthority: PodmanSocketAuthority;
    readonly socketPath: string;
  },
  deps: PodmanManagedSandboxRecreateDeps = {},
): void {
  const qualifiedDeps = bindSocketAuthority(options.socketPath, options.socketAuthority, deps);
  const expected = {
    containerId: options.containerId,
    name: sandboxContainerName(options.sandboxName),
    sandboxId: options.sandboxId,
    sandboxName: options.sandboxName,
  } as const;
  inspectContainer(options.socketPath, expected, qualifiedDeps);
  requireZero(
    runPodman(options.socketPath, ["stop", options.containerId], qualifiedDeps),
    "Podman managed-bootstrap workload quiesce",
  );
  if (inspectContainer(options.socketPath, expected, qualifiedDeps).running) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed-bootstrap workload remained running after exact quiesce.",
    );
  }
}

function pinImageMounts(
  socketPath: string,
  inspect: PodmanManagedSandboxInspect,
  deps: PodmanManagedSandboxRecreateDeps,
): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const source of podmanImageMountSources(inspect)) {
    const result = runPodman(socketPath, ["image", "inspect", "--format", "{{.Id}}", source], deps);
    requireZero(result, "Podman image-volume pinning");
    const imageId = output(result.stdout).trim();
    if (!FULL_IMAGE_ID.test(imageId)) {
      throw new PodmanManagedSandboxRecreateError(
        `Podman image-volume '${source}' did not resolve to a full immutable image ID.`,
      );
    }
    pins[source] = imageId;
  }
  return pins;
}

function buildPinnedCreatePlan(
  socketPath: string,
  inspect: PodmanManagedSandboxInspect,
  options: {
    readonly command: readonly string[] | null;
    readonly containerCommand?: readonly string[];
    readonly containerEntrypoint?: readonly string[];
    readonly labels?: Readonly<Record<string, string>>;
    readonly name?: string;
    readonly requireCommandEnvironment?: boolean;
    readonly requiredUlimits?: readonly PodmanUlimit[];
    readonly gpuAttachment?: PodmanGpuAttachment | null;
  },
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxCreatePlan {
  return buildPodmanManagedSandboxCreatePlan({
    command: options.command,
    ...(options.containerCommand ? { containerCommand: options.containerCommand } : {}),
    ...(options.containerEntrypoint ? { containerEntrypoint: options.containerEntrypoint } : {}),
    imagePins: pinImageMounts(socketPath, inspect, deps),
    inspect,
    labels: options.labels,
    name: options.name,
    requireCommandEnvironment: options.requireCommandEnvironment,
    requiredUlimits: options.requiredUlimits,
    gpuAttachment: options.gpuAttachment,
  });
}

function createPlanSemanticDigest(plan: PodmanManagedSandboxCreatePlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        args: plan.args,
        environmentInput: plan.environmentInput,
        version: 1,
      }),
    )
    .digest("hex");
}

export interface PodmanManagedSandboxLaunchSnapshot {
  readonly canonicalJson: string;
  readonly hash: string;
  readonly inspect: PodmanManagedSandboxInspect;
}

/**
 * Capture one exact, normalized Podman launch shape for managed bootstrap.
 */
export function capturePodmanManagedSandboxLaunchSnapshot(
  options: {
    readonly containerId: string;
    readonly gpuAttachment?: PodmanGpuAttachment | null;
    readonly requireRunning?: boolean;
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly socketAuthority: PodmanSocketAuthority;
    readonly socketPath: string;
  },
  deps: PodmanManagedSandboxRecreateDeps = {},
): PodmanManagedSandboxLaunchSnapshot {
  const qualifiedDeps = bindSocketAuthority(options.socketPath, options.socketAuthority, deps);
  const inspect = inspectContainer(
    options.socketPath,
    {
      containerId: options.containerId,
      name: sandboxContainerName(options.sandboxName),
      requireRunning: options.requireRunning ?? true,
      sandboxId: options.sandboxId,
      sandboxName: options.sandboxName,
    },
    qualifiedDeps,
  );
  const plan = buildPinnedCreatePlan(
    options.socketPath,
    inspect,
    { command: null, gpuAttachment: options.gpuAttachment },
    qualifiedDeps,
  );
  return Object.freeze({
    canonicalJson: JSON.stringify(plan),
    hash: createPlanSemanticDigest(plan),
    inspect,
  });
}

/**
 * Inspect one exact managed Podman workload without exposing the qualified
 * command runner to higher-level runtime providers.
 */
export function inspectExactPodmanManagedSandbox(
  options: {
    readonly containerId: string;
    readonly requireRunning?: boolean;
    readonly sandboxId?: string;
    readonly sandboxName: string;
    readonly socketAuthority: PodmanSocketAuthority;
    readonly socketPath: string;
  },
  deps: PodmanManagedSandboxRecreateDeps = {},
): PodmanManagedSandboxInspect {
  const qualifiedDeps = bindSocketAuthority(options.socketPath, options.socketAuthority, deps);
  return inspectContainer(
    options.socketPath,
    {
      containerId: options.containerId,
      name: sandboxContainerName(options.sandboxName),
      requireRunning: options.requireRunning,
      sandboxId: options.sandboxId,
      sandboxName: options.sandboxName,
    },
    qualifiedDeps,
  );
}

function requireEquivalentCreatePlan(
  expectedDigest: string,
  actual: PodmanManagedSandboxCreatePlan,
): void {
  if (createPlanSemanticDigest(actual) !== expectedDigest) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman container inspect does not reproduce the pinned recreation semantics.",
    );
  }
}

interface PodmanCidFile {
  readonly directory: string;
  readonly file: string;
}

function createCidFile(): PodmanCidFile {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-podman-recreate-"));
  return { directory, file: path.join(directory, "replacement.cid") };
}

function cleanupCidFile(cidFile: PodmanCidFile): void {
  try {
    rmSync(cidFile.directory, { force: true, recursive: true });
  } catch {
    // The cidfile contains only a container ID. Cleanup failure must not
    // interrupt rollback or turn a verified recreation into an outage.
  }
}

function readCidFile(cidFile: PodmanCidFile): string | null {
  let value: string;
  try {
    value = readFileSync(cidFile.file, "utf-8").trim();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!FULL_CONTAINER_ID.test(value)) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman create cidfile did not contain one full replacement container ID.",
    );
  }
  return value;
}

function backupName(originalName: string, now: Date): string {
  const suffix = `-nemoclaw-backup-${String(now.getTime())}`;
  const prefixLength = MAX_CONTAINER_NAME_LENGTH - suffix.length;
  if (prefixLength < 1) {
    throw new PodmanManagedSandboxRecreateError("Podman backup container name is too long.");
  }
  return `${originalName.slice(0, prefixLength)}${suffix}`;
}

function parseCreatedId(result: PodmanCommandResult): string {
  const lines = output(result.stdout).trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1 || !FULL_CONTAINER_ID.test(lines[0] ?? "")) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman create did not return one full replacement container ID.",
    );
  }
  return lines[0] as string;
}

function ownedCreatedId(result: PodmanCommandResult, cidFileId: string | null): string | null {
  let stdoutId: string | null = null;
  try {
    stdoutId = parseCreatedId(result);
  } catch (error) {
    if (result.status === 0 && !cidFileId) throw error;
  }
  if (cidFileId && stdoutId && cidFileId !== stdoutId) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman create stdout and cidfile identified different replacement containers.",
    );
  }
  return cidFileId ?? stdoutId;
}

interface PodmanCreateAttempt {
  readonly containerId: string | null;
  readonly detail: string;
  readonly ok: boolean;
}

function createContainerFromPlan(
  socketPath: string,
  plan: PodmanManagedSandboxCreatePlan,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanCreateAttempt {
  const cidFile = createCidFile();
  let result: PodmanCommandResult = { status: null };
  let callError: unknown = null;
  let cidFileId: string | null = null;
  let cidFileError: unknown = null;
  try {
    try {
      result = runPodman(
        socketPath,
        ["create", "--cidfile", cidFile.file, ...plan.args.slice(1)],
        deps,
        { input: plan.environmentInput },
      );
    } catch (error) {
      callError = error;
    }
    try {
      cidFileId = readCidFile(cidFile);
    } catch (error) {
      cidFileError = error;
    }
  } finally {
    cleanupCidFile(cidFile);
  }

  let containerId: string | null = null;
  let identityError = cidFileError;
  try {
    containerId = ownedCreatedId(result, cidFileId);
  } catch (error) {
    identityError ??= error;
  }
  const sensitiveEnvironment = plan.environmentInput.split(/\r?\n/u).filter(Boolean);
  const error = callError ?? identityError;
  const message =
    error instanceof Error
      ? detail({ error, status: result.status }, sensitiveEnvironment)
      : result.status === 0
        ? ""
        : detail(result, sensitiveEnvironment);
  return {
    containerId,
    detail: message,
    ok: callError === null && identityError === null && result.status === 0 && containerId !== null,
  };
}

function removeOwnedContainer(
  socketPath: string,
  containerId: string,
  deps: PodmanManagedSandboxRecreateDeps,
): boolean {
  const exists = containerExists(socketPath, containerId, deps);
  if (exists === false) return true;
  if (exists === null) return false;
  runPodman(socketPath, ["stop", containerId], deps);
  runPodman(socketPath, ["rm", containerId], deps);
  return containerExists(socketPath, containerId, deps) === false;
}

function inspectWatcherInvisibleBackup(
  transaction: Pick<
    PodmanManagedSandboxRecreateTransaction,
    "backupContainerId" | "backupContainerName" | "originalLabels" | "sandboxName" | "socketPath"
  >,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxInspect {
  return inspectContainer(
    transaction.socketPath,
    {
      containerId: transaction.backupContainerId,
      identityMode: "watcher-invisible-backup",
      name: transaction.backupContainerName,
      sandboxId: String(transaction.originalLabels[PODMAN_SANDBOX_ID_LABEL] ?? ""),
      sandboxName: transaction.sandboxName,
    },
    deps,
  );
}

type PodmanRestoreIdentity = Pick<
  PodmanManagedSandboxRecreateTransaction,
  | "backupContainerId"
  | "backupContainerName"
  | "backupSemanticDigest"
  | "gpuAttachment"
  | "originalGpuAttachment"
  | "originalLabels"
  | "originalName"
  | "originalSemanticDigest"
  | "sandboxName"
  | "socketAuthority"
  | "socketPath"
>;

function buildVerifiedRestorePlan(
  transaction: PodmanRestoreIdentity,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxCreatePlan {
  const backup = inspectWatcherInvisibleBackup(transaction, deps);
  const backupPlan = buildPinnedCreatePlan(
    transaction.socketPath,
    backup,
    {
      command: null,
      gpuAttachment: transaction.originalGpuAttachment,
      labels: podmanWatcherInvisibleBackupLabels(backup),
      name: transaction.backupContainerName,
    },
    deps,
  );
  requireEquivalentCreatePlan(transaction.backupSemanticDigest, backupPlan);
  const restorePlan = buildPinnedCreatePlan(
    transaction.socketPath,
    backup,
    {
      command: null,
      gpuAttachment: transaction.originalGpuAttachment,
      labels: transaction.originalLabels,
      name: transaction.originalName,
    },
    deps,
  );
  requireEquivalentCreatePlan(transaction.originalSemanticDigest, restorePlan);
  return restorePlan;
}

function restoreManagedFromBackup(
  transaction: PodmanRestoreIdentity,
  deps: PodmanManagedSandboxRecreateDeps,
): { readonly originalRecreated: boolean; readonly originalStarted: boolean } {
  const restored = createContainerFromPlan(
    transaction.socketPath,
    buildVerifiedRestorePlan(transaction, deps),
    deps,
  );
  if (!restored.ok || !restored.containerId) {
    if (restored.containerId) {
      removeOwnedContainer(transaction.socketPath, restored.containerId, deps);
    }
    return { originalRecreated: false, originalStarted: false };
  }
  const originalRecreated =
    tryInspectContainer(
      transaction.socketPath,
      {
        containerId: restored.containerId,
        name: transaction.originalName,
        sandboxName: transaction.sandboxName,
      },
      deps,
    ) !== null;
  const originalStarted =
    originalRecreated &&
    startAndVerifyContainer(
      transaction.socketPath,
      {
        containerId: restored.containerId,
        name: transaction.originalName,
        sandboxName: transaction.sandboxName,
      },
      deps,
    );
  if (!originalStarted) return { originalRecreated, originalStarted: false };
  const runningOriginal = inspectContainer(
    transaction.socketPath,
    {
      containerId: restored.containerId,
      name: transaction.originalName,
      requireRunning: true,
      sandboxName: transaction.sandboxName,
    },
    deps,
  );
  requireEquivalentCreatePlan(
    transaction.originalSemanticDigest,
    buildPinnedCreatePlan(
      transaction.socketPath,
      runningOriginal,
      { command: null, gpuAttachment: transaction.originalGpuAttachment },
      deps,
    ),
  );
  return { originalRecreated: true, originalStarted: true };
}

function rollbackKnownTransaction(
  transaction: PodmanManagedSandboxRecreateTransaction,
  lease: PodmanOpenShellWatcherStoppedLease,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanManagedSandboxRollbackOutcome {
  const podmanFingerprint = proveWatcherStoppedWithPodman(
    lease,
    transaction.socketPath,
    null,
    deps,
  );
  buildVerifiedRestorePlan(transaction, deps);
  proveWatcherStoppedWithPodman(lease, transaction.socketPath, podmanFingerprint, deps);
  const replacementExists = containerExists(
    transaction.socketPath,
    transaction.newContainerId,
    deps,
  );
  if (
    replacementExists !== false &&
    !tryInspectContainer(
      transaction.socketPath,
      {
        containerId: transaction.newContainerId,
        name: transaction.originalName,
        sandboxName: transaction.sandboxName,
      },
      deps,
    )
  ) {
    return {
      originalRecreated: false,
      originalStarted: false,
      replacementRemoved: false,
      rolledBack: false,
    };
  }
  proveWatcherStoppedWithPodman(lease, transaction.socketPath, podmanFingerprint, deps);
  const replacementRemoved =
    replacementExists === false ||
    removeOwnedContainer(transaction.socketPath, transaction.newContainerId, deps);
  if (!replacementRemoved) {
    return {
      originalRecreated: false,
      originalStarted: false,
      replacementRemoved: false,
      rolledBack: false,
    };
  }

  proveWatcherStoppedWithPodman(lease, transaction.socketPath, podmanFingerprint, deps);
  const { originalRecreated, originalStarted } = restoreManagedFromBackup(transaction, deps);
  if (!originalStarted) {
    return {
      originalRecreated,
      originalStarted: false,
      replacementRemoved: true,
      rolledBack: false,
    };
  }
  proveWatcherStoppedWithPodman(lease, transaction.socketPath, podmanFingerprint, deps);
  return {
    originalRecreated: true,
    originalStarted: true,
    replacementRemoved: true,
    rolledBack: true,
  };
}

interface PodmanRollbackAndWatcherResumeAttempt {
  readonly outcome: PodmanManagedSandboxRollbackOutcome;
  readonly resumeError: unknown;
  readonly rollbackError: unknown;
}

function failedRollbackOutcome(): PodmanManagedSandboxRollbackOutcome {
  return {
    originalRecreated: false,
    originalStarted: false,
    replacementRemoved: false,
    rolledBack: false,
  };
}

/**
 * A rollback exception must never strand a watcher that this transaction
 * successfully stopped. The outcome is complete only after both the original
 * managed container and watcher restart have been proven.
 */
function rollbackAndResumeWatcher(
  transaction: PodmanManagedSandboxRecreateTransaction,
  lease: PodmanOpenShellWatcherStoppedLease,
  deps: PodmanManagedSandboxRecreateDeps,
): PodmanRollbackAndWatcherResumeAttempt {
  let outcome = failedRollbackOutcome();
  let rollbackError: unknown = null;
  try {
    outcome = rollbackKnownTransaction(transaction, lease, deps);
  } catch (error) {
    rollbackError = error;
  }

  let resumeError: unknown = null;
  try {
    lease.resumeAndProve();
  } catch (error) {
    resumeError = error;
  }
  if (resumeError !== null) outcome = { ...outcome, rolledBack: false };
  return { outcome, resumeError, rollbackError };
}

export function recreatePodmanManagedSandbox(
  options: {
    readonly command: readonly string[];
    readonly containerCommand?: readonly string[];
    readonly containerEntrypoint?: readonly string[];
    readonly gpuAttachment?: PodmanGpuAttachment | null;
    readonly requiredUlimits?: readonly PodmanUlimit[];
    readonly sandboxName: string;
    readonly socketAuthority: PodmanSocketAuthority;
    readonly socketPath: string;
    readonly stagedFile?: {
      readonly containerPath: string;
      readonly hostPath: string;
    };
    readonly transactionIdentity?: string;
    readonly watcherController: PodmanOpenShellWatcherController;
  },
  deps: PodmanManagedSandboxRecreateDeps = {},
): PodmanManagedSandboxRecreateTransaction {
  const watcherController = requireWatcherController(options.watcherController);
  if (
    options.transactionIdentity !== undefined &&
    !/^[a-f0-9]{64}$/u.test(options.transactionIdentity)
  ) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox transaction identity is invalid.",
    );
  }
  const originalName = sandboxContainerName(options.sandboxName);
  const socketPath = options.socketPath.trim();
  socketUrl(socketPath);
  deps = bindSocketAuthority(socketPath, options.socketAuthority, deps);
  const oldContainerId = discoverManagedSandbox(socketPath, options.sandboxName, deps);
  const original = inspectContainer(
    socketPath,
    {
      containerId: oldContainerId,
      name: originalName,
      requireRunning: true,
      sandboxName: options.sandboxName,
    },
    deps,
  );
  const command = [...options.command];
  const containerCommand = options.containerCommand
    ? Object.freeze([...options.containerCommand])
    : undefined;
  const containerEntrypoint = options.containerEntrypoint
    ? Object.freeze([...options.containerEntrypoint])
    : undefined;
  const gpuAttachment = options.gpuAttachment ?? null;
  const rawHostConfig =
    typeof original.raw.HostConfig === "object" &&
    original.raw.HostConfig !== null &&
    !Array.isArray(original.raw.HostConfig)
      ? (original.raw.HostConfig as Record<string, unknown>)
      : {};
  const originalDevices = Array.isArray(rawHostConfig.Devices) ? rawHostConfig.Devices : [];
  const originalGpuAttachment = originalDevices.length > 0 ? gpuAttachment : null;
  const requiredUlimits = (options.requiredUlimits ?? []).map((limit) => ({ ...limit }));
  const plan = buildPinnedCreatePlan(
    socketPath,
    original,
    {
      command,
      ...(containerCommand ? { containerCommand } : {}),
      ...(containerEntrypoint ? { containerEntrypoint } : {}),
      gpuAttachment,
      requiredUlimits,
    },
    deps,
  );
  const semanticDigest = createPlanSemanticDigest(plan);
  const originalPlan = buildPinnedCreatePlan(
    socketPath,
    original,
    { command: null, gpuAttachment: originalGpuAttachment },
    deps,
  );
  const originalSemanticDigest = createPlanSemanticDigest(originalPlan);
  const originalLabels = { ...original.labels };
  const pinnedAgain = discoverManagedSandbox(socketPath, options.sandboxName, deps);
  if (pinnedAgain !== oldContainerId) {
    throw new PodmanManagedSandboxRecreateError(
      "Podman managed sandbox identity changed immediately before mutation.",
    );
  }
  const current = inspectContainer(
    socketPath,
    {
      containerId: oldContainerId,
      name: originalName,
      requireRunning: true,
      sandboxName: options.sandboxName,
    },
    deps,
  );
  requireEquivalentCreatePlan(
    semanticDigest,
    buildPinnedCreatePlan(socketPath, current, { command, gpuAttachment, requiredUlimits }, deps),
  );
  requireEquivalentCreatePlan(
    originalSemanticDigest,
    buildPinnedCreatePlan(
      socketPath,
      current,
      { command: null, gpuAttachment: originalGpuAttachment },
      deps,
    ),
  );
  const backupContainerName = backupName(originalName, commandDeps(deps).now());
  const backupLabels = {
    ...podmanWatcherInvisibleBackupLabels(original),
    ...(options.transactionIdentity
      ? { "io.nvidia.nemoclaw.managed-bootstrap": options.transactionIdentity }
      : {}),
  };
  const backupPlan = buildPinnedCreatePlan(
    socketPath,
    original,
    {
      command: null,
      gpuAttachment: originalGpuAttachment,
      labels: backupLabels,
      name: backupContainerName,
    },
    deps,
  );
  const backupSemanticDigest = createPlanSemanticDigest(backupPlan);
  const backupCreated = createContainerFromPlan(socketPath, backupPlan, deps);
  if (!backupCreated.ok || !backupCreated.containerId) {
    if (backupCreated.containerId) {
      removeOwnedContainer(socketPath, backupCreated.containerId, deps);
    }
    throw new PodmanManagedSandboxRecreateError(
      `Creating the watcher-invisible Podman rollback backup failed${
        backupCreated.detail ? `: ${backupCreated.detail}` : "."
      } The original managed container remains running.`,
      true,
    );
  }
  const backupContainerId = backupCreated.containerId;
  const baseTransaction: PodmanRestoreIdentity & {
    readonly command: readonly string[];
    readonly immutableImage: string;
    readonly oldContainerId: string;
    readonly requiredUlimits: readonly PodmanUlimit[];
    readonly semanticDigest: string;
  } = {
    backupContainerId,
    backupContainerName,
    backupSemanticDigest,
    command,
    ...(containerCommand ? { containerCommand } : {}),
    ...(containerEntrypoint ? { containerEntrypoint } : {}),
    gpuAttachment,
    originalGpuAttachment,
    immutableImage: plan.immutableImage,
    oldContainerId,
    originalLabels,
    originalName,
    originalSemanticDigest,
    requiredUlimits,
    sandboxName: options.sandboxName,
    semanticDigest,
    socketAuthority: options.socketAuthority,
    socketPath,
    ...(options.transactionIdentity
      ? { transactionIdentity: options.transactionIdentity }
      : {}),
  };
  const backup = inspectWatcherInvisibleBackup(baseTransaction, deps);
  if (backup.running) {
    removeOwnedContainer(socketPath, backupContainerId, deps);
    throw new PodmanManagedSandboxRecreateError(
      "Watcher-invisible Podman rollback backup unexpectedly started.",
      true,
    );
  }
  requireEquivalentCreatePlan(
    backupSemanticDigest,
    buildPinnedCreatePlan(
      socketPath,
      backup,
      {
        command: null,
        gpuAttachment: originalGpuAttachment,
        labels: backupLabels,
        name: backupContainerName,
      },
      deps,
    ),
  );
  let watcherLease: PodmanOpenShellWatcherStoppedLease;
  try {
    watcherLease = requireWatcherLease(watcherController.quiesceAndProve());
  } catch (error) {
    removeOwnedContainer(socketPath, backupContainerId, deps);
    throw error;
  }
  let podmanFingerprint: string;
  try {
    podmanFingerprint = proveWatcherStoppedWithPodman(watcherLease, socketPath, null, deps);
  } catch (error) {
    let watcherResumed = false;
    try {
      watcherLease.resumeAndProve();
      watcherResumed = true;
    } catch {
      // The original managed container remains running and the backup is
      // watcher-invisible; no managed-container mutation is attempted.
    }
    removeOwnedContainer(socketPath, backupContainerId, deps);
    const message = error instanceof Error ? error.message : String(error);
    throw new PodmanManagedSandboxRecreateError(
      `OpenShell watcher cutover preflight failed: ${message}. ${
        watcherResumed ? "The watcher was resumed." : "Watcher recovery could not be proven."
      }`,
      watcherResumed,
    );
  }
  const abortCutover = (message: string, replacementId: string | null = null): never => {
    let restored = false;
    try {
      proveWatcherStoppedWithPodman(watcherLease, socketPath, podmanFingerprint, deps);
      if (replacementId) removeOwnedContainer(socketPath, replacementId, deps);
      const originalExists = containerExists(socketPath, oldContainerId, deps);
      if (originalExists === true) {
        const originalNow = tryInspectContainer(
          socketPath,
          {
            containerId: oldContainerId,
            name: originalName,
            sandboxName: options.sandboxName,
          },
          deps,
        );
        restored =
          originalNow !== null &&
          (originalNow.running ||
            startAndVerifyContainer(
              socketPath,
              {
                containerId: oldContainerId,
                name: originalName,
                sandboxName: options.sandboxName,
              },
              deps,
            ));
      } else if (originalExists === false) {
        restored = restoreManagedFromBackup(baseTransaction, deps).originalStarted;
      }
      proveWatcherStoppedWithPodman(watcherLease, socketPath, podmanFingerprint, deps);
    } catch {
      restored = false;
    }
    let watcherResumed = false;
    try {
      watcherLease.resumeAndProve();
      watcherResumed = true;
    } catch {
      // Leave the invisible backup in place unless both recovery halves prove.
    }
    const rolledBack = restored && watcherResumed;
    if (rolledBack) removeOwnedContainer(socketPath, backupContainerId, deps);
    throw new PodmanManagedSandboxRecreateError(
      `${message} ${
        rolledBack
          ? "The original Podman sandbox was restored before the watcher resumed."
          : "Podman sandbox rollback or watcher recovery did not complete."
      }`,
      rolledBack,
    );
  };
  const proveStoppedOrAbort = (stage: string): void => {
    try {
      proveWatcherStoppedWithPodman(watcherLease, socketPath, podmanFingerprint, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      abortCutover(`OpenShell watcher proof failed ${stage}: ${message}.`);
    }
  };

  proveStoppedOrAbort("before stopping the original managed container");
  const stopped = runPodman(socketPath, ["stop", oldContainerId], deps);
  const stoppedOriginal = tryInspectContainer(
    socketPath,
    {
      containerId: oldContainerId,
      name: originalName,
      sandboxName: options.sandboxName,
    },
    deps,
  );
  if (!stoppedOriginal) {
    const restored = startAndVerifyContainer(
      socketPath,
      {
        containerId: oldContainerId,
        name: originalName,
        sandboxName: options.sandboxName,
      },
      deps,
    );
    abortCutover(
      `Stopping the original Podman managed sandbox could not be reconciled${
        detail(stopped) ? `: ${detail(stopped)}` : "."
      } ${restored ? "The exact original container was restored." : "The exact original container could not be restored."}`,
    );
  }
  if (stoppedOriginal?.running) {
    abortCutover(
      `Stopping the original Podman managed sandbox did not leave the pinned container stopped${
        detail(stopped) ? `: ${detail(stopped)}` : "."
      } The original container remains running.`,
    );
  }
  proveStoppedOrAbort("before removing the original managed container");
  const removedOriginal = runPodman(socketPath, ["rm", oldContainerId], deps);
  if (containerExists(socketPath, oldContainerId, deps) !== false) {
    abortCutover(
      `Removing the original managed container during the watcher-stopped cutover failed${
        detail(removedOriginal) ? `: ${detail(removedOriginal)}` : "."
      }`,
    );
  }
  proveStoppedOrAbort("before creating the replacement managed container");
  const replacementCreated = createContainerFromPlan(socketPath, plan, deps);
  if (!replacementCreated.ok || !replacementCreated.containerId) {
    abortCutover(
      `Creating the replacement Podman managed sandbox failed${
        replacementCreated.detail ? `: ${replacementCreated.detail}` : "."
      }`,
      replacementCreated.containerId,
    );
  }
  const newContainerId = replacementCreated.containerId as string;
  if (newContainerId === oldContainerId || newContainerId === backupContainerId) {
    abortCutover("Podman returned a previously pinned container ID for the replacement.");
  }
  const transaction: PodmanManagedSandboxRecreateTransaction = {
    ...baseTransaction,
    applied: true,
    driverName: "podman",
    newContainerId,
  };

  try {
    const createdReplacement = inspectContainer(
      socketPath,
      {
        containerId: newContainerId,
        name: originalName,
        sandboxName: options.sandboxName,
      },
      deps,
    );
    requireEquivalentCreatePlan(
      semanticDigest,
      buildPinnedCreatePlan(
        socketPath,
        createdReplacement,
        {
          command,
          ...(containerCommand ? { containerCommand } : {}),
          ...(containerEntrypoint ? { containerEntrypoint } : {}),
          gpuAttachment,
          requireCommandEnvironment: true,
        },
        deps,
      ),
    );
    if (options.stagedFile) {
      const { containerPath, hostPath } = options.stagedFile;
      if (
        !path.isAbsolute(hostPath) ||
        !path.isAbsolute(containerPath) ||
        /[\0\r\n]/u.test(hostPath) ||
        /[\0\r\n]/u.test(containerPath)
      ) {
        throw new PodmanManagedSandboxRecreateError(
          "Podman managed sandbox staged file paths are invalid.",
        );
      }
      requireZero(
        runPodman(socketPath, ["cp", hostPath, `${newContainerId}:${containerPath}`], deps),
        "Podman managed-bootstrap protected request staging",
      );
    }
    proveWatcherStoppedWithPodman(watcherLease, socketPath, podmanFingerprint, deps);
    if (
      !startAndVerifyContainer(
        socketPath,
        {
          containerId: newContainerId,
          name: originalName,
          sandboxName: options.sandboxName,
        },
        deps,
      )
    ) {
      throw new PodmanManagedSandboxRecreateError(
        "Starting the replacement Podman managed sandbox could not be verified.",
      );
    }
    const replacement = inspectContainer(
      socketPath,
      {
        containerId: newContainerId,
        name: originalName,
        requireRunning: true,
        sandboxName: options.sandboxName,
      },
      deps,
    );
    requireEquivalentCreatePlan(
      semanticDigest,
      buildPinnedCreatePlan(
        socketPath,
        replacement,
        {
          command,
          ...(containerCommand ? { containerCommand } : {}),
          ...(containerEntrypoint ? { containerEntrypoint } : {}),
          gpuAttachment,
          requireCommandEnvironment: true,
        },
        deps,
      ),
    );
    const verifiedBackup = inspectWatcherInvisibleBackup(transaction, deps);
    if (verifiedBackup.running) {
      throw new PodmanManagedSandboxRecreateError(
        "The pinned original Podman backup restarted while the replacement was being verified.",
      );
    }
    requireEquivalentCreatePlan(
      backupSemanticDigest,
      buildPinnedCreatePlan(
        socketPath,
        verifiedBackup,
        {
          command: null,
          gpuAttachment: originalGpuAttachment,
          labels: backupLabels,
          name: backupContainerName,
        },
        deps,
      ),
    );
    proveWatcherStoppedWithPodman(watcherLease, socketPath, podmanFingerprint, deps);
  } catch (error) {
    const attempt = rollbackAndResumeWatcher(transaction, watcherLease, deps);
    if (attempt.outcome.rolledBack) removeOwnedContainer(socketPath, backupContainerId, deps);
    const message = error instanceof Error ? error.message : String(error);
    const rollbackMessage =
      attempt.rollbackError === null
        ? ""
        : ` Rollback failed: ${
            attempt.rollbackError instanceof Error
              ? attempt.rollbackError.message
              : String(attempt.rollbackError)
          }.`;
    const resumeMessage =
      attempt.resumeError === null
        ? ""
        : ` Watcher recovery failed: ${
            attempt.resumeError instanceof Error
              ? attempt.resumeError.message
              : String(attempt.resumeError)
          }.`;
    throw new PodmanManagedSandboxRecreateError(
      attempt.outcome.rolledBack
        ? `${message} The original Podman sandbox was restored before the watcher resumed.`
        : `${message} Podman sandbox rollback did not complete.${rollbackMessage}${resumeMessage}`,
      attempt.outcome.rolledBack,
    );
  }
  try {
    watcherLease.resumeAndProve();
  } catch (error) {
    let attempt: PodmanRollbackAndWatcherResumeAttempt | null = null;
    try {
      watcherLease.assertStillStopped();
      attempt = rollbackAndResumeWatcher(transaction, watcherLease, deps);
    } catch {
      // A partially resumed watcher is not safe for another managed removal.
    }
    if (attempt?.outcome.rolledBack) removeOwnedContainer(socketPath, backupContainerId, deps);
    const message = error instanceof Error ? error.message : String(error);
    throw new PodmanManagedSandboxRecreateError(
      `Restarting the OpenShell watcher after Podman cutover failed: ${message}. ${
        attempt?.outcome.rolledBack
          ? "The original sandbox was restored."
          : "The watcher or sandbox rollback could not be proven."
      }`,
      attempt?.outcome.rolledBack ?? false,
    );
  }
  return transaction;
}

export function rollbackPodmanManagedSandbox(
  options: {
    readonly transaction: PodmanManagedSandboxRecreateTransaction;
    readonly watcherController: PodmanOpenShellWatcherController;
  },
  deps: PodmanManagedSandboxRecreateDeps = {},
): PodmanManagedSandboxRollbackOutcome {
  const watcherController = requireWatcherController(options.watcherController);
  deps = bindSocketAuthority(
    options.transaction.socketPath,
    options.transaction.socketAuthority,
    deps,
  );
  const lease = requireWatcherLease(watcherController.quiesceAndProve());
  const attempt = rollbackAndResumeWatcher(options.transaction, lease, deps);
  if (attempt.rollbackError !== null) {
    const message =
      attempt.rollbackError instanceof Error
        ? attempt.rollbackError.message
        : String(attempt.rollbackError);
    throw new PodmanManagedSandboxRecreateError(
      `Podman sandbox rollback failed: ${message}. ${
        attempt.resumeError === null
          ? "The watcher was resumed."
          : "Watcher recovery could not be proven."
      }`,
      false,
    );
  }
  if (attempt.outcome.rolledBack) {
    removeOwnedContainer(
      options.transaction.socketPath,
      options.transaction.backupContainerId,
      deps,
    );
  }
  return attempt.outcome;
}

export function finalizePodmanManagedSandbox(
  options:
    | {
        readonly replacementReady: true;
        readonly transaction: PodmanManagedSandboxRecreateTransaction;
      }
    | {
        readonly replacementReady: false;
        readonly transaction: PodmanManagedSandboxRecreateTransaction;
        readonly watcherController: PodmanOpenShellWatcherController;
      },
  deps: PodmanManagedSandboxRecreateDeps = {},
): PodmanManagedSandboxFinalizeOutcome {
  deps = bindSocketAuthority(
    options.transaction.socketPath,
    options.transaction.socketAuthority,
    deps,
  );
  if (!options.replacementReady) {
    const rollback = rollbackPodmanManagedSandbox(
      {
        transaction: options.transaction,
        watcherController: options.watcherController,
      },
      deps,
    );
    return { backupRemoved: false, rolledBack: rollback.rolledBack };
  }
  const replacement = inspectContainer(
    options.transaction.socketPath,
    {
      containerId: options.transaction.newContainerId,
      name: options.transaction.originalName,
      requireRunning: true,
      sandboxName: options.transaction.sandboxName,
    },
    deps,
  );
  requireEquivalentCreatePlan(
    options.transaction.semanticDigest,
    buildPinnedCreatePlan(
      options.transaction.socketPath,
      replacement,
      {
        command: options.transaction.command,
        ...(options.transaction.containerCommand
          ? { containerCommand: options.transaction.containerCommand }
          : {}),
        ...(options.transaction.containerEntrypoint
          ? { containerEntrypoint: options.transaction.containerEntrypoint }
          : {}),
        gpuAttachment: options.transaction.gpuAttachment,
        requireCommandEnvironment: true,
      },
      deps,
    ),
  );
  const backup = inspectWatcherInvisibleBackup(options.transaction, deps);
  if (backup.running) {
    throw new PodmanManagedSandboxRecreateError(
      "The pinned original Podman backup is running; finalize will not delete it.",
    );
  }
  requireEquivalentCreatePlan(
    options.transaction.backupSemanticDigest,
    buildPinnedCreatePlan(
      options.transaction.socketPath,
      backup,
      {
        command: null,
        gpuAttachment: options.transaction.originalGpuAttachment,
        labels: podmanWatcherInvisibleBackupLabels(backup),
        name: options.transaction.backupContainerName,
      },
      deps,
    ),
  );
  runPodman(options.transaction.socketPath, ["rm", options.transaction.backupContainerId], deps);
  return {
    backupRemoved:
      containerExists(
        options.transaction.socketPath,
        options.transaction.backupContainerId,
        deps,
      ) === false,
    rolledBack: false,
  };
}
