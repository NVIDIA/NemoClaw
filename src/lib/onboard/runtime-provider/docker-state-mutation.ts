// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandCapture,
  ContainerEngineCommandResult,
  ContainerEngineOperationScope,
} from "../../adapters/container-engine";
import { resolveShieldsStateDir, withShieldsTransitionLock } from "../../shields/transition-lock";
import type {
  RuntimeProviderPreparedStateMutationPlan,
  RuntimeProviderStateMutationActivationProof,
  RuntimeProviderStateMutationContext,
  RuntimeProviderStateMutationFence,
  RuntimeProviderStateMutationProtectionPosture,
  RuntimeProviderStateMutationSurface,
} from "./contract";
import { RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION } from "./contract";
import {
  createDockerOperationAuthority,
  type DockerOperationAuthority,
} from "./docker-operation-authority";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
} from "./persisted-engine-authority";
import {
  type AuthorizedPersistedEngineLifecycle,
  assertActivePersistedEngineStateMutation,
  completePersistedEngineStateMutation,
  createFilePersistedEngineLifecycleStore,
  executePersistedEngineStateMutation,
  hasActivePersistedEngineStateMutationTarget,
  loadPersistedEngineStateMutationIntent,
  type PersistedEngineLifecycleExecutionInput,
  type PersistedEngineLifecycleExactCommand,
  type PersistedEngineLifecycleRecord,
  type PersistedEngineLifecycleStore,
  type PersistedEngineStateMutationIntent,
  preparePersistedEngineLifecycle,
  releaseCompletedPersistedEngineStateMutation,
} from "./persisted-engine-lifecycle";
import { prepareRuntimeProviderStateMutationPlan } from "./state-mutation";

const DOCKER_PROVIDER_ID = "docker";
const SUPPORTED_STATE_ROOT = "/sandbox/.hermes";
const HELPER_PYTHON_PATH = "/opt/hermes/.venv/bin/python3";
const HELPER_TRANSPORT_BROKER_PATH =
  "/usr/local/lib/nemoclaw/runtime-state-mutation-transport-broker.py";
const HELPER_FAST_TIMEOUT_MS = 30_000;
const HELPER_ACTIVATION_RETRY_ACK_TIMEOUT_MS = 5_000;
const HELPER_ACTIVATION_CHECKPOINT_TIMEOUT_MS = 150_000;
const HELPER_ACTIVATION_HEALTH_TIMEOUT_MS = 150_000;
const HELPER_ACTIVATION_REPLAY_TIMEOUT_MS = 150_000;
const HELPER_ACTIVATION_COMPLETION_ALLOWANCE_MS = 30_000;
/** Covers retry acknowledgement, both readiness passes, replay, and completion. */
export const DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS =
  HELPER_ACTIVATION_RETRY_ACK_TIMEOUT_MS +
  HELPER_ACTIVATION_CHECKPOINT_TIMEOUT_MS +
  HELPER_ACTIVATION_HEALTH_TIMEOUT_MS +
  HELPER_ACTIVATION_REPLAY_TIMEOUT_MS +
  HELPER_ACTIVATION_COMPLETION_ALLOWANCE_MS;
export const DOCKER_STATE_MUTATION_GUARD_TIMEOUT_MS = 15 * 60_000;
const HELPER_RELEASE_TIMEOUT_MS = 5 * 60_000;
const INSPECT_TIMEOUT_MS = 15_000;
const SUPERVISOR_SIGNAL_TIMEOUT_MS = 15_000;
const HELPER_TRANSPORT_COMMAND_TIMEOUT_MS = 15_000;
const HELPER_TRANSPORT_RESPONSE_ALLOWANCE_MS = 30_000;
const HELPER_TRANSPORT_POLL_MS = 250;
const HELPER_TRANSPORT_ROOT = "/run/nemoclaw/runtime-state-mutation";
const HELPER_TRANSPORT_SESSION_PRESENT_STATUS = 75;
const HELPER_TRANSPORT_SESSION_INSPECTION_FAILED_STATUS = 76;
const HELPER_TRANSPORT_SESSION_ABSENT_SCRIPT = `import os,sys
try:
 os.lstat(sys.argv[1])
except FileNotFoundError:
 raise SystemExit(0)
except Exception:
 raise SystemExit(${HELPER_TRANSPORT_SESSION_INSPECTION_FAILED_STATUS})
raise SystemExit(${HELPER_TRANSPORT_SESSION_PRESENT_STATUS})`;
const MAX_HELPER_TRANSPORT_BYTES = 128 * 1024;
const MAX_INSPECTION_BYTES = 1024 * 1024;
const MAX_MOUNTS = 256;
const RUNTIME_QUERY_FORMAT = "{{.ID}}";
const DEFAULT_MANAGED_LABEL_KEY = "openshell.ai/managed-by";
const DEFAULT_MANAGED_LABEL_VALUE = "openshell";
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const LIFECYCLE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const MOUNT_NAMESPACE = /^mnt:\[[1-9][0-9]*\]$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const helperTransportPoll = new Int32Array(new SharedArrayBuffer(4));

type HelperAction =
  | "acquire"
  | "assert"
  | "publish"
  | "recover"
  | "rollback"
  | "activate"
  | "release";
type HelperPhase = "fenced" | "published" | "rolled-back" | "activation-proven";

function helperTimeoutMs(action: HelperAction): number {
  switch (action) {
    case "publish":
    case "recover":
    case "rollback":
      return DOCKER_STATE_MUTATION_GUARD_TIMEOUT_MS;
    case "activate":
      return DOCKER_STATE_MUTATION_ACTIVATE_TIMEOUT_MS;
    case "release":
      return HELPER_RELEASE_TIMEOUT_MS;
    case "acquire":
    case "assert":
      return HELPER_FAST_TIMEOUT_MS;
  }
}

interface DockerMountIdentity {
  readonly type: string;
  readonly source: string;
  readonly name: string | null;
  readonly destination: string;
  readonly driver: string | null;
  readonly mode: string;
  readonly readWrite: boolean;
  readonly propagation: string;
}

interface DockerRuntimeObservation {
  readonly providerDisplayName: string;
  readonly runtimeId: string;
  readonly runtimePid: number;
  readonly pidMode: string;
  readonly privileged: false;
  readonly sandboxIdentitySha256: string;
  readonly containerMountsSha256: string;
  readonly mounts: readonly DockerMountIdentity[];
}

interface DockerStateRootBinding {
  readonly stateRoot: string;
  readonly stateRootMountsSha256: string;
}

interface DockerStateMutationHelperReceipt {
  readonly schemaVersion: 1;
  readonly phase: HelperPhase;
  readonly transactionId: string;
  readonly providerId: string;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly engineBindingSha256: string;
  readonly runtimeId: string;
  readonly runtimePid: number;
  readonly sandboxIdentitySha256: string;
  readonly containerMountsSha256: string;
  readonly stateRoot: string;
  readonly stateRootMountsSha256: string;
  readonly mountNamespace: string;
  readonly stateRootDevice: string;
  readonly stateRootInode: string;
  readonly planSha256: string;
  readonly projectionSha256: string;
  readonly nonce: string;
  readonly target: RuntimeProviderStateMutationProtectionPosture;
  readonly rollback: RuntimeProviderStateMutationProtectionPosture;
  readonly configurationGeneration?: string;
  readonly listenerIdentity?: string;
  readonly healthSha256?: string;
  readonly activationProviderHandle?: string;
}

export interface ContainerStateMutationAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
}

export interface ContainerStateMutationOwnerOptions {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly engineOperation: ContainerEngineOperationScope;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  /** SHA-256 of the raw OpenShell sandbox ID recorded with this generation. */
  readonly lifecycleLiveIdentityFingerprint?: string;
  /** Full immutable container ID. Names and short IDs are not accepted. */
  readonly runtimeId: string;
  /** Trusted host directory for bounded Docker copy transport files. */
  readonly hostTransportRoot: string;
  readonly authority: ContainerStateMutationAuthority;
  readonly engineAuthorityStore: PersistedEngineAuthorityStore;
  readonly lifecycleStore: PersistedEngineLifecycleStore;
  /** Provider-native Go-template field for the full immutable runtime ID. */
  readonly runtimeIdInspectField?: "Id" | "ID";
  /** Provider-native inspect value proving a private PID namespace. */
  readonly privatePidMode?: string;
  /** Provider-owned label proving that the runtime belongs to OpenShell. */
  readonly managedLabelKey?: string;
  readonly managedLabelValue?: string;
  /** Provider-owned normalization for one logical mount reported as multiple inspect rows. */
  readonly normalizeInspectionMounts?: (
    mounts: readonly unknown[],
    runtimeId: string,
  ) => readonly unknown[];
}

export type DockerStateMutationOwnerOptions = Omit<
  ContainerStateMutationOwnerOptions,
  "providerId" | "providerDisplayName" | "engineOperation" | "authority"
> & {
  readonly authority: DockerOperationAuthority;
};

export interface DockerStateMutationSurfaceOptions {
  /** Test seam for the fixed Docker executable; production uses the real capture adapter. */
  readonly capture?: ContainerEngineCommandCapture;
  readonly resolveStateDir?: (environment: NodeJS.ProcessEnv) => string;
  /** Test seam for the shared per-sandbox direct-execution exclusion. */
  readonly withDirectSandboxExecutionExclusion?: <T>(
    sandboxName: string,
    operation: string,
    fn: () => T,
  ) => T;
}

export interface ContainerStateMutationSurfaceOptions {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly engineOperation: ContainerEngineOperationScope;
  readonly createAuthority: (
    input: RuntimeProviderStateMutationContext,
  ) => ContainerStateMutationAuthority;
  readonly runtimeIdInspectField?: "Id" | "ID";
  readonly privatePidMode?: string;
  readonly managedLabelKey?: string;
  readonly managedLabelValue?: string;
  readonly normalizeInspectionMounts?: (
    mounts: readonly unknown[],
    runtimeId: string,
  ) => readonly unknown[];
  readonly resolveStateDir?: (environment: NodeJS.ProcessEnv) => string;
  readonly withDirectSandboxExecutionExclusion?: <T>(
    sandboxName: string,
    operation: string,
    fn: () => T,
  ) => T;
}

function resolveContainerStateMutationStateDir(environment: NodeJS.ProcessEnv): string {
  if (
    environment.VITEST === "true" &&
    (environment.HOME ?? "") === environment.NEMOCLAW_TEST_BASE_HOME &&
    environment.NEMOCLAW_TEST_STATE_DIR &&
    path.isAbsolute(environment.NEMOCLAW_TEST_STATE_DIR)
  ) {
    return environment.NEMOCLAW_TEST_STATE_DIR;
  }
  return resolveShieldsStateDir(environment.HOME?.trim() || undefined);
}

export interface ContainerStateMutationOwner {
  acquire(
    input: RuntimeProviderStateMutationContext & {
      readonly plan: RuntimeProviderPreparedStateMutationPlan;
    },
  ): RuntimeProviderStateMutationFence;
  assertFenced(
    input: RuntimeProviderStateMutationContext,
    fence: RuntimeProviderStateMutationFence,
  ): void;
  publish(
    input: RuntimeProviderStateMutationContext,
    fence: RuntimeProviderStateMutationFence,
  ): void;
  recover(input: RuntimeProviderStateMutationContext): RuntimeProviderStateMutationFence | null;
  /** Restore the plan's fixed rollback posture while retaining the exact fence. */
  rollback(
    input: RuntimeProviderStateMutationContext,
    fence: RuntimeProviderStateMutationFence,
  ): void;
  activate(
    input: RuntimeProviderStateMutationContext,
    fence: RuntimeProviderStateMutationFence,
  ): RuntimeProviderStateMutationActivationProof;
  release(
    input: RuntimeProviderStateMutationContext,
    fence: RuntimeProviderStateMutationFence,
    proof: RuntimeProviderStateMutationActivationProof,
    completedLedgerSha256: string,
  ): void;
}

export type DockerStateMutationOwner = ContainerStateMutationOwner;

function fail(message: string): never {
  throw new Error(`Runtime provider state mutation failed: ${message}`);
}

function providerHandlePattern(providerId: string): RegExp {
  return new RegExp(`^${providerId}-state-mutation-v1:([a-f0-9]{64}):([a-f0-9]{64})$`, "u");
}

function activationProviderHandlePattern(providerId: string): RegExp {
  return new RegExp(
    `^${providerId}-state-mutation-activation-v1:([a-f0-9]{64}):([a-f0-9]{64})$`,
    "u",
  );
}

function operationBindingSha256(engine: ContainerEngine): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: engine.operation,
        engineId: engine.engineId,
        authorityId: engine.authorityId,
      }),
    )
    .digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const ordered = [...expected].sort();
  if (actual.length !== ordered.length || actual.some((key, index) => key !== ordered[index])) {
    fail(`${label} schema is unsupported`);
  }
}

function boundedString(value: unknown, pattern: RegExp, label: string, maxBytes = 4096): string {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail(`${label} is malformed`);
  }
  return value;
}

function exactText(value: unknown, label: string, maxBytes = 16 * 1024): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail(`${label} is malformed`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRecord(fields: readonly (readonly [string, unknown])[]): string {
  const transport: Record<string, unknown> = Object.create(null);
  for (const [key, value] of fields) transport[key] = value;
  return JSON.stringify(transport);
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  const candidate = exactText(value, label, 4096);
  if (
    candidate.length === 0 ||
    !candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("\\") ||
    path.posix.normalize(candidate) !== candidate
  ) {
    fail(`${label} is not a canonical absolute path`);
  }
  return candidate;
}

function canonicalStateRoot(value: unknown): string {
  const stateRoot = canonicalAbsolutePath(value, "state root");
  if (!stateRoot.startsWith("/sandbox/")) fail("state root is outside /sandbox");
  if (stateRoot !== SUPPORTED_STATE_ROOT) {
    fail("state root is unsupported by the runtime-provider helper");
  }
  return stateRoot;
}

function exactOptionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return exactText(value, label);
}

function parseMount(value: unknown, index: number): DockerMountIdentity {
  const source = record(value, `container mount ${String(index)}`);
  const type = exactText(source.Type, `container mount ${String(index)} type`, 128);
  const mountSource = exactText(source.Source, `container mount ${String(index)} source`);
  const destination = canonicalAbsolutePath(
    source.Destination,
    `container mount ${String(index)} destination`,
  );
  const name = exactOptionalText(source.Name, `container mount ${String(index)} name`);
  const driver = exactOptionalText(source.Driver, `container mount ${String(index)} driver`);
  const mode = exactText(source.Mode, `container mount ${String(index)} mode`, 1024);
  const propagation = exactText(
    source.Propagation,
    `container mount ${String(index)} propagation`,
    1024,
  );
  if (type.length === 0 || mountSource.length === 0 || typeof source.RW !== "boolean") {
    fail(`container mount ${String(index)} is malformed`);
  }
  return Object.freeze({
    type,
    source: mountSource,
    name,
    destination,
    driver,
    mode,
    readWrite: source.RW,
    propagation,
  });
}

function mountTransport(mount: DockerMountIdentity): Record<string, unknown> {
  const transport: Record<string, unknown> = Object.create(null);
  transport.type = mount.type;
  transport.source = mount.source;
  transport.name = mount.name;
  transport.destination = mount.destination;
  transport.driver = mount.driver;
  transport.mode = mount.mode;
  transport.readWrite = mount.readWrite;
  transport.propagation = mount.propagation;
  return transport;
}

function mountsSha256(mounts: readonly DockerMountIdentity[]): string {
  const transport = mounts.map(mountTransport);
  Object.setPrototypeOf(transport, null);
  return sha256(JSON.stringify(transport));
}

function isPathAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function bindStateRoot(
  observation: DockerRuntimeObservation,
  stateRootInput: unknown,
): DockerStateRootBinding {
  const stateRoot = canonicalStateRoot(stateRootInput);
  const owners = observation.mounts.filter((mount) =>
    isPathAtOrBelow(stateRoot, mount.destination),
  );
  if (owners.length === 0) {
    fail(`state root has no durable ${observation.providerDisplayName} mount`);
  }
  const deepestLength = Math.max(...owners.map((mount) => mount.destination.length));
  const deepest = owners.filter((mount) => mount.destination.length === deepestLength);
  if (deepest.length !== 1 || !["bind", "volume"].includes(deepest[0]?.type ?? "")) {
    fail(`state root ${observation.providerDisplayName} mount is ambiguous or not durable`);
  }
  if (!deepest[0]?.readWrite) {
    fail(`state root ${observation.providerDisplayName} mount is not writable`);
  }
  const related = observation.mounts.filter(
    (mount) =>
      isPathAtOrBelow(stateRoot, mount.destination) ||
      isPathAtOrBelow(mount.destination, stateRoot),
  );
  return Object.freeze({ stateRoot, stateRootMountsSha256: mountsSha256(related) });
}

function parseInspection(
  output: string,
  expectedRuntimeId: string,
  expectedSandboxName: string,
  providerDisplayName: string,
  expectedPrivatePidMode: string,
  expectedManagedLabelValue: string,
  normalizeMounts: (mounts: readonly unknown[], runtimeId: string) => readonly unknown[],
): DockerRuntimeObservation {
  if (
    output.length === 0 ||
    Buffer.byteLength(output, "utf8") > MAX_INSPECTION_BYTES ||
    output.includes("\0")
  ) {
    fail(`${providerDisplayName} container inspection output is empty or too large`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`${providerDisplayName} container inspection returned unreadable JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 13) {
    fail(`${providerDisplayName} container inspection schema is unsupported`);
  }
  const [
    runtimeIdInput,
    running,
    status,
    paused,
    restarting,
    dead,
    runtimePid,
    managedBy,
    sandboxName,
    sandboxIdInput,
    pidMode,
    privileged,
    mountsInput,
  ] = parsed;
  const runtimeId = boundedString(
    runtimeIdInput,
    CONTAINER_ID,
    `${providerDisplayName} container identity`,
  );
  if (runtimeId !== expectedRuntimeId) fail(`${providerDisplayName} container identity changed`);
  if (
    running !== true ||
    status !== "running" ||
    paused !== false ||
    restarting !== false ||
    dead !== false ||
    !Number.isSafeInteger(runtimePid) ||
    (runtimePid as number) <= 0
  ) {
    fail(`${providerDisplayName} container is not one stable running runtime`);
  }
  if (managedBy !== expectedManagedLabelValue || sandboxName !== expectedSandboxName) {
    fail(`${providerDisplayName} container does not belong to the exact OpenShell sandbox`);
  }
  if (pidMode !== expectedPrivatePidMode || privileged !== false) {
    fail(`${providerDisplayName} container does not have one private unprivileged PID namespace`);
  }
  const sandboxId = exactText(sandboxIdInput, "OpenShell sandbox identity", 512);
  if (sandboxId.length === 0) fail("OpenShell sandbox identity is missing");
  if (!Array.isArray(mountsInput) || mountsInput.length > MAX_MOUNTS) {
    fail(`${providerDisplayName} container mounts are malformed`);
  }
  const mounts = normalizeMounts(mountsInput, runtimeId)
    .map(parseMount)
    .sort((left, right) =>
      left.destination < right.destination
        ? -1
        : left.destination > right.destination
          ? 1
          : left.source.localeCompare(right.source),
    );
  if (new Set(mounts.map((mount) => mount.destination)).size !== mounts.length) {
    fail(`${providerDisplayName} container has ambiguous mount destinations`);
  }
  if (
    mounts.some(
      (mount) =>
        mount.destination === "/" ||
        mount.destination === "/proc" ||
        mount.destination.startsWith("/proc/"),
    )
  ) {
    fail(`${providerDisplayName} container overlays the trusted private procfs`);
  }
  const sandboxIdentitySha256 = sha256(sandboxId);
  return Object.freeze({
    providerDisplayName,
    runtimeId,
    runtimePid: runtimePid as number,
    pidMode: expectedPrivatePidMode,
    privileged: false,
    sandboxIdentitySha256,
    containerMountsSha256: mountsSha256(mounts),
    mounts: Object.freeze(mounts),
  });
}

function exactPosture(
  value: unknown,
  label: string,
): RuntimeProviderStateMutationProtectionPosture {
  if (value !== "locked" && value !== "mutable") fail(`${label} is malformed`);
  return value;
}

function parseHelperReceipt(
  output: string,
  expectedProviderId: string,
): DockerStateMutationHelperReceipt {
  if (
    output.length === 0 ||
    !output.endsWith("\n") ||
    output.slice(0, -1).includes("\n") ||
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") > MAX_HELPER_TRANSPORT_BYTES
  ) {
    fail("root helper returned an invalid bounded receipt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("root helper returned unreadable JSON");
  }
  const receipt = record(parsed, "root helper receipt");
  const activationFields =
    receipt.phase === "activation-proven"
      ? ["activationProviderHandle", "configurationGeneration", "healthSha256", "listenerIdentity"]
      : [];
  exactKeys(
    receipt,
    [
      "containerMountsSha256",
      "engineBindingSha256",
      "lifecycleGeneration",
      "mountNamespace",
      "nonce",
      "phase",
      "planSha256",
      "projectionSha256",
      "providerId",
      "rollback",
      "runtimeId",
      "runtimePid",
      "sandboxIdentitySha256",
      "sandboxName",
      "schemaVersion",
      "stateRoot",
      "stateRootDevice",
      "stateRootInode",
      "stateRootMountsSha256",
      "target",
      "transactionId",
      ...activationFields,
    ],
    "root helper receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    (receipt.phase !== "fenced" &&
      receipt.phase !== "published" &&
      receipt.phase !== "rolled-back" &&
      receipt.phase !== "activation-proven")
  ) {
    fail("root helper receipt version or phase is unsupported");
  }
  if (!Number.isSafeInteger(receipt.runtimePid) || (receipt.runtimePid as number) <= 0) {
    fail("root helper runtime PID is malformed");
  }
  const activation =
    receipt.phase === "activation-proven"
      ? {
          configurationGeneration: boundedString(
            receipt.configurationGeneration,
            LIFECYCLE_GENERATION,
            "helper configuration generation",
          ),
          listenerIdentity: boundedString(
            receipt.listenerIdentity,
            LIFECYCLE_GENERATION,
            "helper listener identity",
          ),
          healthSha256: boundedString(receipt.healthSha256, SHA256, "helper health digest"),
          activationProviderHandle: boundedString(
            receipt.activationProviderHandle,
            activationProviderHandlePattern(expectedProviderId),
            "helper activation provider handle",
          ),
        }
      : {};
  const normalized = Object.freeze({
    schemaVersion: 1,
    phase: receipt.phase,
    transactionId: boundedString(receipt.transactionId, SHA256, "helper transaction identity"),
    providerId: boundedString(receipt.providerId, SAFE_NAME, "helper provider identity"),
    sandboxName: boundedString(receipt.sandboxName, SAFE_NAME, "helper sandbox name"),
    lifecycleGeneration: boundedString(
      receipt.lifecycleGeneration,
      LIFECYCLE_GENERATION,
      "helper lifecycle generation",
    ),
    engineBindingSha256: boundedString(
      receipt.engineBindingSha256,
      SHA256,
      "helper engine binding digest",
    ),
    runtimeId: boundedString(receipt.runtimeId, CONTAINER_ID, "helper runtime identity"),
    runtimePid: receipt.runtimePid as number,
    sandboxIdentitySha256: boundedString(
      receipt.sandboxIdentitySha256,
      SHA256,
      "helper sandbox identity digest",
    ),
    containerMountsSha256: boundedString(
      receipt.containerMountsSha256,
      SHA256,
      "helper container mounts digest",
    ),
    stateRoot: canonicalStateRoot(receipt.stateRoot),
    stateRootMountsSha256: boundedString(
      receipt.stateRootMountsSha256,
      SHA256,
      "helper state root mounts digest",
    ),
    mountNamespace: boundedString(
      receipt.mountNamespace,
      MOUNT_NAMESPACE,
      "helper mount namespace",
    ),
    stateRootDevice: boundedString(
      receipt.stateRootDevice,
      POSITIVE_DECIMAL,
      "helper state root device",
    ),
    stateRootInode: boundedString(
      receipt.stateRootInode,
      POSITIVE_DECIMAL,
      "helper state root inode",
    ),
    planSha256: boundedString(receipt.planSha256, SHA256, "helper plan digest"),
    projectionSha256: boundedString(receipt.projectionSha256, SHA256, "helper projection digest"),
    nonce: boundedString(receipt.nonce, SHA256, "helper nonce"),
    target: exactPosture(receipt.target, "helper target posture"),
    rollback: exactPosture(receipt.rollback, "helper rollback posture"),
    ...activation,
  });
  if (normalized.providerId !== expectedProviderId) {
    fail("root helper receipt changed the provider identity");
  }
  if (output !== `${fullReceiptTransport(normalized)}\n`) {
    fail("root helper receipt is not canonical");
  }
  return normalized;
}

function receiptTransport(receipt: DockerStateMutationHelperReceipt): string {
  return canonicalRecord([
    ["schemaVersion", receipt.schemaVersion],
    ["phase", receipt.phase],
    ["transactionId", receipt.transactionId],
    ["providerId", receipt.providerId],
    ["sandboxName", receipt.sandboxName],
    ["lifecycleGeneration", receipt.lifecycleGeneration],
    ["engineBindingSha256", receipt.engineBindingSha256],
    ["runtimeId", receipt.runtimeId],
    ["runtimePid", receipt.runtimePid],
    ["sandboxIdentitySha256", receipt.sandboxIdentitySha256],
    ["containerMountsSha256", receipt.containerMountsSha256],
    ["stateRoot", receipt.stateRoot],
    ["stateRootMountsSha256", receipt.stateRootMountsSha256],
    ["mountNamespace", receipt.mountNamespace],
    ["stateRootDevice", receipt.stateRootDevice],
    ["stateRootInode", receipt.stateRootInode],
    ["planSha256", receipt.planSha256],
    ["projectionSha256", receipt.projectionSha256],
    ["nonce", receipt.nonce],
    ["target", receipt.target],
    ["rollback", receipt.rollback],
  ]);
}

function fullReceiptTransport(receipt: DockerStateMutationHelperReceipt): string {
  const base = JSON.parse(receiptTransport(receipt)) as Record<string, unknown>;
  if (receipt.phase === "activation-proven") {
    base.configurationGeneration = receipt.configurationGeneration;
    base.listenerIdentity = receipt.listenerIdentity;
    base.healthSha256 = receipt.healthSha256;
    base.activationProviderHandle = receipt.activationProviderHandle;
  }
  return JSON.stringify(base);
}

function receiptWithPhase(
  receipt: DockerStateMutationHelperReceipt,
  phase: HelperPhase,
): DockerStateMutationHelperReceipt {
  return Object.freeze({ ...receipt, phase });
}

function providerHandle(receipt: DockerStateMutationHelperReceipt): string {
  return `${receipt.providerId}-state-mutation-v1:${receipt.transactionId}:${sha256(receiptTransport(receipt))}`;
}

function activationProviderHandleFor(
  evidence: Pick<
    RuntimeProviderStateMutationActivationProof,
    | "providerId"
    | "sandboxName"
    | "lifecycleGeneration"
    | "runtimeId"
    | "nonce"
    | "configurationGeneration"
    | "listenerIdentity"
    | "healthSha256"
  >,
  transactionId: string,
  fenceProviderHandle: string,
): string {
  const digest = sha256(
    canonicalRecord([
      ["schemaVersion", 1],
      ["providerId", evidence.providerId],
      ["sandboxName", evidence.sandboxName],
      ["lifecycleGeneration", evidence.lifecycleGeneration],
      ["runtimeId", evidence.runtimeId],
      ["nonce", evidence.nonce],
      ["configurationGeneration", evidence.configurationGeneration],
      ["listenerIdentity", evidence.listenerIdentity],
      ["healthSha256", evidence.healthSha256],
      ["fenceProviderHandle", fenceProviderHandle],
    ]),
  );
  return `${evidence.providerId}-state-mutation-activation-v1:${transactionId}:${digest}`;
}

function expectedActivationProviderHandle(
  receipt: DockerStateMutationHelperReceipt,
  fenceProviderHandle: string,
): string {
  if (
    receipt.phase !== "activation-proven" ||
    receipt.configurationGeneration === undefined ||
    receipt.listenerIdentity === undefined ||
    receipt.healthSha256 === undefined
  ) {
    fail("root helper did not return complete activation evidence");
  }
  return activationProviderHandleFor(
    {
      providerId: receipt.providerId,
      sandboxName: receipt.sandboxName,
      lifecycleGeneration: receipt.lifecycleGeneration,
      runtimeId: receipt.runtimeId,
      nonce: receipt.nonce,
      configurationGeneration: receipt.configurationGeneration,
      listenerIdentity: receipt.listenerIdentity,
      healthSha256: receipt.healthSha256,
    },
    receipt.transactionId,
    fenceProviderHandle,
  );
}

function activationProofFromReceipt(
  receipt: DockerStateMutationHelperReceipt,
  fenceProviderHandle: string,
): RuntimeProviderStateMutationActivationProof {
  const expected = expectedActivationProviderHandle(receipt, fenceProviderHandle);
  if (receipt.activationProviderHandle !== expected) {
    fail("root helper activation provider handle is not bound to the exact fence");
  }
  const normalized = Object.freeze({
    schemaVersion: 1,
    providerId: receipt.providerId,
    sandboxName: receipt.sandboxName,
    lifecycleGeneration: receipt.lifecycleGeneration,
    runtimeId: receipt.runtimeId,
    nonce: receipt.nonce,
    configurationGeneration: receipt.configurationGeneration as string,
    listenerIdentity: receipt.listenerIdentity as string,
    healthSha256: receipt.healthSha256 as string,
    providerHandle: expected,
  });
  return normalized;
}

function normalizeActivationProof(
  proof: RuntimeProviderStateMutationActivationProof,
  fence: RuntimeProviderStateMutationFence,
): RuntimeProviderStateMutationActivationProof {
  const source = record(proof, "state mutation activation proof");
  exactKeys(
    source,
    [
      "configurationGeneration",
      "healthSha256",
      "lifecycleGeneration",
      "listenerIdentity",
      "nonce",
      "providerHandle",
      "providerId",
      "runtimeId",
      "sandboxName",
      "schemaVersion",
    ],
    "state mutation activation proof",
  );
  const handle =
    typeof proof.providerHandle === "string"
      ? proof.providerHandle.match(activationProviderHandlePattern(fence.providerId))
      : null;
  if (
    proof.schemaVersion !== 1 ||
    proof.providerId !== fence.providerId ||
    proof.sandboxName !== fence.sandboxName ||
    proof.lifecycleGeneration !== fence.lifecycleGeneration ||
    proof.runtimeId !== fence.runtimeId ||
    proof.nonce !== fence.nonce ||
    !handle ||
    handle[1] !== fence.transactionId
  ) {
    fail("activation proof does not match the exact state mutation fence");
  }
  const normalized = Object.freeze({
    schemaVersion: 1,
    providerId: fence.providerId,
    sandboxName: fence.sandboxName,
    lifecycleGeneration: fence.lifecycleGeneration,
    runtimeId: fence.runtimeId,
    nonce: fence.nonce,
    configurationGeneration: boundedString(
      proof.configurationGeneration,
      LIFECYCLE_GENERATION,
      "activation configuration generation",
    ),
    listenerIdentity: boundedString(
      proof.listenerIdentity,
      LIFECYCLE_GENERATION,
      "activation listener identity",
    ),
    healthSha256: boundedString(proof.healthSha256, SHA256, "activation health digest"),
    providerHandle: boundedString(
      proof.providerHandle,
      activationProviderHandlePattern(fence.providerId),
      "activation provider handle",
    ),
  });
  if (
    normalized.providerHandle !==
    activationProviderHandleFor(normalized, fence.transactionId, fence.providerHandle)
  ) {
    fail("activation proof provider handle is not bound to the exact fence");
  }
  return normalized;
}

function runtimeStateSha256(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  observation: DockerRuntimeObservation,
  stateRoot: DockerStateRootBinding,
): string {
  return sha256(
    canonicalRecord([
      ["schemaVersion", 1],
      ["providerId", options.providerId],
      ["sandboxName", options.sandboxName],
      ["lifecycleGeneration", options.lifecycleGeneration],
      ["engineBindingSha256", bindingSha256],
      ["runtimeId", observation.runtimeId],
      ["runtimePid", observation.runtimePid],
      ["sandboxIdentitySha256", observation.sandboxIdentitySha256],
      ["containerMountsSha256", observation.containerMountsSha256],
      ["stateRoot", stateRoot.stateRoot],
      ["stateRootMountsSha256", stateRoot.stateRootMountsSha256],
    ]),
  );
}

function transactionId(
  runtimeStateDigest: string,
  planSha256: string,
  projectionSha256: string,
  nonce: string,
  target: RuntimeProviderStateMutationProtectionPosture,
  rollback: RuntimeProviderStateMutationProtectionPosture,
): string {
  return sha256(
    canonicalRecord([
      ["schemaVersion", 1],
      ["action", "state-mutation"],
      ["runtimeStateSha256", runtimeStateDigest],
      ["planSha256", planSha256],
      ["projectionSha256", projectionSha256],
      ["nonce", nonce],
      ["target", target],
      ["rollback", rollback],
    ]),
  );
}

function requireContext(
  options: ContainerStateMutationOwnerOptions,
  input: RuntimeProviderStateMutationContext,
): void {
  if (
    input.sandboxName !== options.sandboxName ||
    input.sandbox.name !== options.sandboxName ||
    input.sandbox.openshellDriver !== options.providerId
  ) {
    fail("sandbox provider identity changed");
  }
  if (input.sandbox.lifecycleGeneration !== options.lifecycleGeneration) {
    fail("sandbox lifecycle generation changed");
  }
  if (input.sandbox.lifecycleLiveIdentityFingerprint !== options.lifecycleLiveIdentityFingerprint) {
    fail("sandbox live identity authority changed");
  }
}

function requireRegistryLiveIdentity(
  options: ContainerStateMutationOwnerOptions,
  observation: DockerRuntimeObservation,
): void {
  const expected = options.lifecycleLiveIdentityFingerprint;
  if (expected === undefined) return;
  boundedString(expected, SHA256, "sandbox live identity fingerprint");
  if (observation.sandboxIdentitySha256 !== expected) {
    fail(
      `${options.providerDisplayName} sandbox identity does not match the registered live identity`,
    );
  }
}

function requireCurrentEngineAuthority(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
): void {
  options.authority.assertAuthority();
  const persisted = options.engineAuthorityStore.load(options.engineOperation);
  if (!persisted) fail(`persisted ${options.engineOperation} engine authority is missing`);
  requirePersistedEngineAuthority(
    persisted,
    options.providerId,
    options.authority.engine,
    bindingSha256,
  );
}

function inspectCommand(
  runtimeId: string,
  runtimeIdField: "Id" | "ID" = "Id",
  managedLabelKey = DEFAULT_MANAGED_LABEL_KEY,
) {
  boundedString(managedLabelKey, SAFE_LABEL_KEY, "managed runtime label key");
  const format =
    `[{{json .${runtimeIdField}}},{{json .State.Running}},{{json .State.Status}},` +
    `{{json .State.Paused}},{{json .State.Restarting}},{{json .State.Dead}},` +
    `{{json .State.Pid}},{{json (index .Config.Labels "${managedLabelKey}")}},` +
    '{{json (index .Config.Labels "openshell.ai/sandbox-name")}},' +
    '{{json (index .Config.Labels "openshell.ai/sandbox-id")}},' +
    "{{json .HostConfig.PidMode}},{{json .HostConfig.Privileged}},{{json .Mounts}}]";
  return Object.freeze({
    args: Object.freeze(["container", "inspect", "--format", format, runtimeId]),
    targetIndex: 4,
  });
}

type HelperTransportCapture = (
  command: PersistedEngineLifecycleExactCommand,
  timeoutMs: number,
) => ContainerEngineCommandResult;

function helperTransportSessionPath(transactionId: string): string {
  return `${HELPER_TRANSPORT_ROOT}/${transactionId}`;
}

function helperTransportBrokerCommand(
  runtimeId: string,
  transactionId: string,
): PersistedEngineLifecycleExactCommand {
  return Object.freeze({
    args: Object.freeze([
      "container",
      "exec",
      "--detach",
      "--user",
      "root",
      runtimeId,
      HELPER_PYTHON_PATH,
      "-I",
      HELPER_TRANSPORT_BROKER_PATH,
      transactionId,
    ]),
    targetIndex: 5,
  });
}

function helperTransportSessionAbsentCommand(
  runtimeId: string,
  transactionId: string,
): PersistedEngineLifecycleExactCommand {
  return Object.freeze({
    args: Object.freeze([
      "container",
      "exec",
      "--user",
      "root",
      runtimeId,
      HELPER_PYTHON_PATH,
      "-I",
      "-c",
      HELPER_TRANSPORT_SESSION_ABSENT_SCRIPT,
      helperTransportSessionPath(transactionId),
    ]),
    targetIndex: 4,
  });
}

function helperTransportCopyToCommand(
  runtimeId: string,
  hostPath: string,
  containerPath: string,
): PersistedEngineLifecycleExactCommand {
  return Object.freeze({
    args: Object.freeze(["container", "cp", hostPath, `${runtimeId}:${containerPath}`]),
    targetIndex: 3,
    targetPath: containerPath,
  });
}

function helperTransportCopyFromCommand(
  runtimeId: string,
  containerPath: string,
  hostPath: string,
): PersistedEngineLifecycleExactCommand {
  return Object.freeze({
    args: Object.freeze(["container", "cp", `${runtimeId}:${containerPath}`, hostPath]),
    targetIndex: 2,
    targetPath: containerPath,
  });
}

function helperTransportHostParent(hostRoot: string): string {
  const parent = path.join(hostRoot, "runtime-state-mutation-transport");
  fs.mkdirSync(parent, { mode: 0o700, recursive: true });
  const metadata = fs.lstatSync(parent);
  const expectedUid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (expectedUid !== undefined && metadata.uid !== expectedUid)
  ) {
    fail("host helper transport directory is not private");
  }
  return parent;
}

function withHelperTransportHostDirectory<T>(hostRoot: string, run: (root: string) => T): T {
  const temporary = fs.mkdtempSync(path.join(helperTransportHostParent(hostRoot), "operation-"));
  fs.chmodSync(temporary, 0o700);
  try {
    return run(temporary);
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

function writePrivateTransportFile(filePath: string, value: Buffer): void {
  // Docker can preserve the invoking host UID on copied files. The enclosing
  // transport directories remain private (0700), while this copy source must be
  // readable by the capability-restricted broker after publication.
  const descriptor = fs.openSync(filePath, "wx", 0o644);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readHelperTransportFile(
  capture: HelperTransportCapture,
  runtimeId: string,
  containerPath: string,
  hostRoot: string,
  timeoutMs: number,
  action: HelperAction | "startup",
): Buffer {
  return withHelperTransportHostDirectory(hostRoot, (temporary) => {
    const destination = path.join(temporary, "response");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) fail(`root helper ${action} transport response did not arrive`);
      fs.rmSync(destination, { force: true });
      const result = capture(
        helperTransportCopyFromCommand(runtimeId, containerPath, destination),
        Math.min(HELPER_TRANSPORT_COMMAND_TIMEOUT_MS, remainingMs),
      );
      if (!result.error && result.status === 0 && result.stderr.length === 0) {
        const value = fs.readFileSync(destination);
        if (value.byteLength > MAX_HELPER_TRANSPORT_BYTES) {
          fail(`root helper ${action} transport response exceeds its byte bound`);
        }
        return value;
      }
      const copyTimedOut =
        (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      if (Date.now() >= deadline) {
        fail(
          copyTimedOut
            ? `root helper ${action} transport response copy timed out`
            : `root helper ${action} transport response did not arrive`,
        );
      }
      Atomics.wait(helperTransportPoll, 0, 0, HELPER_TRANSPORT_POLL_MS);
    }
  });
}

function probeHelperTransport(
  capture: HelperTransportCapture,
  options: ContainerStateMutationOwnerOptions,
  transactionId: string,
): boolean {
  return withHelperTransportHostDirectory(options.hostTransportRoot, (temporary) => {
    const destination = path.join(temporary, "ready");
    const result = capture(
      helperTransportCopyFromCommand(
        options.runtimeId,
        `${helperTransportSessionPath(transactionId)}/ready`,
        destination,
      ),
      HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
    );
    if (result.error || result.status !== 0 || result.stderr.length !== 0) return false;
    const ready = fs.readFileSync(destination);
    if (ready.byteLength > MAX_HELPER_TRANSPORT_BYTES) {
      fail("root helper transport readiness response exceeds its byte bound");
    }
    return ready.equals(Buffer.from(`${transactionId}\n`, "ascii"));
  });
}

function ensureHelperTransportAuthorized(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
  transactionId: string,
): void {
  const capture: HelperTransportCapture = (command, timeoutMs) =>
    scope.captureExact("target", () => command, timeoutMs);
  if (probeHelperTransport(capture, options, transactionId)) return;
  requireCommandSuccess(
    capture(
      helperTransportBrokerCommand(options.runtimeId, transactionId),
      HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
    ),
    "root helper transport startup",
  );
  let ready: Buffer;
  try {
    ready = readHelperTransportFile(
      capture,
      options.runtimeId,
      `${helperTransportSessionPath(transactionId)}/ready`,
      options.hostTransportRoot,
      HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
      "startup",
    );
  } catch {
    fail("root helper transport did not become available");
  }
  if (!ready.equals(Buffer.from(`${transactionId}\n`, "ascii"))) {
    fail("root helper transport identity changed");
  }
}

function finishReleasedHelperTransport(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  transactionId: string,
): void {
  const capture: HelperTransportCapture = (command, timeoutMs) => {
    requireCurrentEngineAuthority(options, bindingSha256);
    const result = options.authority.engine.capture(command.args, timeoutMs);
    requireCurrentEngineAuthority(options, bindingSha256);
    return result;
  };
  const sessionAbsent = (): boolean => {
    const result = capture(
      helperTransportSessionAbsentCommand(options.runtimeId, transactionId),
      HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
    );
    if (result.error || result.stderr.length !== 0) {
      fail("root helper transport release cleanup verification failed");
    }
    if (result.status === 0) return true;
    if (result.status === HELPER_TRANSPORT_SESSION_PRESENT_STATUS) return false;
    fail("root helper transport release cleanup verification failed");
  };
  if (sessionAbsent()) return;
  if (!probeHelperTransport(capture, options, transactionId)) {
    fail("root helper transport release cleanup remains incomplete");
  }
  withHelperTransportHostDirectory(options.hostTransportRoot, (temporary) => {
    const resumed = path.join(temporary, "resumed");
    writePrivateTransportFile(resumed, Buffer.from(`${transactionId}\n`, "ascii"));
    requireCommandSuccess(
      capture(
        helperTransportCopyToCommand(
          options.runtimeId,
          resumed,
          `${helperTransportSessionPath(transactionId)}/resumed`,
        ),
        HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
      ),
      "root helper transport release finalization",
    );
  });
  const deadline = Date.now() + HELPER_TRANSPORT_COMMAND_TIMEOUT_MS;
  while (!sessionAbsent()) {
    if (Date.now() >= deadline) {
      fail("root helper transport release cleanup remains incomplete");
    }
    Atomics.wait(helperTransportPoll, 0, 0, HELPER_TRANSPORT_POLL_MS);
  }
}

function parseHelperTransportResult(
  value: Buffer,
  action: HelperAction,
  identity: string,
): ContainerEngineCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    fail("root helper transport response is malformed");
  }
  const response = record(parsed, "root helper transport response");
  exactKeys(
    response,
    ["schemaVersion", "action", "identity", "status", "stdout", "stderr"],
    "root helper transport response",
  );
  if (
    response.schemaVersion !== 1 ||
    response.action !== action ||
    response.identity !== identity ||
    !Number.isSafeInteger(response.status) ||
    (response.status as number) < 0 ||
    typeof response.stdout !== "string" ||
    typeof response.stderr !== "string" ||
    Buffer.byteLength(response.stdout, "utf8") > MAX_HELPER_TRANSPORT_BYTES ||
    Buffer.byteLength(response.stderr, "utf8") > MAX_HELPER_TRANSPORT_BYTES
  ) {
    fail("root helper transport response is malformed");
  }
  return {
    status: response.status as number,
    stdout: response.stdout,
    stderr: response.stderr,
  };
}

function helperFailureCode(stderr: string, action: HelperAction): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const failure = parsed as Record<string, unknown>;
  return failure.schemaVersion === 1 &&
    failure.action === action &&
    failure.status === "failed" &&
    typeof failure.code === "string" &&
    /^[a-z][a-z0-9-]{0,127}$/u.test(failure.code)
    ? failure.code
    : null;
}

function requireHelperSuccess(result: ContainerEngineCommandResult, action: HelperAction): string {
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    const code = helperFailureCode(result.stderr, action);
    fail(`root helper ${action} did not complete successfully${code ? `: ${code}` : ""}`);
  }
  return result.stdout;
}

function invokeHelperTransport(
  capture: HelperTransportCapture,
  options: ContainerStateMutationOwnerOptions,
  transactionId: string,
  action: HelperAction,
  input: Buffer,
): DockerStateMutationHelperReceipt {
  const identity = createHash("sha256").update(input).digest("hex");
  const sessionPath = helperTransportSessionPath(transactionId);
  const result = withHelperTransportHostDirectory(options.hostTransportRoot, (temporary) => {
    const request = path.join(temporary, "request");
    writePrivateTransportFile(request, input);
    requireCommandSuccess(
      capture(
        helperTransportCopyToCommand(
          options.runtimeId,
          request,
          `${sessionPath}/${identity}.${action}.incoming`,
        ),
        HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
      ),
      "root helper transport request publication",
    );
    const response = readHelperTransportFile(
      capture,
      options.runtimeId,
      `${sessionPath}/${identity}.response`,
      options.hostTransportRoot,
      helperTimeoutMs(action) + HELPER_TRANSPORT_RESPONSE_ALLOWANCE_MS,
      action,
    );
    const parsed = parseHelperTransportResult(response, action, identity);
    const acknowledgement = path.join(temporary, "ack");
    writePrivateTransportFile(acknowledgement, Buffer.from(`${identity}\n`, "ascii"));
    requireCommandSuccess(
      capture(
        helperTransportCopyToCommand(
          options.runtimeId,
          acknowledgement,
          `${sessionPath}/${identity}.ack`,
        ),
        HELPER_TRANSPORT_COMMAND_TIMEOUT_MS,
      ),
      "root helper transport response acknowledgement",
    );
    return parsed;
  });
  return parseHelperReceipt(requireHelperSuccess(result, action), options.providerId);
}

function supervisorSignalCommand(runtimeId: string, requestedSignal: "SIGSTOP" | "SIGCONT") {
  return Object.freeze({
    args: Object.freeze(["container", "kill", "--signal", requestedSignal, runtimeId]),
    targetIndex: 4,
  });
}

function signalSupervisorAuthorized(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
  requestedSignal: "SIGSTOP" | "SIGCONT",
): void {
  // PID-namespace init can only be stopped from an ancestor namespace. Keep
  // that one lifecycle operation on the authority-bound engine endpoint and
  // expose neither a caller-authored signal nor a caller-authored command.
  const result = scope.captureExact(
    "target",
    (runtimeId) => supervisorSignalCommand(runtimeId, requestedSignal),
    SUPERVISOR_SIGNAL_TIMEOUT_MS,
  );
  requireCommandSuccess(
    result,
    `${options.providerDisplayName} host supervisor ${requestedSignal === "SIGSTOP" ? "stop" : "resume"}`,
  );
}

function requireCommandSuccess(
  result: {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: Error;
  },
  label: string,
): string {
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    fail(`${label} did not complete successfully`);
  }
  return result.stdout;
}

function inspectDirect(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
): DockerRuntimeObservation {
  requireCurrentEngineAuthority(options, bindingSha256);
  const result = options.authority.engine.capture(
    inspectCommand(
      options.runtimeId,
      options.runtimeIdInspectField,
      options.managedLabelKey ?? DEFAULT_MANAGED_LABEL_KEY,
    ).args,
    INSPECT_TIMEOUT_MS,
  );
  requireCurrentEngineAuthority(options, bindingSha256);
  const observation = parseInspection(
    requireCommandSuccess(result, `${options.providerDisplayName} container inspection`),
    options.runtimeId,
    options.sandboxName,
    options.providerDisplayName,
    options.privatePidMode ?? "",
    options.managedLabelValue ?? DEFAULT_MANAGED_LABEL_VALUE,
    options.normalizeInspectionMounts ?? ((mounts) => mounts),
  );
  requireRegistryLiveIdentity(options, observation);
  return observation;
}

function inspectAuthorized(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
): DockerRuntimeObservation {
  const result = scope.captureExact(
    "target",
    (runtimeId) =>
      inspectCommand(
        runtimeId,
        options.runtimeIdInspectField,
        options.managedLabelKey ?? DEFAULT_MANAGED_LABEL_KEY,
      ),
    INSPECT_TIMEOUT_MS,
  );
  const observation = parseInspection(
    requireCommandSuccess(result, `${options.providerDisplayName} container inspection`),
    options.runtimeId,
    options.sandboxName,
    options.providerDisplayName,
    options.privatePidMode ?? "",
    options.managedLabelValue ?? DEFAULT_MANAGED_LABEL_VALUE,
    options.normalizeInspectionMounts ?? ((mounts) => mounts),
  );
  requireRegistryLiveIdentity(options, observation);
  return observation;
}

function sameObservation(
  expected: DockerRuntimeObservation,
  actual: DockerRuntimeObservation,
): void {
  if (
    expected.runtimeId !== actual.runtimeId ||
    expected.runtimePid !== actual.runtimePid ||
    expected.pidMode !== actual.pidMode ||
    expected.privileged !== actual.privileged ||
    expected.sandboxIdentitySha256 !== actual.sandboxIdentitySha256 ||
    expected.containerMountsSha256 !== actual.containerMountsSha256
  ) {
    fail(
      `${expected.providerDisplayName} runtime changed while the state mutation fence was established`,
    );
  }
}

function helperInput(fields: readonly (readonly [string, unknown])[]): Buffer {
  const serialized = `${canonicalRecord(fields)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HELPER_TRANSPORT_BYTES) {
    fail("root helper request exceeds its bounded transport");
  }
  return Buffer.from(serialized, "utf8");
}

function invokeHelperAuthorized(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
  action: HelperAction,
  input: Buffer,
): DockerStateMutationHelperReceipt {
  const capture: HelperTransportCapture = (command, timeoutMs) =>
    scope.captureExact("target", () => command, timeoutMs);
  return invokeHelperTransport(capture, options, scope.record.transactionId, action, input);
}

function lifecycleInput(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  record: Pick<
    PersistedEngineLifecycleRecord,
    "transactionId" | "sandboxName" | "resources" | "runtimeStateSha256"
  >,
): PersistedEngineLifecycleExecutionInput {
  return {
    transactionId: record.transactionId,
    action: "state-mutation",
    sandboxName: record.sandboxName,
    resources: record.resources,
    runtimeStateSha256: record.runtimeStateSha256,
    providerId: options.providerId,
    bindingSha256,
    engine: options.authority.engine,
    engineAuthorityStore: options.engineAuthorityStore,
    lifecycleStore: options.lifecycleStore,
  };
}

function normalizePreparedPlan(
  prepared: RuntimeProviderPreparedStateMutationPlan,
): RuntimeProviderPreparedStateMutationPlan & {
  readonly plan: Extract<
    RuntimeProviderPreparedStateMutationPlan["plan"],
    { intent: "protection-transition" }
  >;
} {
  const normalized = prepareRuntimeProviderStateMutationPlan(prepared.plan);
  if (
    prepared.serializedPlan !== normalized.serializedPlan ||
    prepared.planSha256 !== normalized.planSha256 ||
    prepared.projectionSha256 !== normalized.projectionSha256
  ) {
    fail("prepared state mutation plan changed after validation");
  }
  if (normalized.plan.intent !== "protection-transition") {
    fail("container state-mutation adapter does not implement restore publication");
  }
  if (normalized.plan.target === normalized.plan.rollback) {
    fail("protection transition target must differ from its rollback posture");
  }
  return normalized as RuntimeProviderPreparedStateMutationPlan & {
    readonly plan: Extract<
      RuntimeProviderPreparedStateMutationPlan["plan"],
      { intent: "protection-transition" }
    >;
  };
}

function preparedPlanFromPersistedIntent(
  intent: PersistedEngineStateMutationIntent,
): ReturnType<typeof normalizePreparedPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(intent.serializedPlan);
  } catch {
    fail("persisted state mutation plan is not valid JSON");
  }
  return normalizePreparedPlan({
    plan: parsed as RuntimeProviderPreparedStateMutationPlan["plan"],
    serializedPlan: intent.serializedPlan,
    planSha256: intent.planSha256,
    projectionSha256: intent.projectionSha256,
  });
}

function acquireRequest(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  observation: DockerRuntimeObservation,
  stateRoot: DockerStateRootBinding,
  plan: ReturnType<typeof normalizePreparedPlan>,
  nonce: string,
  exactTransactionId: string,
): Buffer {
  return helperInput([
    ["schemaVersion", 1],
    ["action", "acquire"],
    ["transactionId", exactTransactionId],
    ["providerId", options.providerId],
    ["sandboxName", options.sandboxName],
    ["lifecycleGeneration", options.lifecycleGeneration],
    ["engineBindingSha256", bindingSha256],
    ["runtimeId", observation.runtimeId],
    ["runtimePid", observation.runtimePid],
    ["sandboxIdentitySha256", observation.sandboxIdentitySha256],
    ["containerMountsSha256", observation.containerMountsSha256],
    ["stateRoot", stateRoot.stateRoot],
    ["stateRootMountsSha256", stateRoot.stateRootMountsSha256],
    ["plan", plan.serializedPlan],
    ["planSha256", plan.planSha256],
    ["projectionSha256", plan.projectionSha256],
    ["nonce", nonce],
    ["target", plan.plan.target],
    ["rollback", plan.plan.rollback],
  ]);
}

function statusRequest(
  action: Exclude<HelperAction, "acquire">,
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  observation: DockerRuntimeObservation,
  exactTransactionId: string,
  expectedProviderHandle?: string,
  activationProviderHandle?: string,
  completedLedgerSha256?: string,
): Buffer {
  return helperInput([
    ["schemaVersion", 1],
    ["action", action],
    ["transactionId", exactTransactionId],
    ["providerId", options.providerId],
    ["sandboxName", options.sandboxName],
    ["lifecycleGeneration", options.lifecycleGeneration],
    ["engineBindingSha256", bindingSha256],
    ["runtimeId", observation.runtimeId],
    ["runtimePid", observation.runtimePid],
    ["sandboxIdentitySha256", observation.sandboxIdentitySha256],
    ["containerMountsSha256", observation.containerMountsSha256],
    ...(expectedProviderHandle === undefined
      ? []
      : ([["providerHandle", expectedProviderHandle]] as const)),
    ...(activationProviderHandle === undefined
      ? []
      : ([["activationProviderHandle", activationProviderHandle]] as const)),
    ...(completedLedgerSha256 === undefined
      ? []
      : ([["completedLedgerSha256", completedLedgerSha256]] as const)),
  ]);
}

function validateReceipt(
  receipt: DockerStateMutationHelperReceipt,
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  observation: DockerRuntimeObservation,
  record: PersistedEngineLifecycleRecord,
): DockerStateRootBinding {
  const stateRoot = bindStateRoot(observation, receipt.stateRoot);
  if (
    receipt.providerId !== options.providerId ||
    receipt.sandboxName !== options.sandboxName ||
    receipt.lifecycleGeneration !== options.lifecycleGeneration ||
    receipt.engineBindingSha256 !== bindingSha256 ||
    receipt.runtimeId !== observation.runtimeId ||
    receipt.runtimePid !== observation.runtimePid ||
    receipt.sandboxIdentitySha256 !== observation.sandboxIdentitySha256 ||
    receipt.containerMountsSha256 !== observation.containerMountsSha256 ||
    receipt.stateRootMountsSha256 !== stateRoot.stateRootMountsSha256 ||
    receipt.target === receipt.rollback
  ) {
    fail(
      `root helper receipt does not match the exact ${options.providerDisplayName} runtime binding`,
    );
  }
  const expectedRuntimeState = runtimeStateSha256(options, bindingSha256, observation, stateRoot);
  const expectedTransactionId = transactionId(
    expectedRuntimeState,
    receipt.planSha256,
    receipt.projectionSha256,
    receipt.nonce,
    receipt.target,
    receipt.rollback,
  );
  const targetRuntime = record.resources.find((resource) => resource.role === "target")?.runtimeId;
  if (
    record.action !== "state-mutation" ||
    record.sandboxName !== options.sandboxName ||
    targetRuntime !== observation.runtimeId ||
    record.runtimeStateSha256 !== expectedRuntimeState ||
    record.transactionId !== expectedTransactionId ||
    receipt.transactionId !== expectedTransactionId
  ) {
    fail("root helper receipt does not match the durable lifecycle transaction");
  }
  return stateRoot;
}

function fenceFromReceipt(
  receipt: DockerStateMutationHelperReceipt,
  runtimeStateDigest: string,
  bindingSha256: string,
): RuntimeProviderStateMutationFence {
  const activeReceipt = receiptWithPhase(receipt, "fenced");
  return Object.freeze({
    schemaVersion: 1,
    intent: "protection-transition",
    phase: receipt.phase,
    providerId: receipt.providerId,
    sandboxName: receipt.sandboxName,
    transactionId: receipt.transactionId,
    lifecycleGeneration: receipt.lifecycleGeneration,
    runtimeId: receipt.runtimeId,
    runtimeStateSha256: runtimeStateDigest,
    engineBindingSha256: bindingSha256,
    stateRoot: receipt.stateRoot,
    mountNamespaceId: receipt.mountNamespace,
    stateRootDevice: receipt.stateRootDevice,
    stateRootInode: receipt.stateRootInode,
    planSha256: receipt.planSha256,
    projectionSha256: receipt.projectionSha256,
    target: receipt.target,
    rollback: receipt.rollback,
    nonce: receipt.nonce,
    providerHandle: providerHandle(activeReceipt),
  });
}

function normalizeFence(
  fence: RuntimeProviderStateMutationFence,
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
): RuntimeProviderStateMutationFence {
  const source = record(fence, "state mutation fence");
  exactKeys(
    source,
    [
      "intent",
      "lifecycleGeneration",
      "engineBindingSha256",
      "mountNamespaceId",
      "nonce",
      "phase",
      "planSha256",
      "projectionSha256",
      "providerHandle",
      "providerId",
      "runtimeId",
      "runtimeStateSha256",
      "rollback",
      "sandboxName",
      "schemaVersion",
      "stateRoot",
      "stateRootDevice",
      "stateRootInode",
      "target",
      "transactionId",
    ],
    "state mutation fence",
  );
  const handle =
    typeof fence.providerHandle === "string"
      ? fence.providerHandle.match(providerHandlePattern(options.providerId))
      : null;
  if (
    fence.schemaVersion !== 1 ||
    fence.intent !== "protection-transition" ||
    (fence.phase !== "fenced" &&
      fence.phase !== "published" &&
      fence.phase !== "rolled-back" &&
      fence.phase !== "activation-proven") ||
    fence.providerId !== options.providerId ||
    fence.sandboxName !== options.sandboxName ||
    fence.lifecycleGeneration !== options.lifecycleGeneration ||
    fence.runtimeId !== options.runtimeId ||
    fence.engineBindingSha256 !== bindingSha256 ||
    fence.transactionId !== handle?.[1] ||
    fence.target === fence.rollback ||
    !handle
  ) {
    fail(`state mutation fence does not match the bound ${options.providerDisplayName} runtime`);
  }
  return Object.freeze({
    ...fence,
    transactionId: boundedString(fence.transactionId, SHA256, "fence transaction identity"),
    runtimeId: boundedString(fence.runtimeId, CONTAINER_ID, "fence runtime identity"),
    runtimeStateSha256: boundedString(
      fence.runtimeStateSha256,
      SHA256,
      "fence runtime state digest",
    ),
    engineBindingSha256: boundedString(
      fence.engineBindingSha256,
      SHA256,
      "fence engine authority digest",
    ),
    stateRoot: canonicalStateRoot(fence.stateRoot),
    mountNamespaceId: boundedString(
      fence.mountNamespaceId,
      MOUNT_NAMESPACE,
      "fence mount namespace",
    ),
    stateRootDevice: boundedString(
      fence.stateRootDevice,
      POSITIVE_DECIMAL,
      "fence state root device",
    ),
    stateRootInode: boundedString(fence.stateRootInode, POSITIVE_DECIMAL, "fence state root inode"),
    planSha256: boundedString(fence.planSha256, SHA256, "fence plan digest"),
    projectionSha256: boundedString(fence.projectionSha256, SHA256, "fence projection digest"),
    target: exactPosture(fence.target, "fence target posture"),
    rollback: exactPosture(fence.rollback, "fence rollback posture"),
    nonce: boundedString(fence.nonce, SHA256, "fence nonce"),
  });
}

function requireFenceReceipt(
  fence: ReturnType<typeof normalizeFence>,
  receipt: DockerStateMutationHelperReceipt,
): void {
  const activeReceipt = receiptWithPhase(receipt, "fenced");
  if (
    fence.transactionId !== receipt.transactionId ||
    fence.runtimeId !== receipt.runtimeId ||
    fence.stateRoot !== receipt.stateRoot ||
    fence.mountNamespaceId !== receipt.mountNamespace ||
    fence.stateRootDevice !== receipt.stateRootDevice ||
    fence.stateRootInode !== receipt.stateRootInode ||
    fence.planSha256 !== receipt.planSha256 ||
    fence.projectionSha256 !== receipt.projectionSha256 ||
    fence.intent !== "protection-transition" ||
    fence.target !== receipt.target ||
    fence.rollback !== receipt.rollback ||
    fence.nonce !== receipt.nonce ||
    fence.providerHandle !== providerHandle(activeReceipt)
  ) {
    fail("state mutation fence does not match the root helper receipt");
  }
}

function unfinishedRecord(
  options: ContainerStateMutationOwnerOptions,
): PersistedEngineLifecycleRecord | null {
  const matches = options.lifecycleStore
    .listUnfinished()
    .filter(
      (record) => record.action === "state-mutation" && record.sandboxName === options.sandboxName,
    );
  if (matches.length > 1) fail("more than one state mutation owns the OpenShell sandbox");
  const match = matches[0];
  if (!match) return null;
  const targetRuntime = match.resources.find((resource) => resource.role === "target")?.runtimeId;
  if (targetRuntime !== options.runtimeId) {
    fail(
      `durable state mutation target does not match the exact labeled ${options.providerDisplayName} runtime`,
    );
  }
  return match;
}

function validateAcquireReceipt(
  receipt: DockerStateMutationHelperReceipt,
  plan: ReturnType<typeof normalizePreparedPlan>,
  nonce: string,
  expectedTransactionId: string,
): void {
  if (
    receipt.phase !== "fenced" ||
    receipt.transactionId !== expectedTransactionId ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.projectionSha256 !== plan.projectionSha256 ||
    receipt.nonce !== nonce ||
    receipt.stateRoot !== plan.plan.stateRoot ||
    receipt.target !== plan.plan.target ||
    receipt.rollback !== plan.plan.rollback
  ) {
    fail("root helper receipt changed the prepared state mutation plan");
  }
}

function acquireAuthorizedReceipt(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  plan: ReturnType<typeof normalizePreparedPlan>,
  nonce: string,
  exactTransactionId: string,
  expectedRuntimeStateSha256: string,
  expectedObservation?: DockerRuntimeObservation,
): DockerStateMutationHelperReceipt {
  const observation = inspectAuthorized(scope, options);
  if (expectedObservation) sameObservation(expectedObservation, observation);
  const stateRoot = bindStateRoot(observation, plan.plan.stateRoot);
  const observedRuntimeStateSha256 = runtimeStateSha256(
    options,
    bindingSha256,
    observation,
    stateRoot,
  );
  if (observedRuntimeStateSha256 !== expectedRuntimeStateSha256) {
    fail(
      `${options.providerDisplayName} runtime changed before the state mutation fence was established`,
    );
  }
  if (
    transactionId(
      observedRuntimeStateSha256,
      plan.planSha256,
      plan.projectionSha256,
      nonce,
      plan.plan.target,
      plan.plan.rollback,
    ) !== exactTransactionId
  ) {
    fail("persisted state mutation intent does not match the lifecycle transaction");
  }
  ensureHelperTransportAuthorized(scope, options, exactTransactionId);
  signalSupervisorAuthorized(scope, options, "SIGSTOP");
  const receipt = invokeHelperAuthorized(
    scope,
    options,
    "acquire",
    acquireRequest(options, bindingSha256, observation, stateRoot, plan, nonce, exactTransactionId),
  );
  validateAcquireReceipt(receipt, plan, nonce, exactTransactionId);
  validateReceipt(receipt, options, bindingSha256, observation, scope.record);
  const after = inspectAuthorized(scope, options);
  sameObservation(observation, after);
  return receipt;
}

function queryEstablishedReceipt(
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  execution: PersistedEngineLifecycleExecutionInput,
  action: "assert" | "publish" | "recover" | "rollback" | "activate",
  expectedFence?: RuntimeProviderStateMutationFence,
): DockerStateMutationHelperReceipt {
  assertActivePersistedEngineStateMutation(execution);
  const lease = options.lifecycleStore.acquireMutationExecution(execution.transactionId);
  try {
    const guard = () => {
      assertActivePersistedEngineStateMutation(execution);
      options.lifecycleStore.assertMutationExecution(lease);
      requireCurrentEngineAuthority(options, bindingSha256);
    };
    guard();
    const before = inspectDirect(options, bindingSha256);
    const currentRecord = executionRecord(execution);
    if (expectedFence) {
      const stateRoot = bindStateRoot(before, expectedFence.stateRoot);
      if (
        expectedFence.runtimeStateSha256 !== currentRecord.runtimeStateSha256 ||
        currentRecord.runtimeStateSha256 !==
          runtimeStateSha256(options, bindingSha256, before, stateRoot)
      ) {
        fail(
          `${options.providerDisplayName} runtime changed after the state mutation fence was established`,
        );
      }
    }
    guard();
    const request = statusRequest(
      action,
      options,
      bindingSha256,
      before,
      execution.transactionId,
      expectedFence?.providerHandle,
    );
    const result = invokeHelperTransport(
      (command, timeoutMs) => {
        guard();
        const captured = options.authority.engine.capture(command.args, timeoutMs);
        guard();
        return captured;
      },
      options,
      execution.transactionId,
      action,
      request,
    );
    guard();
    const receipt = result;
    validateReceipt(receipt, options, bindingSha256, before, currentRecord);
    if (expectedFence) requireFenceReceipt(expectedFence, receipt);
    const after = inspectDirect(options, bindingSha256);
    sameObservation(before, after);
    guard();
    return receipt;
  } finally {
    try {
      options.lifecycleStore.releaseMutationExecution(lease);
    } catch {
      // A recovered process can own the exact lease after this process fails.
    }
  }
}

function executionRecord(
  input: PersistedEngineLifecycleExecutionInput,
): PersistedEngineLifecycleRecord {
  const current = input.lifecycleStore.load(input.transactionId);
  if (!current) fail("durable state mutation transaction is missing");
  return current;
}

function requireRecordMatchesFence(
  record: PersistedEngineLifecycleRecord,
  fence: RuntimeProviderStateMutationFence,
  options: ContainerStateMutationOwnerOptions,
): void {
  const targetRuntime = record.resources.find((resource) => resource.role === "target")?.runtimeId;
  if (
    record.action !== "state-mutation" ||
    record.transactionId !== fence.transactionId ||
    record.sandboxName !== options.sandboxName ||
    targetRuntime !== fence.runtimeId ||
    record.runtimeStateSha256 !== fence.runtimeStateSha256
  ) {
    fail("state mutation fence does not match the durable lifecycle transaction");
  }
}

function sameActivationProof(
  expected: RuntimeProviderStateMutationActivationProof,
  actual: RuntimeProviderStateMutationActivationProof,
): void {
  const fields: ReadonlyArray<keyof RuntimeProviderStateMutationActivationProof> = [
    "schemaVersion",
    "providerId",
    "sandboxName",
    "lifecycleGeneration",
    "runtimeId",
    "nonce",
    "configurationGeneration",
    "listenerIdentity",
    "healthSha256",
    "providerHandle",
  ];
  if (fields.some((field) => expected[field] !== actual[field])) {
    fail("activation proof changed after provider validation");
  }
}

function releaseAuthorizedFence(
  scope: AuthorizedPersistedEngineLifecycle,
  options: ContainerStateMutationOwnerOptions,
  bindingSha256: string,
  fence: RuntimeProviderStateMutationFence,
  proof: RuntimeProviderStateMutationActivationProof,
  completedLedgerSha256: string,
): void {
  const before = inspectAuthorized(scope, options);
  const receipt = invokeHelperAuthorized(
    scope,
    options,
    "release",
    statusRequest(
      "release",
      options,
      bindingSha256,
      before,
      fence.transactionId,
      fence.providerHandle,
      proof.providerHandle,
      completedLedgerSha256,
    ),
  );
  validateReceipt(receipt, options, bindingSha256, before, scope.record);
  requireFenceReceipt(fence, receipt);
  sameActivationProof(proof, activationProofFromReceipt(receipt, fence.providerHandle));
  signalSupervisorAuthorized(scope, options, "SIGCONT");
  const after = inspectAuthorized(scope, options);
  sameObservation(before, after);
}

/**
 * Own one container provider's durable state-mutation fence without accepting
 * a shell command, helper path, runtime alias, or caller-authored receipt.
 */
export function createContainerStateMutationOwner(
  optionsInput: ContainerStateMutationOwnerOptions,
): ContainerStateMutationOwner {
  const options = Object.freeze({
    privatePidMode: "",
    runtimeIdInspectField: "Id" as const,
    ...optionsInput,
  });
  boundedString(options.providerId, PROVIDER_ID, "provider identity");
  boundedString(options.providerDisplayName, SAFE_NAME, "provider display name");
  boundedString(options.sandboxName, SAFE_NAME, "sandbox name");
  boundedString(options.lifecycleGeneration, LIFECYCLE_GENERATION, "lifecycle generation");
  if (options.lifecycleLiveIdentityFingerprint !== undefined) {
    boundedString(
      options.lifecycleLiveIdentityFingerprint,
      SHA256,
      "sandbox live identity fingerprint",
    );
  }
  boundedString(options.runtimeId, CONTAINER_ID, `${options.providerDisplayName} runtime identity`);
  if (
    options.authority.engine.operation !== options.engineOperation ||
    options.authority.engine.engineId !== options.providerId
  ) {
    fail(
      `${options.providerDisplayName} authority does not own ${options.engineOperation} operations`,
    );
  }
  const bindingSha256 = operationBindingSha256(options.authority.engine);

  const owner: ContainerStateMutationOwner = {
    acquire(input) {
      requireContext(options, input);
      if (
        options.lifecycleStore
          .listUnfinished()
          .some(
            (record) =>
              record.action === "state-mutation" && record.sandboxName === options.sandboxName,
          )
      ) {
        fail("OpenShell sandbox already has one unfinished state mutation");
      }
      const plan = normalizePreparedPlan(input.plan);
      options.authority.assertAuthority();
      options.engineAuthorityStore.record(
        createPersistedEngineAuthority(options.providerId, options.authority.engine, bindingSha256),
      );
      const before = inspectDirect(options, bindingSha256);
      const stateRoot = bindStateRoot(before, plan.plan.stateRoot);
      const runtimeStateDigest = runtimeStateSha256(options, bindingSha256, before, stateRoot);
      const nonce = randomBytes(32).toString("hex");
      const exactTransactionId = transactionId(
        runtimeStateDigest,
        plan.planSha256,
        plan.projectionSha256,
        nonce,
        plan.plan.target,
        plan.plan.rollback,
      );
      const execution = lifecycleInput(options, bindingSha256, {
        transactionId: exactTransactionId,
        sandboxName: options.sandboxName,
        resources: [{ role: "target", runtimeId: options.runtimeId }],
        runtimeStateSha256: runtimeStateDigest,
      });
      preparePersistedEngineLifecycle({
        ...execution,
        stateMutationIntent: {
          serializedPlan: plan.serializedPlan,
          planSha256: plan.planSha256,
          projectionSha256: plan.projectionSha256,
          nonce,
        },
      });
      const established = executePersistedEngineStateMutation(execution, (scope) =>
        acquireAuthorizedReceipt(
          scope,
          options,
          bindingSha256,
          plan,
          nonce,
          exactTransactionId,
          runtimeStateDigest,
          before,
        ),
      );
      return fenceFromReceipt(established.value, runtimeStateDigest, bindingSha256);
    },

    assertFenced(input, fenceInput) {
      requireContext(options, input);
      requireCurrentEngineAuthority(options, bindingSha256);
      const fence = normalizeFence(fenceInput, options, bindingSha256);
      const record = options.lifecycleStore.load(fence.transactionId);
      if (!record) fail("durable state mutation transaction is missing");
      requireRecordMatchesFence(record, fence, options);
      const execution = lifecycleInput(options, bindingSha256, record);
      queryEstablishedReceipt(options, bindingSha256, execution, "assert", fence);
    },

    publish(input, fenceInput) {
      requireContext(options, input);
      requireCurrentEngineAuthority(options, bindingSha256);
      const fence = normalizeFence(fenceInput, options, bindingSha256);
      const record = options.lifecycleStore.load(fence.transactionId);
      if (!record) fail("durable state mutation transaction is missing");
      requireRecordMatchesFence(record, fence, options);
      const receipt = queryEstablishedReceipt(
        options,
        bindingSha256,
        lifecycleInput(options, bindingSha256, record),
        "publish",
        fence,
      );
      if (receipt.phase !== "published") fail("root helper did not publish the target posture");
    },

    rollback(input, fenceInput) {
      requireContext(options, input);
      requireCurrentEngineAuthority(options, bindingSha256);
      const fence = normalizeFence(fenceInput, options, bindingSha256);
      const record = options.lifecycleStore.load(fence.transactionId);
      if (!record) fail("durable state mutation transaction is missing");
      requireRecordMatchesFence(record, fence, options);
      const receipt = queryEstablishedReceipt(
        options,
        bindingSha256,
        lifecycleInput(options, bindingSha256, record),
        "rollback",
        fence,
      );
      if (receipt.phase !== "rolled-back") fail("root helper did not restore rollback posture");
    },

    activate(input, fenceInput) {
      requireContext(options, input);
      requireCurrentEngineAuthority(options, bindingSha256);
      const fence = normalizeFence(fenceInput, options, bindingSha256);
      const record = options.lifecycleStore.load(fence.transactionId);
      if (!record) fail("durable state mutation transaction is missing");
      requireRecordMatchesFence(record, fence, options);
      const receipt = queryEstablishedReceipt(
        options,
        bindingSha256,
        lifecycleInput(options, bindingSha256, record),
        "activate",
        fence,
      );
      return activationProofFromReceipt(receipt, fence.providerHandle);
    },

    release(input, fenceInput, proofInput, completedLedgerSha256Input) {
      requireContext(options, input);
      requireCurrentEngineAuthority(options, bindingSha256);
      const fence = normalizeFence(fenceInput, options, bindingSha256);
      const proof = normalizeActivationProof(proofInput, fence);
      const completedLedgerSha256 = boundedString(
        completedLedgerSha256Input,
        SHA256,
        "completed ledger digest",
      );
      const record = options.lifecycleStore.load(fence.transactionId);
      if (!record) {
        if (options.lifecycleStore.isRetired(fence.transactionId, completedLedgerSha256)) return;
        fail("durable state mutation transaction is missing");
      }
      requireRecordMatchesFence(record, fence, options);
      const execution = lifecycleInput(options, bindingSha256, record);

      if (record.phase === "completed") {
        if (record.resultSha256 !== completedLedgerSha256) {
          fail("completed ledger digest changed after durable host completion");
        }
        const stillOwnsRuntime = options.lifecycleStore
          .listUnfinished()
          .some((candidate) => candidate.transactionId === record.transactionId);
        if (!stillOwnsRuntime) {
          if (
            options.lifecycleStore.isStateMutationReleaseFinalized(
              record.transactionId,
              completedLedgerSha256,
            )
          ) {
            finishReleasedHelperTransport(options, bindingSha256, record.transactionId);
            options.lifecycleStore.retire(record.transactionId, completedLedgerSha256);
            return;
          }
          fail("completed state mutation lost its provider release authority");
        }
        releaseCompletedPersistedEngineStateMutation(execution, (scope, completed) => {
          if (completed.resultSha256 !== completedLedgerSha256) {
            fail("completed ledger digest changed before provider release");
          }
          releaseAuthorizedFence(
            scope,
            options,
            bindingSha256,
            fence,
            proof,
            completedLedgerSha256,
          );
          finishReleasedHelperTransport(options, bindingSha256, record.transactionId);
        });
        options.lifecycleStore.retire(record.transactionId, completedLedgerSha256);
        return;
      }
      if (record.phase !== "fence-established") {
        fail("state mutation release requires one established provider fence");
      }

      let activatedProof: RuntimeProviderStateMutationActivationProof | undefined;
      completePersistedEngineStateMutation(
        execution,
        (scope) => {
          const before = inspectAuthorized(scope, options);
          const receipt = invokeHelperAuthorized(
            scope,
            options,
            "activate",
            statusRequest(
              "activate",
              options,
              bindingSha256,
              before,
              fence.transactionId,
              fence.providerHandle,
            ),
          );
          validateReceipt(receipt, options, bindingSha256, before, scope.record);
          requireFenceReceipt(fence, receipt);
          activatedProof = activationProofFromReceipt(receipt, fence.providerHandle);
          sameActivationProof(proof, activatedProof);
          const after = inspectAuthorized(scope, options);
          sameObservation(before, after);
          return { resultSha256: completedLedgerSha256, value: undefined };
        },
        (scope, completed) => {
          if (!activatedProof || completed.resultSha256 !== completedLedgerSha256) {
            fail("provider activation proof changed before release");
          }
          releaseAuthorizedFence(
            scope,
            options,
            bindingSha256,
            fence,
            activatedProof,
            completedLedgerSha256,
          );
          finishReleasedHelperTransport(options, bindingSha256, record.transactionId);
        },
      );
      options.lifecycleStore.retire(record.transactionId, completedLedgerSha256);
    },

    recover(input) {
      requireContext(options, input);
      const record = unfinishedRecord(options);
      if (!record) return null;
      requireCurrentEngineAuthority(options, bindingSha256);
      const execution = lifecycleInput(options, bindingSha256, record);
      let receipt: DockerStateMutationHelperReceipt;
      if (record.phase === "completed") {
        if (record.resultSha256 === null) fail("completed lifecycle receipt is malformed");
        releaseCompletedPersistedEngineStateMutation(execution, (scope, completed) => {
          const before = inspectAuthorized(scope, options);
          const recovered = invokeHelperAuthorized(
            scope,
            options,
            "recover",
            statusRequest("recover", options, bindingSha256, before, record.transactionId),
          );
          validateReceipt(recovered, options, bindingSha256, before, scope.record);
          const recoveredFence = fenceFromReceipt(
            recovered,
            record.runtimeStateSha256,
            bindingSha256,
          );
          const recoveredProof = activationProofFromReceipt(
            recovered,
            recoveredFence.providerHandle,
          );
          releaseAuthorizedFence(
            scope,
            options,
            bindingSha256,
            recoveredFence,
            recoveredProof,
            completed.resultSha256 as string,
          );
          finishReleasedHelperTransport(options, bindingSha256, record.transactionId);
        });
        options.lifecycleStore.retire(record.transactionId, record.resultSha256);
        return null;
      }
      if (record.phase === "fence-established") {
        receipt = queryEstablishedReceipt(options, bindingSha256, execution, "recover");
      } else {
        const intent = loadPersistedEngineStateMutationIntent(execution);
        const plan = preparedPlanFromPersistedIntent(intent);
        const nonce = boundedString(intent.nonce, SHA256, "persisted state mutation nonce");
        const established = executePersistedEngineStateMutation(execution, (scope) => {
          return acquireAuthorizedReceipt(
            scope,
            options,
            bindingSha256,
            plan,
            nonce,
            record.transactionId,
            record.runtimeStateSha256,
          );
        });
        receipt = established.value;
      }
      return fenceFromReceipt(receipt, record.runtimeStateSha256, bindingSha256);
    },
  };
  return Object.freeze(owner);
}

export function createDockerStateMutationOwner(
  options: DockerStateMutationOwnerOptions,
): DockerStateMutationOwner {
  return createContainerStateMutationOwner({
    ...options,
    providerId: DOCKER_PROVIDER_ID,
    providerDisplayName: "Docker",
    engineOperation: "sandbox-lifecycle",
  });
}

function lifecycleGeneration(input: RuntimeProviderStateMutationContext): string {
  return boundedString(
    input.sandbox.lifecycleGeneration,
    LIFECYCLE_GENERATION,
    "sandbox lifecycle generation",
  );
}

function requireSurfaceContext(
  input: RuntimeProviderStateMutationContext,
  providerId: string,
): void {
  const sandboxName = boundedString(input.sandboxName, SAFE_NAME, "sandbox name");
  if (
    input.sandbox.name !== sandboxName ||
    input.sandbox.openshellDriver !== providerId ||
    typeof input.environment !== "object" ||
    input.environment === null
  ) {
    fail("sandbox provider identity changed");
  }
  lifecycleGeneration(input);
}

function resolveExactLabeledRuntimeId(
  authority: ContainerStateMutationAuthority,
  sandboxName: string,
  providerDisplayName: string,
  managedLabelKey = DEFAULT_MANAGED_LABEL_KEY,
  managedLabelValue = DEFAULT_MANAGED_LABEL_VALUE,
): string {
  boundedString(managedLabelKey, SAFE_LABEL_KEY, "managed runtime label key");
  boundedString(managedLabelValue, SAFE_LABEL_VALUE, "managed runtime label value");
  const result = authority.engine.capture(
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${managedLabelKey}=${managedLabelValue}`,
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      RUNTIME_QUERY_FORMAT,
    ],
    INSPECT_TIMEOUT_MS,
  );
  const output = requireCommandSuccess(result, `${providerDisplayName} labeled runtime resolution`);
  if (Buffer.byteLength(output, "utf8") > 4096 || output.includes("\0") || output.includes("\r")) {
    fail(`${providerDisplayName} labeled runtime resolution returned malformed output`);
  }
  const ids = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ids.length !== 1 || !CONTAINER_ID.test(ids[0] as string)) {
    fail(
      `${providerDisplayName} labeled runtime resolution requires one exact full container identity`,
    );
  }
  authority.assertAuthority();
  return ids[0] as string;
}

function requireExistingSurfaceAuthority(
  authority: ContainerStateMutationAuthority,
  engineAuthorityStore: PersistedEngineAuthorityStore,
  options: ContainerStateMutationSurfaceOptions,
): void {
  authority.assertAuthority();
  const persisted = engineAuthorityStore.load(options.engineOperation);
  if (!persisted) fail(`persisted ${options.engineOperation} engine authority is missing`);
  requirePersistedEngineAuthority(
    persisted,
    options.providerId,
    authority.engine,
    operationBindingSha256(authority.engine),
  );
}

function createSurfaceOwnerOptions(
  input: RuntimeProviderStateMutationContext,
  options: ContainerStateMutationSurfaceOptions,
  phase: "acquire" | "existing",
): ContainerStateMutationOwnerOptions {
  requireSurfaceContext(input, options.providerId);

  const authority = options.createAuthority(input);
  const stateDir = (options.resolveStateDir ?? resolveContainerStateMutationStateDir)(
    input.environment,
  );
  const engineAuthorityStore = createFilePersistedEngineAuthorityStore(stateDir);
  if (phase === "existing") {
    requireExistingSurfaceAuthority(authority, engineAuthorityStore, options);
  }
  const runtimeId = resolveExactLabeledRuntimeId(
    authority,
    input.sandboxName,
    options.providerDisplayName,
    options.managedLabelKey,
    options.managedLabelValue,
  );
  return {
    providerId: options.providerId,
    providerDisplayName: options.providerDisplayName,
    engineOperation: options.engineOperation,
    sandboxName: input.sandboxName,
    lifecycleGeneration: lifecycleGeneration(input),
    ...(input.sandbox.lifecycleLiveIdentityFingerprint === undefined
      ? {}
      : {
          lifecycleLiveIdentityFingerprint: input.sandbox.lifecycleLiveIdentityFingerprint,
        }),
    runtimeId,
    hostTransportRoot: stateDir,
    authority,
    engineAuthorityStore,
    lifecycleStore: createFilePersistedEngineLifecycleStore(stateDir),
    ...(options.runtimeIdInspectField
      ? { runtimeIdInspectField: options.runtimeIdInspectField }
      : {}),
    ...(options.privatePidMode === undefined ? {} : { privatePidMode: options.privatePidMode }),
    ...(options.managedLabelKey === undefined
      ? {}
      : { managedLabelKey: options.managedLabelKey }),
    ...(options.managedLabelValue === undefined
      ? {}
      : { managedLabelValue: options.managedLabelValue }),
    ...(options.normalizeInspectionMounts === undefined
      ? {}
      : { normalizeInspectionMounts: options.normalizeInspectionMounts }),
  };
}

function createSurfaceOwner(
  input: RuntimeProviderStateMutationContext,
  options: ContainerStateMutationSurfaceOptions,
  phase: "acquire" | "existing",
): ContainerStateMutationOwner {
  return createContainerStateMutationOwner(createSurfaceOwnerOptions(input, options, phase));
}

function retireReleasedSurfaceStateMutations(
  input: RuntimeProviderStateMutationContext,
  options: ContainerStateMutationSurfaceOptions,
  lifecycleStore: PersistedEngineLifecycleStore,
): void {
  let cleanup:
    | {
        readonly ownerOptions: ContainerStateMutationOwnerOptions;
        readonly bindingSha256: string;
      }
    | undefined;
  lifecycleStore.retireReleasedStateMutations(input.sandboxName, (record) => {
    if (!cleanup) {
      const ownerOptions = createSurfaceOwnerOptions(input, options, "existing");
      cleanup = {
        ownerOptions,
        bindingSha256: operationBindingSha256(ownerOptions.authority.engine),
      };
    }
    const targetRuntime = record.resources.find(
      (resource) => resource.role === "target",
    )?.runtimeId;
    if (targetRuntime !== cleanup.ownerOptions.runtimeId) {
      fail(
        `released state mutation target does not match the exact labeled ${options.providerDisplayName} runtime`,
      );
    }
    finishReleasedHelperTransport(
      cleanup.ownerOptions,
      cleanup.bindingSha256,
      record.transactionId,
    );
  });
}

function recoverSurface(
  input: RuntimeProviderStateMutationContext,
  options: ContainerStateMutationSurfaceOptions,
): RuntimeProviderStateMutationFence | null {
  requireSurfaceContext(input, options.providerId);
  const stateDir = (options.resolveStateDir ?? resolveContainerStateMutationStateDir)(
    input.environment,
  );
  const lifecycleStore = createFilePersistedEngineLifecycleStore(stateDir);
  retireReleasedSurfaceStateMutations(input, options, lifecycleStore);
  if (!hasActivePersistedEngineStateMutationTarget(lifecycleStore, input.sandboxName)) {
    return null;
  }
  return createSurfaceOwner(input, options, "existing").recover(input);
}

function releaseSurface(
  input: RuntimeProviderStateMutationContext,
  fence: RuntimeProviderStateMutationFence,
  proof: RuntimeProviderStateMutationActivationProof,
  completedLedgerSha256: string,
  options: ContainerStateMutationSurfaceOptions,
): void {
  requireSurfaceContext(input, options.providerId);
  const source = record(fence, "state mutation fence");
  const transactionId = boundedString(source.transactionId, SHA256, "fence transaction identity");
  const resultSha256 = boundedString(completedLedgerSha256, SHA256, "completed ledger digest");
  if (
    source.providerId !== options.providerId ||
    source.sandboxName !== input.sandboxName ||
    source.lifecycleGeneration !== input.sandbox.lifecycleGeneration
  ) {
    fail("state mutation fence does not match the sandbox release context");
  }
  const stateDir = (options.resolveStateDir ?? resolveContainerStateMutationStateDir)(
    input.environment,
  );
  const lifecycleStore = createFilePersistedEngineLifecycleStore(stateDir);
  if (lifecycleStore.isRetired(transactionId, resultSha256)) return;
  createSurfaceOwner(input, options, "existing").release(input, fence, proof, resultSha256);
}

/** One exact, durable container-provider runtime fence. */
export function createContainerStateMutationSurface(
  options: ContainerStateMutationSurfaceOptions,
): Extract<RuntimeProviderStateMutationSurface, { readonly supported: true }> {
  boundedString(options.providerId, PROVIDER_ID, "provider identity");
  boundedString(options.providerDisplayName, SAFE_NAME, "provider display name");
  const withDirectSandboxExecutionExclusion =
    options.withDirectSandboxExecutionExclusion ?? withShieldsTransitionLock;
  const acquireSurface = (
    input: RuntimeProviderStateMutationContext & {
      readonly plan: RuntimeProviderPreparedStateMutationPlan;
    },
  ): RuntimeProviderStateMutationFence => {
    requireSurfaceContext(input, options.providerId);
    const stateDir = (options.resolveStateDir ?? resolveContainerStateMutationStateDir)(
      input.environment,
    );
    const lifecycleStore = createFilePersistedEngineLifecycleStore(stateDir);
    retireReleasedSurfaceStateMutations(input, options, lifecycleStore);
    if (hasActivePersistedEngineStateMutationTarget(lifecycleStore, input.sandboxName)) {
      fail("OpenShell sandbox already has one unfinished state mutation");
    }
    return createSurfaceOwner(input, options, "acquire").acquire(input);
  };
  const surface: Extract<RuntimeProviderStateMutationSurface, { readonly supported: true }> = {
    providerId: options.providerId,
    supported: true,
    contractVersion: RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
    acquire: (input) =>
      withDirectSandboxExecutionExclusion(
        input.sandboxName,
        `${options.providerDisplayName} runtime-provider state mutation acquire`,
        () => acquireSurface(input),
      ),
    assertFenced: (input, fence) =>
      createSurfaceOwner(input, options, "existing").assertFenced(input, fence),
    publish: (input, fence) => createSurfaceOwner(input, options, "existing").publish(input, fence),
    rollback: (input, fence) =>
      createSurfaceOwner(input, options, "existing").rollback(input, fence),
    activate: (input, fence) =>
      createSurfaceOwner(input, options, "existing").activate(input, fence),
    release: (input, fence, proof, completedLedgerSha256) =>
      releaseSurface(input, fence, proof, completedLedgerSha256, options),
    recover: (input) =>
      withDirectSandboxExecutionExclusion(
        input.sandboxName,
        `${options.providerDisplayName} runtime-provider state mutation recovery`,
        () => recoverSurface(input, options),
      ),
  };
  return Object.freeze(surface);
}

/** Production Docker provider surface for one exact, durable runtime fence. */
export function createDockerStateMutationSurface(
  options: DockerStateMutationSurfaceOptions = {},
): Extract<RuntimeProviderStateMutationSurface, { readonly supported: true }> {
  return createContainerStateMutationSurface({
    providerId: DOCKER_PROVIDER_ID,
    providerDisplayName: "Docker",
    engineOperation: "sandbox-lifecycle",
    createAuthority: (input) =>
      createDockerOperationAuthority("sandbox-lifecycle", input.environment, options.capture),
    ...(options.resolveStateDir ? { resolveStateDir: options.resolveStateDir } : {}),
    ...(options.withDirectSandboxExecutionExclusion
      ? {
          withDirectSandboxExecutionExclusion: options.withDirectSandboxExecutionExclusion,
        }
      : {}),
  });
}
