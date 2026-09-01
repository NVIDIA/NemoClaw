// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { isErrnoException } from "../../core/errno";
import {
  HERMES_PORTABLE_OPENSHELL_VERSION,
  type HermesPortableOpenShellExecutableAuthority,
} from "../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthority, PodmanSocketAuthority } from "../../adapters/podman";
import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";
import { assertCurrentPortableHostFenceHeld } from "../../state/portable-uninstall-retirement";
import { portableDemoReceiptPath } from "./portable-runtime-receipt-readiness";
import {
  HERMES_PORTABLE_PODMAN_VERSION,
  type HermesPortablePodmanExecutableAuthority,
} from "./hermes-portable-podman-authority";

export const HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION = 7 as const;
export const HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION = 8 as const;
export const HERMES_PORTABLE_RECEIPT_DIRECTORY = "hermes-portable-lifecycle";

const RECEIPT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 8;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GENERATION = /^[A-Za-z0-9._:-]{1,256}$/u;
const SANDBOX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type HermesPortableReceiptPhase = "pending" | "configuring" | "active";

export interface HermesPortableStartupContract {
  readonly manifestSha256: string;
  readonly startupDescriptorSha256: string;
  readonly argv: readonly string[];
  readonly gatewayCommand: "hermes gateway run";
  readonly interactiveCommand: "hermes";
  readonly health: {
    readonly url: "http://localhost:8642/health";
    readonly port: 8642;
    readonly method: "GET";
    readonly auth: "bearer_token";
    readonly credentialEnv: "API_SERVER_KEY";
    readonly successStatus: 200;
  };
  readonly devicePairing: false;
  readonly configDir: "/sandbox/.hermes";
  readonly stateIdentitySha256: string;
}

export interface HermesPortablePolicySource {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceIdentity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mode: 384;
    readonly uid: number;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
}

export interface HermesPortableContainerAuthority {
  readonly containerId: string;
  readonly sandboxId: string;
  readonly imageId: string;
  readonly labelsSha256: string;
  readonly name: string;
  readonly running: boolean;
  readonly restartPolicy: string;
}

export interface HermesPortableStableDirectoryAuthority {
  readonly mode: string;
  readonly ownerUid: string;
  readonly path: string;
}

export interface HermesPortableStableExecutableAuthority {
  readonly executablePath: string;
  readonly sha256: string;
  readonly size: string;
  readonly mode: string;
  readonly ownerUid: string;
  readonly directoryChain: readonly HermesPortableStableDirectoryAuthority[];
}

export interface HermesPortableStableSocketAuthority {
  readonly socketPath: string;
  readonly mode: string;
  readonly ownerUid: string;
  readonly directoryChain: readonly HermesPortableStableDirectoryAuthority[];
}

export interface HermesPortableSuccessorReceipt {
  readonly schemaVersion: typeof HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION;
  readonly phase: "active";
  readonly agent: "hermes";
  readonly predecessorActiveSha256: string;
  readonly transactionId: string;
  readonly createIntentSha256: string;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly openshellExecutableAuthority: {
    readonly version: typeof HERMES_PORTABLE_OPENSHELL_VERSION;
    readonly executable: HermesPortableStableExecutableAuthority;
  };
  readonly podmanExecutableAuthority: {
    readonly version: typeof HERMES_PORTABLE_PODMAN_VERSION;
    readonly executable: HermesPortableStableExecutableAuthority;
  };
  readonly socketAuthority: HermesPortableStableSocketAuthority;
  readonly startup: HermesPortableStartupContract;
  readonly container: HermesPortableContainerAuthority;
}

export interface HermesPortableSuccessorSnapshot {
  readonly receipt: HermesPortableSuccessorReceipt;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
  };
}

interface HermesPortableReceiptCommon {
  readonly schemaVersion: typeof HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION;
  readonly agent: "hermes";
  readonly transactionId: string;
  readonly createIntentSha256: string;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly openshellExecutableAuthority: HermesPortableOpenShellExecutableAuthority;
  readonly podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly startup: HermesPortableStartupContract;
}

export interface HermesPortablePendingReceipt extends HermesPortableReceiptCommon {
  readonly phase: "pending";
  readonly policy: HermesPortablePolicySource;
}

export interface HermesPortableConfiguredReceipt extends HermesPortableReceiptCommon {
  readonly phase: "configuring" | "active";
  readonly previousPhaseSha256: string;
  readonly container: HermesPortableContainerAuthority;
}

export type HermesPortableLifecycleReceipt =
  | HermesPortablePendingReceipt
  | HermesPortableConfiguredReceipt;

export interface HermesPortableReceiptSnapshot {
  readonly receipt: HermesPortableLifecycleReceipt;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
  };
  readonly successor?: HermesPortableSuccessorSnapshot;
  /** Exact same-predecessor schema-8 publication evidence awaiting reconciliation. */
  readonly successorPublicationPending?: true;
}

export type PortableAgentReceiptAuthority =
  | { readonly kind: "none" }
  | { readonly kind: "openclaw"; readonly path: string }
  | { readonly kind: "hermes"; readonly snapshot: HermesPortableReceiptSnapshot };

export interface HermesPortableReceiptPublicationHooks {
  readonly assertLifecycleLock?: () => void;
  readonly afterStageCreate?: () => void;
  readonly afterStageWrite?: (written: number, total: number) => void;
  readonly afterStageFsync?: () => void;
  readonly beforeStageDurabilityReopen?: () => void;
  readonly afterCanonicalLink?: () => void;
  readonly afterDirectoryFsync?: () => void;
  readonly afterCleanupLink?: () => void;
  readonly afterStageDetach?: () => void;
  readonly beforeCleanupUnlink?: () => void;
  readonly beforeInterruptedStageRetirement?: () => void;
}

export interface HermesPortableSuccessorRequalificationAuthority {
  readonly expected: HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  };
  readonly assertCurrent: () => void;
}

export interface HermesPortablePolicySourceSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly identity: fs.BigIntStats;
}

export interface HermesPortablePolicySourceBytes {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export type HermesPortablePolicyPublicationSource =
  | HermesPortablePolicySourceSnapshot
  | HermesPortablePolicySourceBytes;

function fail(message: string): never {
  throw new Error(`Hermes portable lifecycle receipt ${message}`);
}

function currentUid(): number {
  if (typeof process.getuid !== "function") fail("requires current-user identity");
  return process.getuid();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value)
  );
}

function exactAbsolutePath(value: unknown): value is string {
  return safeString(value) && path.isAbsolute(value) && path.normalize(value) === value;
}

function parseStartup(value: unknown): HermesPortableStartupContract {
  const startup = record(value);
  const health = record(startup?.health);
  if (
    !startup ||
    !exactKeys(startup, [
      "argv",
      "configDir",
      "devicePairing",
      "gatewayCommand",
      "health",
      "interactiveCommand",
      "manifestSha256",
      "startupDescriptorSha256",
      "stateIdentitySha256",
    ]) ||
    !health ||
    !exactKeys(health, ["auth", "credentialEnv", "method", "port", "successStatus", "url"]) ||
    !SHA256.test(String(startup.manifestSha256)) ||
    !SHA256.test(String(startup.startupDescriptorSha256)) ||
    !SHA256.test(String(startup.stateIdentitySha256)) ||
    !Array.isArray(startup.argv) ||
    startup.argv.length < 2 ||
    startup.argv.length > 128 ||
    startup.argv.some((argument) => !safeString(argument, 2048)) ||
    startup.gatewayCommand !== "hermes gateway run" ||
    startup.interactiveCommand !== "hermes" ||
    startup.devicePairing !== false ||
    startup.configDir !== "/sandbox/.hermes" ||
    health.url !== "http://localhost:8642/health" ||
    health.port !== 8642 ||
    health.method !== "GET" ||
    health.auth !== "bearer_token" ||
    health.credentialEnv !== "API_SERVER_KEY" ||
    health.successStatus !== 200
  ) {
    fail("has an invalid startup contract");
  }
  return startup as unknown as HermesPortableStartupContract;
}

function parsePolicy(value: unknown): HermesPortablePolicySource {
  const policy = record(value);
  const identity = record(policy?.sourceIdentity);
  if (
    !policy ||
    !exactKeys(policy, ["sourceIdentity", "sourcePath", "sourceSha256"]) ||
    !identity ||
    !exactKeys(identity, ["ctimeNs", "dev", "ino", "mode", "mtimeNs", "size", "uid"]) ||
    !exactAbsolutePath(policy.sourcePath) ||
    !SHA256.test(String(policy.sourceSha256)) ||
    !DECIMAL.test(String(identity.dev)) ||
    !DECIMAL.test(String(identity.ino)) ||
    !DECIMAL.test(String(identity.size)) ||
    !DECIMAL.test(String(identity.mtimeNs)) ||
    !DECIMAL.test(String(identity.ctimeNs)) ||
    identity.mode !== RECEIPT_MODE ||
    identity.uid !== currentUid()
  ) {
    fail("has invalid policy source");
  }
  return policy as unknown as HermesPortablePolicySource;
}

function parseContainer(
  value: unknown,
  phase: "configuring" | "active",
): HermesPortableContainerAuthority {
  const container = record(value);
  if (
    !container ||
    !exactKeys(container, [
      "containerId",
      "imageId",
      "labelsSha256",
      "name",
      "restartPolicy",
      "running",
      "sandboxId",
    ]) ||
    !CONTAINER_ID.test(String(container.containerId)) ||
    !GENERATION.test(String(container.sandboxId)) ||
    !IMAGE_ID.test(String(container.imageId)) ||
    !SHA256.test(String(container.labelsSha256)) ||
    !safeString(container.name, 512) ||
    typeof container.running !== "boolean" ||
    !safeString(container.restartPolicy, 128) ||
    (phase === "configuring" && container.running !== true) ||
    (phase === "active" &&
      (container.running !== true || container.restartPolicy !== "unless-stopped"))
  ) {
    fail("has invalid container authority");
  }
  return container as unknown as HermesPortableContainerAuthority;
}

function parseSocketAuthority(
  value: unknown,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
): PodmanSocketAuthority {
  const authority = record(value);
  if (
    !authority ||
    !exactKeys(authority, [
      "device",
      "directoryChain",
      "inode",
      "mode",
      "ownerUid",
      "socketPath",
    ]) ||
    !DECIMAL.test(String(authority.device)) ||
    !DECIMAL.test(String(authority.inode)) ||
    !DECIMAL.test(String(authority.mode)) ||
    authority.ownerUid !== String(currentUid()) ||
    authority.socketPath !== runtimeAuthority.socketPath ||
    !Array.isArray(authority.directoryChain) ||
    authority.directoryChain.length < 1 ||
    authority.directoryChain.length > 64
  ) {
    fail("has invalid Podman socket authority");
  }
  let expectedPath = path.dirname(runtimeAuthority.socketPath);
  for (const value of authority.directoryChain) {
    const directory = record(value);
    if (
      !directory ||
      !exactKeys(directory, ["device", "inode", "mode", "ownerUid", "path"]) ||
      !DECIMAL.test(String(directory.device)) ||
      !DECIMAL.test(String(directory.inode)) ||
      !DECIMAL.test(String(directory.mode)) ||
      !DECIMAL.test(String(directory.ownerUid)) ||
      directory.path !== expectedPath
    ) {
      fail("has invalid Podman socket directory authority");
    }
    expectedPath = path.dirname(expectedPath);
  }
  if (expectedPath !== path.dirname(expectedPath)) {
    fail("has incomplete Podman socket directory authority");
  }
  return authority as unknown as PodmanSocketAuthority;
}

function parseOpenShellExecutableAuthority(
  value: unknown,
): HermesPortableOpenShellExecutableAuthority {
  const authority = record(value);
  const executable = record(authority?.executable);
  if (
    !authority ||
    !exactKeys(authority, ["executable", "version"]) ||
    authority.version !== HERMES_PORTABLE_OPENSHELL_VERSION ||
    !executable ||
    !exactKeys(executable, [
      "changedTimeNanoseconds",
      "device",
      "directoryChain",
      "executablePath",
      "inode",
      "mode",
      "modifiedTimeNanoseconds",
      "ownerUid",
      "sha256",
      "size",
    ]) ||
    !exactAbsolutePath(executable.executablePath) ||
    !DECIMAL.test(String(executable.changedTimeNanoseconds)) ||
    !DECIMAL.test(String(executable.device)) ||
    !DECIMAL.test(String(executable.inode)) ||
    !DECIMAL.test(String(executable.mode)) ||
    !DECIMAL.test(String(executable.modifiedTimeNanoseconds)) ||
    !DECIMAL.test(String(executable.ownerUid)) ||
    !SHA256.test(String(executable.sha256)) ||
    !DECIMAL.test(String(executable.size)) ||
    !Array.isArray(executable.directoryChain) ||
    executable.directoryChain.length < 1 ||
    executable.directoryChain.length > 64
  ) {
    fail("has invalid OpenShell executable authority");
  }
  const uid = String(currentUid());
  if (executable.ownerUid !== "0" && executable.ownerUid !== uid) {
    fail("has invalid OpenShell executable ownership");
  }
  let expectedPath = path.dirname(executable.executablePath as string);
  for (const value of executable.directoryChain) {
    const directory = record(value);
    if (
      !directory ||
      !exactKeys(directory, ["device", "inode", "mode", "ownerUid", "path"]) ||
      !DECIMAL.test(String(directory.device)) ||
      !DECIMAL.test(String(directory.inode)) ||
      !DECIMAL.test(String(directory.mode)) ||
      !DECIMAL.test(String(directory.ownerUid)) ||
      (directory.ownerUid !== "0" && directory.ownerUid !== uid) ||
      directory.path !== expectedPath
    ) {
      fail("has invalid OpenShell executable directory authority");
    }
    expectedPath = path.dirname(expectedPath);
  }
  if (expectedPath !== path.dirname(expectedPath)) {
    fail("has incomplete OpenShell executable directory authority");
  }
  return authority as unknown as HermesPortableOpenShellExecutableAuthority;
}

function parsePodmanExecutableAuthority(value: unknown): HermesPortablePodmanExecutableAuthority {
  const authority = record(value);
  const executable = record(authority?.executable);
  if (
    !authority ||
    !exactKeys(authority, ["executable", "version"]) ||
    authority.version !== HERMES_PORTABLE_PODMAN_VERSION ||
    !executable ||
    !exactKeys(executable, [
      "changedTimeNanoseconds",
      "device",
      "directoryChain",
      "executablePath",
      "inode",
      "mode",
      "modifiedTimeNanoseconds",
      "ownerUid",
      "sha256",
      "size",
    ]) ||
    !exactAbsolutePath(executable.executablePath) ||
    !DECIMAL.test(String(executable.changedTimeNanoseconds)) ||
    !DECIMAL.test(String(executable.device)) ||
    !DECIMAL.test(String(executable.inode)) ||
    !DECIMAL.test(String(executable.mode)) ||
    !DECIMAL.test(String(executable.modifiedTimeNanoseconds)) ||
    !DECIMAL.test(String(executable.ownerUid)) ||
    !SHA256.test(String(executable.sha256)) ||
    !DECIMAL.test(String(executable.size)) ||
    !Array.isArray(executable.directoryChain) ||
    executable.directoryChain.length < 1 ||
    executable.directoryChain.length > 64
  ) {
    fail("has invalid Podman executable authority");
  }
  const uid = String(currentUid());
  if (executable.ownerUid !== "0" && executable.ownerUid !== uid) {
    fail("has invalid Podman executable ownership");
  }
  let expectedPath = path.dirname(executable.executablePath as string);
  for (const value of executable.directoryChain) {
    const directory = record(value);
    if (
      !directory ||
      !exactKeys(directory, ["device", "inode", "mode", "ownerUid", "path"]) ||
      !DECIMAL.test(String(directory.device)) ||
      !DECIMAL.test(String(directory.inode)) ||
      !DECIMAL.test(String(directory.mode)) ||
      !DECIMAL.test(String(directory.ownerUid)) ||
      (directory.ownerUid !== "0" && directory.ownerUid !== uid) ||
      directory.path !== expectedPath
    ) {
      fail("has invalid Podman executable directory authority");
    }
    expectedPath = path.dirname(expectedPath);
  }
  if (expectedPath !== path.dirname(expectedPath)) {
    fail("has incomplete Podman executable directory authority");
  }
  return authority as unknown as HermesPortablePodmanExecutableAuthority;
}

function parseStableDirectoryChain(
  value: unknown,
  firstPath: string,
  owner: "current-user" | "root-or-current-user",
): readonly HermesPortableStableDirectoryAuthority[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail("has invalid stable directory authority");
  }
  const uid = String(currentUid());
  let expectedPath = firstPath;
  const chain = value.map((entry, index) => {
    const directory = record(entry);
    const mode = DECIMAL.test(String(directory?.mode)) ? BigInt(directory!.mode as string) : -1n;
    if (
      !directory ||
      !exactKeys(directory, ["mode", "ownerUid", "path"]) ||
      !DECIMAL.test(String(directory.mode)) ||
      !DECIMAL.test(String(directory.ownerUid)) ||
      (mode & 0o022n) !== 0n ||
      directory.path !== expectedPath ||
      (owner === "current-user"
        ? (index === 0 && directory.ownerUid !== uid) ||
          (index > 0 && directory.ownerUid !== "0" && directory.ownerUid !== uid)
        : directory.ownerUid !== "0" && directory.ownerUid !== uid)
    ) {
      fail("has invalid stable directory authority");
    }
    expectedPath = path.dirname(expectedPath);
    return directory as unknown as HermesPortableStableDirectoryAuthority;
  });
  if (expectedPath !== path.dirname(expectedPath)) {
    fail("has incomplete stable directory authority");
  }
  return chain;
}

function parseStableExecutableAuthority(value: unknown): HermesPortableStableExecutableAuthority {
  const executable = record(value);
  const mode = DECIMAL.test(String(executable?.mode)) ? BigInt(executable!.mode as string) : -1n;
  const uid = String(currentUid());
  if (
    !executable ||
    !exactKeys(executable, [
      "directoryChain",
      "executablePath",
      "mode",
      "ownerUid",
      "sha256",
      "size",
    ]) ||
    !exactAbsolutePath(executable.executablePath) ||
    !DECIMAL.test(String(executable.mode)) ||
    !DECIMAL.test(String(executable.ownerUid)) ||
    (executable.ownerUid !== "0" && executable.ownerUid !== uid) ||
    (mode & 0o022n) !== 0n ||
    (mode & 0o111n) === 0n ||
    !SHA256.test(String(executable.sha256)) ||
    !DECIMAL.test(String(executable.size))
  ) {
    fail("has invalid stable executable authority");
  }
  return {
    executablePath: executable.executablePath as string,
    sha256: executable.sha256 as string,
    size: executable.size as string,
    mode: executable.mode as string,
    ownerUid: executable.ownerUid as string,
    directoryChain: parseStableDirectoryChain(
      executable.directoryChain,
      path.dirname(executable.executablePath as string),
      "root-or-current-user",
    ),
  };
}

function parseStableSocketAuthority(
  value: unknown,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
): HermesPortableStableSocketAuthority {
  const socket = record(value);
  const mode = DECIMAL.test(String(socket?.mode)) ? BigInt(socket!.mode as string) : -1n;
  const directoryChain = parseStableDirectoryChain(
    socket?.directoryChain,
    path.dirname(runtimeAuthority.socketPath),
    "current-user",
  );
  const parentMode = directoryChain[0] ? BigInt(directoryChain[0].mode) : 0o777n;
  if (
    !socket ||
    !exactKeys(socket, ["directoryChain", "mode", "ownerUid", "socketPath"]) ||
    socket.socketPath !== runtimeAuthority.socketPath ||
    !DECIMAL.test(String(socket.mode)) ||
    socket.ownerUid !== String(currentUid()) ||
    (mode & 0o002n) !== 0n ||
    ((mode & 0o020n) !== 0n && (parentMode & 0o077n) !== 0n)
  ) {
    fail("has invalid stable Podman socket authority");
  }
  return {
    socketPath: socket.socketPath as string,
    mode: socket.mode as string,
    ownerUid: socket.ownerUid as string,
    directoryChain,
  };
}

function parseSuccessorBytes(bytes: Buffer): HermesPortableSuccessorReceipt {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail("schema-8 successor is malformed or is not strict UTF-8");
  }
  const receipt = record(value);
  const openshell = record(receipt?.openshellExecutableAuthority);
  const podman = record(receipt?.podmanExecutableAuthority);
  const runtimeAuthority = parsePortableRuntimeAuthority(receipt?.runtimeAuthority);
  if (
    !receipt ||
    !exactKeys(receipt, [
      "agent",
      "container",
      "createIntentSha256",
      "gatewayName",
      "lifecycleGeneration",
      "openshellExecutableAuthority",
      "phase",
      "podmanExecutableAuthority",
      "predecessorActiveSha256",
      "runtimeAuthority",
      "sandboxName",
      "schemaVersion",
      "socketAuthority",
      "startup",
      "transactionId",
    ]) ||
    receipt.schemaVersion !== HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION ||
    receipt.phase !== "active" ||
    receipt.agent !== "hermes" ||
    !SHA256.test(String(receipt.predecessorActiveSha256)) ||
    !UUID.test(String(receipt.transactionId)) ||
    !SHA256.test(String(receipt.createIntentSha256)) ||
    !SANDBOX.test(String(receipt.sandboxName)) ||
    !safeString(receipt.gatewayName, 256) ||
    !GENERATION.test(String(receipt.lifecycleGeneration)) ||
    !runtimeAuthority ||
    runtimeAuthority.uid !== currentUid() ||
    !openshell ||
    !exactKeys(openshell, ["executable", "version"]) ||
    openshell.version !== HERMES_PORTABLE_OPENSHELL_VERSION ||
    !podman ||
    !exactKeys(podman, ["executable", "version"]) ||
    podman.version !== HERMES_PORTABLE_PODMAN_VERSION ||
    podman.version !== HERMES_PORTABLE_PODMAN_VERSION
  ) {
    fail("has invalid schema-8 successor authority");
  }
  return {
    schemaVersion: HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION,
    phase: "active",
    agent: "hermes",
    predecessorActiveSha256: receipt.predecessorActiveSha256 as string,
    transactionId: receipt.transactionId as string,
    createIntentSha256: receipt.createIntentSha256 as string,
    sandboxName: receipt.sandboxName as string,
    gatewayName: receipt.gatewayName as string,
    lifecycleGeneration: receipt.lifecycleGeneration as string,
    runtimeAuthority,
    openshellExecutableAuthority: {
      version: HERMES_PORTABLE_OPENSHELL_VERSION,
      executable: parseStableExecutableAuthority(openshell.executable),
    },
    podmanExecutableAuthority: {
      version: HERMES_PORTABLE_PODMAN_VERSION,
      executable: parseStableExecutableAuthority(podman.executable),
    },
    socketAuthority: parseStableSocketAuthority(receipt.socketAuthority, runtimeAuthority),
    startup: parseStartup(receipt.startup),
    container: parseContainer(receipt.container, "active"),
  };
}

function parseReceiptBytes(bytes: Buffer): HermesPortableLifecycleReceipt {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail("is malformed or is not strict UTF-8");
  }
  const receipt = record(value);
  const phase = receipt?.phase;
  const configured = phase === "configuring" || phase === "active";
  const expected = [
    "agent",
    "createIntentSha256",
    "gatewayName",
    "lifecycleGeneration",
    "openshellExecutableAuthority",
    "podmanExecutableAuthority",
    "phase",
    "runtimeAuthority",
    "sandboxName",
    "schemaVersion",
    "socketAuthority",
    "startup",
    "transactionId",
    ...(configured ? ["container", "previousPhaseSha256"] : ["policy"]),
  ];
  const authority = parsePortableRuntimeAuthority(receipt?.runtimeAuthority);
  if (
    !receipt ||
    !exactKeys(receipt, expected) ||
    receipt.schemaVersion !== HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION ||
    receipt.agent !== "hermes" ||
    (phase !== "pending" && !configured) ||
    !UUID.test(String(receipt.transactionId)) ||
    !SHA256.test(String(receipt.createIntentSha256)) ||
    !SANDBOX.test(String(receipt.sandboxName)) ||
    !safeString(receipt.gatewayName, 256) ||
    !GENERATION.test(String(receipt.lifecycleGeneration)) ||
    !authority ||
    authority.uid !== currentUid()
  ) {
    fail("has invalid identity fields");
  }
  const common = {
    schemaVersion: HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION,
    agent: "hermes" as const,
    transactionId: receipt.transactionId as string,
    createIntentSha256: receipt.createIntentSha256 as string,
    sandboxName: receipt.sandboxName as string,
    gatewayName: receipt.gatewayName as string,
    lifecycleGeneration: receipt.lifecycleGeneration as string,
    runtimeAuthority: authority,
    openshellExecutableAuthority: parseOpenShellExecutableAuthority(
      receipt.openshellExecutableAuthority,
    ),
    podmanExecutableAuthority: parsePodmanExecutableAuthority(receipt.podmanExecutableAuthority),
    socketAuthority: parseSocketAuthority(receipt.socketAuthority, authority),
    startup: parseStartup(receipt.startup),
  };
  if (phase === "pending") return { ...common, phase, policy: parsePolicy(receipt.policy) };
  if (!SHA256.test(String(receipt.previousPhaseSha256))) {
    fail("has invalid phase authority");
  }
  return {
    ...common,
    phase,
    previousPhaseSha256: receipt.previousPhaseSha256 as string,
    container: parseContainer(receipt.container, phase),
  };
}

function serializeReceipt(receipt: HermesPortableLifecycleReceipt): Buffer {
  const normalized = parseReceiptBytes(Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  if (bytes.byteLength > Number(MAX_RECEIPT_BYTES)) {
    fail("serialized receipt exceeds the bounded receipt size");
  }
  return bytes;
}

function receiptHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableHermesPortableExecutableAuthority(
  authority: PodmanExecutableAuthority,
): HermesPortableStableExecutableAuthority {
  return {
    executablePath: authority.executablePath,
    sha256: authority.sha256,
    size: authority.size,
    mode: authority.mode,
    ownerUid: authority.ownerUid,
    directoryChain: authority.directoryChain.map(({ path, mode, ownerUid }) => ({
      path,
      mode,
      ownerUid,
    })),
  };
}

export function stableHermesPortableSocketAuthority(
  authority: PodmanSocketAuthority,
): HermesPortableStableSocketAuthority {
  return {
    socketPath: authority.socketPath,
    mode: authority.mode,
    ownerUid: authority.ownerUid,
    directoryChain: authority.directoryChain.map(({ path, mode, ownerUid }) => ({
      path,
      mode,
      ownerUid,
    })),
  };
}

export function createHermesPortableSuccessorReceipt(
  active: HermesPortableReceiptSnapshot & { readonly receipt: HermesPortableConfiguredReceipt },
): HermesPortableSuccessorReceipt {
  if (active.receipt.phase !== "active") fail("schema-8 successor requires active authority");
  const receipt = active.receipt;
  return {
    schemaVersion: HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION,
    phase: "active",
    agent: "hermes",
    predecessorActiveSha256: active.sha256,
    transactionId: receipt.transactionId,
    createIntentSha256: receipt.createIntentSha256,
    sandboxName: receipt.sandboxName,
    gatewayName: receipt.gatewayName,
    lifecycleGeneration: receipt.lifecycleGeneration,
    runtimeAuthority: receipt.runtimeAuthority,
    openshellExecutableAuthority: {
      version: receipt.openshellExecutableAuthority.version,
      executable: stableHermesPortableExecutableAuthority(
        receipt.openshellExecutableAuthority.executable,
      ),
    },
    podmanExecutableAuthority: {
      version: receipt.podmanExecutableAuthority.version,
      executable: stableHermesPortableExecutableAuthority(
        receipt.podmanExecutableAuthority.executable,
      ),
    },
    socketAuthority: stableHermesPortableSocketAuthority(receipt.socketAuthority),
    startup: receipt.startup,
    container: receipt.container,
  };
}

function serializeSuccessor(receipt: HermesPortableSuccessorReceipt): Buffer {
  const normalized = parseSuccessorBytes(Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  if (bytes.byteLength > Number(MAX_RECEIPT_BYTES)) {
    fail("serialized schema-8 successor exceeds the bounded receipt size");
  }
  return bytes;
}

function sandboxReceiptStem(sandboxName: string): string {
  return createHash("sha256").update(sandboxName).digest("hex");
}

export function hermesPortableReceiptRoot(stateDir: string): string {
  return path.join(stateDir, HERMES_PORTABLE_RECEIPT_DIRECTORY);
}

export function hermesPortableReceiptDirectory(sandboxName: string, stateDir: string): string {
  return path.join(hermesPortableReceiptRoot(stateDir), sandboxReceiptStem(sandboxName));
}

function phasePath(directory: string, phase: HermesPortableReceiptPhase): string {
  return path.join(directory, `${phase}.json`);
}

function successorPath(directory: string): string {
  return path.join(directory, "authority.json");
}

function successorStagePath(directory: string, predecessorActiveSha256: string): string {
  return path.join(directory, `.authority.${predecessorActiveSha256}.tmp`);
}

function policySourceBasename(transactionId: string): string {
  if (!UUID.test(transactionId)) fail("has an invalid policy transaction identity");
  return `policy.${transactionId}.yaml`;
}

export function hermesPortablePolicySourcePath(
  sandboxName: string,
  transactionId: string,
  stateDir: string,
): string {
  return path.join(
    hermesPortableReceiptDirectory(sandboxName, stateDir),
    policySourceBasename(transactionId),
  );
}

function policyPublicationTransactionId(entry: string): string | null {
  const match =
    /^(?:policy\.([a-f0-9-]{36})\.yaml|\.policy\.([a-f0-9-]{36})\.[a-f0-9]{64}\.next(?:\.cleanup)?)$/u.exec(
      entry,
    );
  const transactionId = match?.[1] ?? match?.[2];
  return transactionId && UUID.test(transactionId) ? transactionId : null;
}

function pendingPublicationTransactionId(entry: string): string | null {
  const identity = phasePublicationIdentity(entry);
  return identity?.phase === "pending" ? identity.transactionId : null;
}

function phasePublicationIdentity(entry: string): {
  readonly phase: HermesPortableReceiptPhase;
  readonly transactionId: string;
  readonly createIntentSha256: string;
  readonly generationSha256: string;
  readonly cleanup: boolean;
} | null {
  const match =
    /^\.(pending|configuring|active)\.([a-f0-9-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})\.next(\.cleanup)?$/u.exec(
      entry,
    );
  if (!match || !UUID.test(match[2]!)) return null;
  return {
    phase: match[1] as HermesPortableReceiptPhase,
    transactionId: match[2]!,
    createIntentSha256: match[3]!,
    generationSha256: match[4]!,
    cleanup: Boolean(match[5]),
  };
}

function successorPublicationIdentity(entry: string): {
  readonly predecessorActiveSha256: string;
  readonly cleanup: boolean;
} | null {
  const match = /^\.authority\.([a-f0-9]{64})\.tmp(\.cleanup)?$/u.exec(entry);
  return match ? { predecessorActiveSha256: match[1]!, cleanup: match[2] === ".cleanup" } : null;
}

function stagePath(directory: string, receipt: HermesPortableLifecycleReceipt): string {
  const generationSha256 = receiptHash(Buffer.from(receipt.lifecycleGeneration, "utf8"));
  return path.join(
    directory,
    `.${receipt.phase}.${receipt.transactionId}.${receipt.createIntentSha256}.${generationSha256}.next`,
  );
}

function policyStagePath(directory: string, transactionId: string, sourceSha256: string): string {
  return path.join(directory, `.policy.${transactionId}.${sourceSha256}.next`);
}

function cleanupPath(target: string): string {
  return `${target}.cleanup`;
}

function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function validDirectoryLinkCount(identity: fs.BigIntStats, bounded: boolean): boolean {
  return identity.nlink >= 1n && (!bounded || identity.nlink <= BigInt(MAX_DIRECTORY_ENTRIES + 2));
}

interface OpenReceiptDirectory {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: fs.BigIntStats;
  readonly boundedLinks: boolean;
}

function validateDirectory(directory: string, boundedLinks = true): OpenReceiptDirectory {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryFlag = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== "number" || typeof directoryFlag !== "number") {
    fail("requires O_NOFOLLOW and O_DIRECTORY");
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryFlag);
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    if (
      !identity.isDirectory() ||
      named.isSymbolicLink() ||
      !sameDirectoryIdentity(identity, named) ||
      identity.uid !== BigInt(currentUid()) ||
      (identity.mode & 0o777n) !== BigInt(DIRECTORY_MODE) ||
      !validDirectoryLinkCount(identity, boundedLinks) ||
      !validDirectoryLinkCount(named, boundedLinks)
    ) {
      fail(`directory is unsafe: ${directory}`);
    }
    return { path: directory, descriptor, identity, boundedLinks };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function revalidateDirectory(directory: OpenReceiptDirectory): void {
  const descriptor = fs.fstatSync(directory.descriptor, { bigint: true });
  const named = fs.lstatSync(directory.path, { bigint: true });
  if (
    !sameDirectoryIdentity(directory.identity, descriptor) ||
    !sameDirectoryIdentity(directory.identity, named) ||
    !validDirectoryLinkCount(descriptor, directory.boundedLinks) ||
    !validDirectoryLinkCount(named, directory.boundedLinks)
  ) {
    fail(`directory changed while in use: ${directory.path}`);
  }
}

function ensurePrivateDirectory(directory: string, boundedLinks = true): OpenReceiptDirectory {
  try {
    fs.mkdirSync(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  return validateDirectory(directory, boundedLinks);
}

function ensureReceiptDirectory(sandboxName: string, stateDir: string): OpenReceiptDirectory {
  const root = hermesPortableReceiptRoot(stateDir);
  const rootDirectory = ensurePrivateDirectory(root, false);
  try {
    revalidateDirectory(rootDirectory);
    return ensurePrivateDirectory(hermesPortableReceiptDirectory(sandboxName, stateDir));
  } finally {
    fs.closeSync(rootDirectory.descriptor);
  }
}

interface ExactFile {
  readonly bytes: Buffer;
  readonly identity: fs.BigIntStats;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readExactFile(
  target: string,
  allowedLinks = 1n,
  maximumBytes = MAX_RECEIPT_BYTES,
  minimumBytes = 1n,
): ExactFile | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("requires O_NOFOLLOW");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      !sameFileIdentity(before, named) ||
      before.uid !== BigInt(currentUid()) ||
      (before.mode & 0o777n) !== BigInt(RECEIPT_MODE) ||
      before.nlink !== allowedLinks ||
      before.size < minimumBytes ||
      before.size > BigInt(maximumBytes)
    ) {
      fail(`file is unsafe: ${target}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`file ended during read: ${target}`);
      offset += count;
    }
    if (!sameFileIdentity(before, fs.fstatSync(descriptor, { bigint: true }))) {
      fail(`file changed during read: ${target}`);
    }
    return { bytes, identity: before };
  } finally {
    fs.closeSync(descriptor);
  }
}

function policySourceFromFile(target: string, file: ExactFile): HermesPortablePolicySource {
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("policy source is not strict UTF-8");
  }
  return {
    sourcePath: target,
    sourceSha256: receiptHash(file.bytes),
    sourceIdentity: {
      dev: String(file.identity.dev),
      ino: String(file.identity.ino),
      size: String(file.identity.size),
      mode: RECEIPT_MODE,
      uid: currentUid(),
      mtimeNs: String(file.identity.mtimeNs),
      ctimeNs: String(file.identity.ctimeNs),
    },
  };
}

function samePolicyIdentity(source: HermesPortablePolicySource, file: ExactFile): boolean {
  return (
    source.sourceSha256 === receiptHash(file.bytes) &&
    source.sourceIdentity.dev === String(file.identity.dev) &&
    source.sourceIdentity.ino === String(file.identity.ino) &&
    source.sourceIdentity.size === String(file.identity.size) &&
    source.sourceIdentity.mode === RECEIPT_MODE &&
    source.sourceIdentity.uid === currentUid() &&
    source.sourceIdentity.mtimeNs === String(file.identity.mtimeNs) &&
    source.sourceIdentity.ctimeNs === String(file.identity.ctimeNs)
  );
}

export function captureHermesPortablePolicySource(
  sourcePath: string,
): HermesPortablePolicySourceSnapshot {
  if (!exactAbsolutePath(sourcePath)) fail("policy source path is invalid");
  const file = readExactFile(sourcePath, 1n, MAX_POLICY_BYTES);
  if (!file) fail(`policy source is missing: ${sourcePath}`);
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("policy source is not strict UTF-8");
  }
  return {
    path: sourcePath,
    bytes: file.bytes,
    sha256: receiptHash(file.bytes),
    identity: file.identity,
  };
}

export function assertHermesPortablePolicySourceSnapshot(
  snapshot: HermesPortablePolicySourceSnapshot,
): void {
  const current = captureHermesPortablePolicySource(snapshot.path);
  if (
    current.sha256 !== snapshot.sha256 ||
    !current.bytes.equals(snapshot.bytes) ||
    !sameFileIdentity(current.identity, snapshot.identity)
  ) {
    fail("policy source changed while in custody");
  }
}

function assertHermesPortablePolicyPublicationSource(
  source: HermesPortablePolicyPublicationSource,
): void {
  if ("path" in source) {
    assertHermesPortablePolicySourceSnapshot(source);
    return;
  }
  if (
    source.bytes.length < 1 ||
    source.bytes.length > MAX_POLICY_BYTES ||
    receiptHash(source.bytes) !== source.sha256
  ) {
    fail("in-memory policy source is invalid");
  }
  try {
    UTF8.decode(source.bytes);
  } catch {
    fail("in-memory policy source is not strict UTF-8");
  }
}

export function assertHermesPortablePolicySource(source: HermesPortablePolicySource): Buffer {
  const file = readExactFile(source.sourcePath, 1n, MAX_POLICY_BYTES);
  if (!file || !samePolicyIdentity(source, file)) {
    fail("durable policy source disagrees with its receipt");
  }
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("durable policy source is not strict UTF-8");
  }
  return file.bytes;
}

/** Retire the bounded create-policy copy and receipt history after OpenShell owns policy. */
export function retireHermesPortableCreatePolicyState(
  sandboxName: string,
  transactionId: string,
  stateDir: string,
): HermesPortableReceiptSnapshot & {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly successor: HermesPortableSuccessorSnapshot;
} {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`create-policy retirement requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  const active = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (
    !active ||
    active.receipt.phase !== "active" ||
    !active.successor ||
    active.receipt.transactionId !== transactionId
  ) {
    fail("create-policy retirement requires policy-free active operating authority");
  }

  const directory = validateDirectory(path.dirname(active.path));
  try {
    revalidateDirectory(directory);
    const pending = readPhase(directory.path, "pending");
    const configuring = readPhase(directory.path, "configuring");
    for (const snapshot of [pending, configuring]) {
      if (snapshot && snapshot.receipt.transactionId !== transactionId) {
        fail("create-policy retirement found another transaction generation");
      }
    }

    const sourcePath = hermesPortablePolicySourcePath(sandboxName, transactionId, stateDir);
    const source = readExactFile(sourcePath, 1n, MAX_POLICY_BYTES);
    if (source) {
      if (pending?.receipt.phase === "pending") {
        assertHermesPortablePolicySource(pending.receipt.policy);
      }
      fs.unlinkSync(sourcePath);
    }
    for (const snapshot of [pending, configuring]) {
      if (!snapshot) continue;
      const current = readExactFile(snapshot.path, 1n, MAX_RECEIPT_BYTES);
      if (
        !current ||
        current.identity.dev !== snapshot.identity.dev ||
        current.identity.ino !== snapshot.identity.ino ||
        !current.bytes.equals(snapshot.bytes)
      ) {
        fail("create-policy receipt history changed before retirement");
      }
      fs.unlinkSync(snapshot.path);
    }
    fs.fsyncSync(directory.descriptor);
  } finally {
    fs.closeSync(directory.descriptor);
  }

  const compacted = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (
    !compacted ||
    compacted.receipt.phase !== "active" ||
    !compacted.successor ||
    compacted.receipt.transactionId !== transactionId
  ) {
    fail("policy-free active operating authority could not be requalified after retirement");
  }
  return compacted as HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
    readonly successor: HermesPortableSuccessorSnapshot;
  };
}

export function requalifyHermesPortablePolicySource(source: HermesPortablePolicySource): {
  readonly source: HermesPortablePolicySource;
  readonly bytes: Buffer;
} {
  const file = readExactFile(source.sourcePath, 1n, MAX_POLICY_BYTES);
  if (
    !file ||
    source.sourceSha256 !== receiptHash(file.bytes) ||
    source.sourceIdentity.size !== String(file.identity.size) ||
    source.sourceIdentity.mode !== RECEIPT_MODE ||
    source.sourceIdentity.uid !== currentUid()
  ) {
    fail("durable policy source disagrees with its semantic digest");
  }
  const current = policySourceFromFile(source.sourcePath, file);
  return { source: current, bytes: file.bytes };
}

function writeStage(
  target: string,
  bytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
): void {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    RECEIPT_MODE,
  );
  try {
    fs.fchmodSync(descriptor, RECEIPT_MODE);
    hooks.afterStageCreate?.();
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("stage write did not make progress");
      offset += count;
      hooks.afterStageWrite?.(offset, bytes.length);
    }
    fs.fsyncSync(descriptor);
    hooks.afterStageFsync?.();
  } finally {
    fs.closeSync(descriptor);
    // Preserve an incomplete private generation. An identical publisher can
    // retire it under the lifecycle lock; an ordinary reader fails closed.
  }
}

function fsyncExactStage(
  target: string,
  expectedBytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  const expected = readExactFile(target, 1n, maximumBytes);
  if (!expected || !expected.bytes.equals(expectedBytes)) {
    fail("staged authority changed before durability recheck");
  }
  hooks.beforeStageDurabilityReopen?.();
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("requires O_NOFOLLOW");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (!sameFileIdentity(expected.identity, opened) || !sameFileIdentity(opened, named)) {
      fail("staged authority changed before durability recheck");
    }
    fs.fsyncSync(descriptor);
    if (!sameFileIdentity(opened, fs.fstatSync(descriptor, { bigint: true }))) {
      fail("staged authority changed during durability recheck");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const durable = readExactFile(target, 1n, maximumBytes);
  if (!durable || !sameArtifact(expected, durable) || !durable.bytes.equals(expectedBytes)) {
    fail("staged authority changed after durability recheck");
  }
}

function retireInterruptedEmptyStage(
  canonical: string,
  staged: string,
  cleanup: string,
  directory: OpenReceiptDirectory,
  assertLifecycleLock: () => void,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  if (stageLinkCount(staged) !== 1n) return;
  const empty = readExactFile(staged, 1n, maximumBytes, 0n);
  if (!empty || empty.bytes.length !== 0) return;
  if (stageLinkCount(canonical) !== null || stageLinkCount(cleanup) !== null) {
    fail("empty stage conflicts with other publication evidence");
  }
  assertLifecycleLock();
  revalidateDirectory(directory);
  const current = readExactFile(staged, 1n, maximumBytes, 0n);
  if (!current || !sameArtifact(empty, current) || current.bytes.length !== 0) {
    fail("empty stage changed before exact retirement");
  }
  fs.unlinkSync(staged);
  fs.fsyncSync(directory.descriptor);
}

function retireInterruptedExactPrefixStage(
  canonical: string,
  staged: string,
  cleanup: string,
  directory: OpenReceiptDirectory,
  expectedBytes: Buffer,
  assertLifecycleLock: () => void,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  if (stageLinkCount(staged) !== 1n) return;
  const interrupted = readExactFile(staged, 1n, maximumBytes);
  if (!interrupted || interrupted.bytes.length >= expectedBytes.length) return;
  if (!expectedBytes.subarray(0, interrupted.bytes.length).equals(interrupted.bytes)) {
    fail("interrupted stage is not the exact authorized receipt prefix");
  }
  if (stageLinkCount(canonical) !== null || stageLinkCount(cleanup) !== null) {
    fail("interrupted stage conflicts with other publication evidence");
  }
  hooks.beforeInterruptedStageRetirement?.();
  assertLifecycleLock();
  revalidateDirectory(directory);
  if (stageLinkCount(canonical) !== null || stageLinkCount(cleanup) !== null) {
    fail("interrupted stage conflicts with other publication evidence");
  }
  const current = readExactFile(staged, 1n, maximumBytes);
  if (
    !current ||
    !sameArtifact(interrupted, current) ||
    current.bytes.length >= expectedBytes.length ||
    !expectedBytes.subarray(0, current.bytes.length).equals(current.bytes)
  ) {
    fail("interrupted stage changed before exact retirement");
  }
  unlinkExactArtifact(staged, current, undefined, maximumBytes);
  fs.fsyncSync(directory.descriptor);
  if (stageLinkCount(staged) !== null) fail("interrupted stage remained after exact retirement");
}

function readPublicationArtifact(
  target: string,
  maximumBytes = MAX_RECEIPT_BYTES,
): ExactFile | null {
  const links = stageLinkCount(target);
  if (links === null) return null;
  if (links < 1n || links > 3n) fail(`publication artifact has invalid links: ${target}`);
  return readExactFile(target, links, maximumBytes);
}

function sameArtifact(left: ExactFile, right: ExactFile): boolean {
  return (
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.bytes.equals(right.bytes)
  );
}

function unlinkExactArtifact(
  target: string,
  expected: ExactFile,
  beforeUnlink?: () => void,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  beforeUnlink?.();
  const current = readPublicationArtifact(target, maximumBytes);
  if (!current || !sameArtifact(current, expected)) {
    fail("artifact changed before exact detach");
  }
  fs.unlinkSync(target);
}

function detachPublishedStage(
  canonical: string,
  staged: string,
  cleanup: string,
  expectedBytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  const canonicalFile = readPublicationArtifact(canonical, maximumBytes);
  const stagedFile = readPublicationArtifact(staged, maximumBytes);
  if (!canonicalFile || !stagedFile) fail("publication is missing canonical or staged authority");
  if (
    !sameArtifact(canonicalFile, stagedFile) ||
    !canonicalFile.bytes.equals(expectedBytes) ||
    !stagedFile.bytes.equals(expectedBytes)
  ) {
    fail("publication artifacts disagree");
  }
  const existingCleanup = readPublicationArtifact(cleanup, maximumBytes);
  if (existingCleanup) {
    if (!sameArtifact(canonicalFile, existingCleanup)) fail("cleanup artifact disagrees");
  } else {
    fs.linkSync(staged, cleanup);
    hooks.afterCleanupLink?.();
  }
  const linkedStage = readPublicationArtifact(staged, maximumBytes);
  if (!linkedStage || !sameArtifact(canonicalFile, linkedStage)) {
    fail("staged authority changed before detach");
  }
  unlinkExactArtifact(staged, linkedStage, undefined, maximumBytes);
  hooks.afterStageDetach?.();
  const linkedCleanup = readPublicationArtifact(cleanup, maximumBytes);
  if (!linkedCleanup || !sameArtifact(canonicalFile, linkedCleanup)) {
    fail("cleanup authority changed before detach");
  }
  unlinkExactArtifact(cleanup, linkedCleanup, hooks.beforeCleanupUnlink, maximumBytes);
}

function reconcilePublicationArtifacts(
  canonical: string,
  staged: string,
  cleanup: string,
  expectedBytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): "complete" | "staged" | "absent" {
  const canonicalFile = readPublicationArtifact(canonical, maximumBytes);
  const stagedFile = readPublicationArtifact(staged, maximumBytes);
  const cleanupFile = readPublicationArtifact(cleanup, maximumBytes);
  const artifacts = [canonicalFile, stagedFile, cleanupFile].filter(
    (artifact): artifact is ExactFile => artifact !== null,
  );
  if (artifacts.some((artifact) => !artifact.bytes.equals(expectedBytes))) {
    fail("publication artifacts disagree");
  }
  if (
    artifacts.length > 1 &&
    artifacts.some((artifact) => !sameArtifact(artifacts[0]!, artifact))
  ) {
    fail("publication artifacts have different generations");
  }
  const expectedLinks = BigInt(artifacts.length);
  if (artifacts.some((artifact) => artifact.identity.nlink !== expectedLinks)) {
    fail("publication artifacts have unaccounted links");
  }
  if (canonicalFile) {
    if (stagedFile) {
      detachPublishedStage(canonical, staged, cleanup, expectedBytes, hooks, maximumBytes);
    } else if (cleanupFile) {
      unlinkExactArtifact(cleanup, cleanupFile, hooks.beforeCleanupUnlink, maximumBytes);
    }
    return "complete";
  }
  if (stagedFile && cleanupFile) {
    unlinkExactArtifact(cleanup, cleanupFile, undefined, maximumBytes);
    return "staged";
  }
  if (cleanupFile) {
    fs.linkSync(cleanup, staged);
    const restored = readPublicationArtifact(staged, maximumBytes);
    if (!restored || !sameArtifact(cleanupFile, restored))
      fail("could not restore staged authority");
    unlinkExactArtifact(cleanup, cleanupFile, undefined, maximumBytes);
    return "staged";
  }
  return stagedFile ? "staged" : "absent";
}

function stageLinkCount(target: string): bigint | null {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`publication artifact is unsafe: ${target}`);
    return stat.nlink;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Copy an exact temporary create policy into private durable transaction custody. */
export function publishHermesPortableDurablePolicySource(input: {
  readonly sandboxName: string;
  readonly transactionId: string;
  readonly stateDir: string;
  readonly source: HermesPortablePolicyPublicationSource;
  readonly hooks?: HermesPortableReceiptPublicationHooks;
}): HermesPortablePolicySource {
  const hooks = input.hooks ?? {};
  const assertLifecycleLock =
    hooks.assertLifecycleLock ??
    (() => {
      if (!isMcpLifecycleLockHeld(input.sandboxName, path.join(input.stateDir, "state"))) {
        fail(`policy publication requires the sandbox lifecycle lock for '${input.sandboxName}'`);
      }
    });
  assertLifecycleLock();
  assertHermesPortablePolicyPublicationSource(input.source);
  if (existingPath(portableDemoReceiptPath(input.sandboxName, input.stateDir))) {
    fail(`will not reserve policy over an OpenClaw-owned source for '${input.sandboxName}'`);
  }
  const directory = ensureReceiptDirectory(input.sandboxName, input.stateDir);
  const target = hermesPortablePolicySourcePath(
    input.sandboxName,
    input.transactionId,
    input.stateDir,
  );
  const staged = policyStagePath(directory.path, input.transactionId, input.source.sha256);
  const cleanup = cleanupPath(staged);
  try {
    revalidateDirectory(directory);
    assertLifecycleLock();
    const allowedEntries = new Set([
      "active.json",
      "configuring.json",
      "pending.json",
      path.basename(target),
      path.basename(staged),
      path.basename(cleanup),
    ]);
    const unexpected = fs
      .readdirSync(directory.path)
      .filter(
        (entry) =>
          !allowedEntries.has(entry) &&
          pendingPublicationTransactionId(entry) !== input.transactionId,
      );
    if (unexpected.length > 0) {
      fail(`directory contains other policy source for '${input.sandboxName}'`);
    }
    retireInterruptedEmptyStage(
      target,
      staged,
      cleanup,
      directory,
      assertLifecycleLock,
      MAX_POLICY_BYTES,
    );
    retireInterruptedExactPrefixStage(
      target,
      staged,
      cleanup,
      directory,
      input.source.bytes,
      assertLifecycleLock,
      hooks,
      MAX_POLICY_BYTES,
    );
    const disposition = reconcilePublicationArtifacts(
      target,
      staged,
      cleanup,
      input.source.bytes,
      hooks,
      MAX_POLICY_BYTES,
    );
    const reconciled = readExactFile(target, 1n, MAX_POLICY_BYTES);
    if (reconciled) {
      if (!reconciled.bytes.equals(input.source.bytes))
        fail("durable policy has different content");
      assertHermesPortablePolicyPublicationSource(input.source);
      fs.fsyncSync(directory.descriptor);
      return policySourceFromFile(target, reconciled);
    }
    if (disposition === "complete") fail("completed policy publication has no readable source");
    if (disposition === "absent") writeStage(staged, input.source.bytes, hooks);
    revalidateDirectory(directory);
    assertHermesPortablePolicyPublicationSource(input.source);
    assertLifecycleLock();
    fsyncExactStage(staged, input.source.bytes, hooks, MAX_POLICY_BYTES);
    revalidateDirectory(directory);
    try {
      fs.linkSync(staged, target);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const raced = readExactFile(target, 1n, MAX_POLICY_BYTES);
      if (!raced || !raced.bytes.equals(input.source.bytes)) {
        fail("durable policy publication raced another writer");
      }
    }
    hooks.afterCanonicalLink?.();
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    hooks.afterDirectoryFsync?.();
    detachPublishedStage(target, staged, cleanup, input.source.bytes, hooks, MAX_POLICY_BYTES);
    assertLifecycleLock();
    assertHermesPortablePolicyPublicationSource(input.source);
    fs.fsyncSync(directory.descriptor);
    const published = readExactFile(target, 1n, MAX_POLICY_BYTES);
    if (!published || !published.bytes.equals(input.source.bytes)) {
      fail("durable policy publication did not preserve exact bytes");
    }
    return policySourceFromFile(target, published);
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/**
 * Find one private policy generation whose pending receipt was not yet linked.
 * The caller must resume it with the exact current policy bytes under the same
 * sandbox lifecycle lock. Receipt readers continue to reject this state.
 */
export function recoverableHermesPortablePolicyTransactionId(
  sandboxName: string,
  stateDir: string,
): string | null {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`policy recovery requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  const directoryPath = hermesPortableReceiptDirectory(sandboxName, stateDir);
  let directory: OpenReceiptDirectory;
  try {
    directory = validateDirectory(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const entries = fs.readdirSync(directory.path).sort();
    if (entries.length === 0 || entries.some((entry) => entry.endsWith(".json"))) return null;
    const transactionIds = entries.map(
      (entry) => policyPublicationTransactionId(entry) ?? pendingPublicationTransactionId(entry),
    );
    if (
      entries.length > 5 ||
      !entries.some((entry) => policyPublicationTransactionId(entry) !== null) ||
      transactionIds.some((transactionId) => transactionId === null) ||
      new Set(transactionIds).size !== 1
    ) {
      fail(`directory has ambiguous pre-receipt policy source for '${sandboxName}'`);
    }
    revalidateDirectory(directory);
    return transactionIds[0]!;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function validateReceiptPolicySource(
  directoryPath: string,
  receipt: HermesPortablePendingReceipt,
  semanticOnly = false,
): HermesPortablePolicySource {
  const expected = path.join(directoryPath, policySourceBasename(receipt.transactionId));
  if (receipt.policy.sourcePath !== expected) fail("policy source path is outside receipt custody");
  if (!semanticOnly) {
    assertHermesPortablePolicySource(receipt.policy);
    return receipt.policy;
  }
  return requalifyHermesPortablePolicySource(receipt.policy).source;
}

function readPhase(
  directory: string,
  phase: HermesPortableReceiptPhase,
  allowPublicationLinks = false,
): HermesPortableReceiptSnapshot | null {
  const target = phasePath(directory, phase);
  const file = allowPublicationLinks ? readPublicationArtifact(target) : readExactFile(target);
  if (!file) return null;
  const receipt = parseReceiptBytes(file.bytes);
  if (receipt.phase !== phase) fail(`phase file '${phase}' contains another phase`);
  return {
    receipt,
    bytes: file.bytes,
    sha256: receiptHash(file.bytes),
    path: target,
    identity: { dev: file.identity.dev, ino: file.identity.ino },
  };
}

function readSuccessor(
  directory: string,
  allowPublicationLinks = false,
): HermesPortableSuccessorSnapshot | null {
  const target = successorPath(directory);
  const file = allowPublicationLinks ? readPublicationArtifact(target) : readExactFile(target);
  if (!file) return null;
  const receipt = parseSuccessorBytes(file.bytes);
  return {
    receipt,
    bytes: file.bytes,
    sha256: receiptHash(file.bytes),
    path: target,
    identity: { dev: file.identity.dev, ino: file.identity.ino },
  };
}

function sameTransaction(
  left: HermesPortableLifecycleReceipt,
  right: HermesPortableLifecycleReceipt,
): boolean {
  const transactionAuthority = (receipt: HermesPortableLifecycleReceipt) => {
    if (receipt.phase === "pending") {
      const { phase: _phase, policy: _policy, ...common } = receipt;
      return common;
    }
    const {
      phase: _phase,
      container: _container,
      previousPhaseSha256: _previous,
      ...common
    } = receipt;
    return common;
  };
  return isDeepStrictEqual(transactionAuthority(left), transactionAuthority(right));
}

function validateRecoverablePhaseArtifacts(
  directoryPath: string,
  entries: readonly string[],
  pending: HermesPortableReceiptSnapshot,
  highest: HermesPortableReceiptPhase,
): void {
  const artifacts = entries
    .map((entry) => ({ entry, identity: phasePublicationIdentity(entry) }))
    .filter(
      (
        candidate,
      ): candidate is {
        readonly entry: string;
        readonly identity: NonNullable<ReturnType<typeof phasePublicationIdentity>>;
      } => candidate.identity !== null,
    );
  const allowedPhases: readonly HermesPortableReceiptPhase[] =
    highest === "pending"
      ? ["pending", "configuring"]
      : highest === "configuring"
        ? ["configuring", "active"]
        : ["active"];
  const generationSha256 = receiptHash(Buffer.from(pending.receipt.lifecycleGeneration, "utf8"));
  if (
    artifacts.length > 2 ||
    artifacts.some(
      ({ identity }) =>
        identity.transactionId !== pending.receipt.transactionId ||
        identity.createIntentSha256 !== pending.receipt.createIntentSha256 ||
        identity.generationSha256 !== generationSha256 ||
        !allowedPhases.includes(identity.phase),
    ) ||
    (artifacts.length > 0 && new Set(artifacts.map(({ identity }) => identity.phase)).size !== 1) ||
    (artifacts.length === 2 && artifacts.filter(({ identity }) => identity.cleanup).length !== 1)
  ) {
    fail("phase publication recovery evidence disagrees with the stable transaction");
  }
  for (const phase of ["pending", "configuring", "active"] as const) {
    const canonical = readPublicationArtifact(phasePath(directoryPath, phase));
    const phaseArtifactEntries = artifacts.filter(({ identity }) => identity.phase === phase);
    const phaseArtifacts = phaseArtifactEntries
      .map(({ entry }) => readPublicationArtifact(path.join(directoryPath, entry)))
      .filter((artifact): artifact is ExactFile => artifact !== null);
    const expectedLinks = BigInt(phaseArtifacts.length + (canonical ? 1 : 0));
    const authority = canonical ?? phaseArtifacts[0] ?? null;
    if (
      authority &&
      (phaseArtifacts.length !== phaseArtifactEntries.length ||
        authority.identity.nlink !== expectedLinks ||
        phaseArtifacts.some(
          (artifact) =>
            artifact.identity.nlink !== expectedLinks || !sameArtifact(authority, artifact),
        ))
    ) {
      fail("phase publication recovery artifacts have unaccounted or different generations");
    }
  }
}

function readHermesPortableLifecycleReceiptInternal(
  sandboxName: string,
  stateDir: string,
  allowPublicationRecovery: boolean,
  allowSuccessorPublicationRecovery = false,
  semanticPolicyRequalification = false,
): HermesPortableReceiptSnapshot | null {
  const directoryPath = hermesPortableReceiptDirectory(sandboxName, stateDir);
  let directory: OpenReceiptDirectory;
  try {
    directory = validateDirectory(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const entries = fs.readdirSync(directory.path).sort();
    const completePolicy = /^policy\.[a-f0-9-]{36}\.yaml$/u;
    const hasSuccessor = entries.includes("authority.json");
    if (
      entries.length > MAX_DIRECTORY_ENTRIES ||
      entries.some(
        (entry) =>
          !["active.json", "authority.json", "configuring.json", "pending.json"].includes(entry) &&
          !completePolicy.test(entry) &&
          !(allowPublicationRecovery && phasePublicationIdentity(entry)) &&
          !(allowSuccessorPublicationRecovery && successorPublicationIdentity(entry)),
      )
    ) {
      fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
    }
    const pending = readPhase(directoryPath, "pending", allowPublicationRecovery);
    const configuring = readPhase(directoryPath, "configuring", allowPublicationRecovery);
    const active = readPhase(directoryPath, "active", allowPublicationRecovery);
    const successor = hasSuccessor
      ? readSuccessor(directoryPath, allowSuccessorPublicationRecovery)
      : null;
    if (!pending && !active) {
      if (entries.length > 0)
        fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
      revalidateDirectory(directory);
      return null;
    }
    if (!pending && (!active || !successor)) {
      fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
    }
    const transactionId = pending?.receipt.transactionId ?? active!.receipt.transactionId;
    const allowedEntries = new Set([
      "active.json",
      "authority.json",
      "configuring.json",
      "pending.json",
      policySourceBasename(transactionId),
    ]);
    const highestPhase = active ? "active" : configuring ? "configuring" : "pending";
    if (allowPublicationRecovery && pending) {
      validateRecoverablePhaseArtifacts(directoryPath, entries, pending, highestPhase);
    }
    if (
      entries.some(
        (entry) =>
          !allowedEntries.has(entry) &&
          !(allowPublicationRecovery && phasePublicationIdentity(entry)) &&
          !(allowSuccessorPublicationRecovery && successorPublicationIdentity(entry)),
      )
    ) {
      fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
    }
    if (pending && !configuring && !active) {
      validateReceiptPolicySource(
        directoryPath,
        pending.receipt as HermesPortablePendingReceipt,
        hasSuccessor || semanticPolicyRequalification,
      );
    }
    revalidateDirectory(directory);
    for (const snapshot of [pending, configuring, active]) {
      if (snapshot && snapshot.receipt.sandboxName !== sandboxName) {
        fail("sandbox identity does not match its path");
      }
    }
    if (configuring) {
      if (configuring.receipt.phase !== "configuring") {
        fail("configuring phase contains invalid authority");
      }
      if (pending) {
        if (
          configuring.receipt.previousPhaseSha256 !== pending.sha256 ||
          !sameTransaction(pending.receipt, configuring.receipt)
        ) {
          fail("configuring phase does not extend pending authority");
        }
      } else if (!active || !successor) {
        fail("configuring phase has no pending authority");
      }
    }
    if (active) {
      const activeReceipt = active.receipt;
      if (activeReceipt.phase !== "active") {
        fail("active phase files contain invalid phase authority");
      }
      if (configuring) {
        const configuringReceipt = configuring.receipt;
        if (configuringReceipt.phase !== "configuring") {
          fail("configuring phase contains invalid authority");
        }
        if (
          activeReceipt.previousPhaseSha256 !== configuring.sha256 ||
          !sameTransaction(configuringReceipt, activeReceipt) ||
          activeReceipt.container.containerId !== configuringReceipt.container.containerId ||
          activeReceipt.container.sandboxId !== configuringReceipt.container.sandboxId ||
          activeReceipt.container.imageId !== configuringReceipt.container.imageId
        ) {
          fail("active phase does not extend configuring authority");
        }
      } else if (!successor) {
        fail("active phase has no configuring authority");
      } else if (pending && !sameTransaction(pending.receipt, activeReceipt)) {
        fail("active phase disagrees with pending transaction history");
      }
    }
    const highest = active ?? configuring ?? pending;
    if (!highest) fail("lifecycle receipt has no complete authority");
    const successorArtifacts = entries
      .map((entry) => successorPublicationIdentity(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (
      successorArtifacts.length > 0 &&
      (!allowSuccessorPublicationRecovery ||
        !active ||
        successorArtifacts.some(
          ({ predecessorActiveSha256 }) => predecessorActiveSha256 !== active.sha256,
        ))
    ) {
      fail("schema-8 publication recovery evidence disagrees with active authority");
    }
    if (hasSuccessor) {
      if (!active) {
        fail("schema-8 successor has no active schema-7 predecessor");
      }
      if (!successor) fail("schema-8 successor authority disappeared");
      const expected = createHermesPortableSuccessorReceipt(
        active as HermesPortableReceiptSnapshot & {
          readonly receipt: HermesPortableConfiguredReceipt;
        },
      );
      if (
        successor.receipt.predecessorActiveSha256 !== active.sha256 ||
        !isDeepStrictEqual(successor.receipt, expected)
      ) {
        fail("schema-8 successor disagrees with its schema-7 predecessor");
      }
      return {
        ...active,
        successor,
        ...(successorArtifacts.length > 0 ? { successorPublicationPending: true as const } : {}),
      };
    }
    if (semanticPolicyRequalification && active) {
      return {
        ...active,
        ...(successorArtifacts.length > 0 ? { successorPublicationPending: true as const } : {}),
      };
    }
    return successorArtifacts.length > 0
      ? { ...highest, successorPublicationPending: true }
      : highest;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/** Read the highest complete Hermes phase. Any unknown or interrupted artifact blocks. */
export function readHermesPortableLifecycleReceipt(
  sandboxName: string,
  stateDir: string,
): HermesPortableReceiptSnapshot | null {
  return readHermesPortableLifecycleReceiptInternal(sandboxName, stateDir, false);
}

/** Read exact schema-7 bytes while permitting only operation-local policy identity drift. */
export function readHermesPortableLifecycleReceiptForRequalification(
  sandboxName: string,
  stateDir: string,
): HermesPortableReceiptSnapshot | null {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`schema-8 requalification requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  return readHermesPortableLifecycleReceiptInternal(sandboxName, stateDir, false, true, true);
}

/** Classify copied same-path authority without publishing or admitting staged evidence. */
export function readHermesPortableLifecycleReceiptForClassification(
  sandboxName: string,
  stateDir: string,
): HermesPortableReceiptSnapshot | null {
  return readHermesPortableLifecycleReceiptInternal(sandboxName, stateDir, false, false, true);
}

/** Route a probe toward the host fence without interpreting receipt identity. */
export function hasHermesPortableReceiptCandidate(sandboxName: string, stateDir: string): boolean {
  try {
    fs.lstatSync(hermesPortableReceiptDirectory(sandboxName, stateDir));
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Select stable receipt identity while its same-transaction publisher resumes under the lock. */
export function inspectPortableAgentReceiptAuthorityForPublicationRecovery(
  sandboxName: string,
  stateDir: string,
): PortableAgentReceiptAuthority {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`publication recovery requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  const legacyPath = portableDemoReceiptPath(sandboxName, stateDir);
  const openclaw = existingPath(legacyPath);
  const hermes = readHermesPortableLifecycleReceiptInternal(sandboxName, stateDir, true, true);
  if (openclaw && hermes) fail(`agent authority is ambiguous for '${sandboxName}'`);
  if (hermes) return { kind: "hermes", snapshot: hermes };
  if (openclaw) return { kind: "openclaw", path: legacyPath };
  return { kind: "none" };
}

/** Select copied authority and exact staged evidence only for the locked probe path. */
export function inspectPortableAgentReceiptAuthorityForRequalification(
  sandboxName: string,
  stateDir: string,
): PortableAgentReceiptAuthority {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`schema-8 requalification requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  const legacyPath = portableDemoReceiptPath(sandboxName, stateDir);
  const openclaw = existingPath(legacyPath);
  const hermes = readHermesPortableLifecycleReceiptInternal(
    sandboxName,
    stateDir,
    true,
    true,
    true,
  );
  if (openclaw && hermes) fail(`agent authority is ambiguous for '${sandboxName}'`);
  if (hermes) return { kind: "hermes", snapshot: hermes };
  if (openclaw) return { kind: "openclaw", path: legacyPath };
  return { kind: "none" };
}

/** Detach only the stable phase's exact same-transaction publication artifacts. */
export function reconcileHermesPortableCurrentPhasePublication(
  snapshot: HermesPortableReceiptSnapshot,
  stateDir: string,
): HermesPortableReceiptSnapshot {
  const directory = path.dirname(snapshot.path);
  const staged = stagePath(directory, snapshot.receipt);
  if (stageLinkCount(staged) === null && stageLinkCount(cleanupPath(staged)) === null) {
    return snapshot;
  }
  return publishHermesPortableLifecycleReceipt(snapshot.receipt, stateDir);
}

/** Publish one immutable phase without replacing an earlier phase generation. */
export function publishHermesPortableLifecycleReceipt(
  receipt: HermesPortableLifecycleReceipt,
  stateDir: string,
  hooks: HermesPortableReceiptPublicationHooks = {},
): HermesPortableReceiptSnapshot {
  const bytes = serializeReceipt(receipt);
  const assertLifecycleLock =
    hooks.assertLifecycleLock ??
    (() => {
      if (!isMcpLifecycleLockHeld(receipt.sandboxName, path.join(stateDir, "state"))) {
        fail(`publication requires the sandbox lifecycle lock for '${receipt.sandboxName}'`);
      }
    });
  assertLifecycleLock();
  if (existingPath(portableDemoReceiptPath(receipt.sandboxName, stateDir))) {
    fail(`will not publish over OpenClaw authority for '${receipt.sandboxName}'`);
  }
  const directory = ensureReceiptDirectory(receipt.sandboxName, stateDir);
  const target = phasePath(directory.path, receipt.phase);
  const staged = stagePath(directory.path, receipt);
  const cleanup = cleanupPath(staged);
  try {
    revalidateDirectory(directory);
    assertLifecycleLock();
    const allowedEntries = new Set([
      "active.json",
      "authority.json",
      "configuring.json",
      "pending.json",
      policySourceBasename(receipt.transactionId),
      path.basename(staged),
      path.basename(cleanup),
    ]);
    const unexpected = fs.readdirSync(directory.path).filter((entry) => !allowedEntries.has(entry));
    if (unexpected.length > 0) {
      fail(`directory contains other publication evidence for '${receipt.sandboxName}'`);
    }
    const successor = readSuccessor(directory.path);
    if (successor) {
      if (receipt.phase !== "active") {
        fail("schema-8 successor conflicts with incomplete schema-7 publication");
      }
      const expected = createHermesPortableSuccessorReceipt({
        receipt,
        bytes,
        sha256: receiptHash(bytes),
        path: target,
        identity: successor.identity,
      });
      if (!isDeepStrictEqual(successor.receipt, expected)) {
        fail("schema-8 successor disagrees with the active schema-7 publication");
      }
    }
    const prior =
      receipt.phase === "pending"
        ? null
        : readPhase(directory.path, receipt.phase === "configuring" ? "pending" : "configuring");
    if (receipt.phase !== "pending") {
      if (!prior || receipt.previousPhaseSha256 !== prior.sha256) {
        fail(`${receipt.phase} publication does not match its prior phase`);
      }
      if (!sameTransaction(prior.receipt, receipt)) fail("phase transaction changed");
    }

    retireInterruptedEmptyStage(target, staged, cleanup, directory, assertLifecycleLock);
    retireInterruptedExactPrefixStage(
      target,
      staged,
      cleanup,
      directory,
      bytes,
      assertLifecycleLock,
      hooks,
    );
    const disposition = reconcilePublicationArtifacts(target, staged, cleanup, bytes, hooks);
    const reconciled = readPhase(directory.path, receipt.phase);
    if (reconciled) {
      if (!reconciled.bytes.equals(bytes)) fail(`${receipt.phase} phase has other authority`);
      fs.fsyncSync(directory.descriptor);
      return reconciled;
    }

    if (disposition === "complete") fail("completed publication has no readable phase");
    if (disposition === "absent") {
      writeStage(staged, bytes, hooks);
    }
    revalidateDirectory(directory);
    assertLifecycleLock();
    fsyncExactStage(staged, bytes, hooks);
    revalidateDirectory(directory);
    try {
      fs.linkSync(staged, target);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const raced = readPhase(directory.path, receipt.phase);
      if (!raced || !raced.bytes.equals(bytes)) fail("phase publication raced another writer");
    }
    hooks.afterCanonicalLink?.();
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    hooks.afterDirectoryFsync?.();
    detachPublishedStage(target, staged, cleanup, bytes, hooks);
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    return readPhase(directory.path, receipt.phase)!;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/** Publish policy-free operating authority before retiring policy-bearing create history. */
export function publishHermesPortableSuccessorReceipt(
  sandboxName: string,
  stateDir: string,
  hooks: HermesPortableReceiptPublicationHooks = {},
  requalification?: HermesPortableSuccessorRequalificationAuthority,
): HermesPortableReceiptSnapshot & {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly successor: HermesPortableSuccessorSnapshot;
} {
  const assertLifecycleLock =
    hooks.assertLifecycleLock ??
    (() => {
      if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
        fail(`schema-8 publication requires the sandbox lifecycle lock for '${sandboxName}'`);
      }
    });
  if (requalification) {
    if (requalification.expected.receipt.sandboxName !== sandboxName) {
      fail("schema-8 requalification authority names another sandbox");
    }
    assertCurrentPortableHostFenceHeld(requalification.expected.receipt.runtimeAuthority.homeDir);
  }
  const assertPublicationAuthority = () => {
    assertLifecycleLock();
    requalification?.assertCurrent();
  };
  assertPublicationAuthority();
  if (existingPath(portableDemoReceiptPath(sandboxName, stateDir))) {
    fail(`will not publish schema-8 authority over OpenClaw authority for '${sandboxName}'`);
  }
  const active = readHermesPortableLifecycleReceiptInternal(
    sandboxName,
    stateDir,
    false,
    true,
    requalification !== undefined,
  );
  if (!active || active.receipt.phase !== "active") {
    fail("schema-8 publication requires complete active schema-7 authority");
  }
  if (
    requalification &&
    (active.path !== requalification.expected.path ||
      active.identity.dev !== requalification.expected.identity.dev ||
      active.identity.ino !== requalification.expected.identity.ino ||
      active.sha256 !== requalification.expected.sha256 ||
      !active.bytes.equals(requalification.expected.bytes) ||
      active.successorPublicationPending !== requalification.expected.successorPublicationPending)
  ) {
    fail("schema-8 requalification authority changed before publication");
  }
  const receipt = createHermesPortableSuccessorReceipt(
    active as HermesPortableReceiptSnapshot & {
      readonly receipt: HermesPortableConfiguredReceipt;
    },
  );
  const bytes = serializeSuccessor(receipt);
  const directory = validateDirectory(path.dirname(active.path));
  const target = successorPath(directory.path);
  const staged = successorStagePath(directory.path, active.sha256);
  const cleanup = cleanupPath(staged);
  try {
    revalidateDirectory(directory);
    assertPublicationAuthority();
    const allowedEntries = new Set([
      "active.json",
      "authority.json",
      "configuring.json",
      "pending.json",
      policySourceBasename(active.receipt.transactionId),
      path.basename(staged),
      path.basename(cleanup),
    ]);
    const unexpected = fs.readdirSync(directory.path).filter((entry) => !allowedEntries.has(entry));
    if (unexpected.length > 0) {
      fail(`directory contains other schema-8 publication evidence for '${sandboxName}'`);
    }
    retireInterruptedEmptyStage(target, staged, cleanup, directory, assertPublicationAuthority);
    retireInterruptedExactPrefixStage(
      target,
      staged,
      cleanup,
      directory,
      bytes,
      assertPublicationAuthority,
      hooks,
    );
    const disposition = reconcilePublicationArtifacts(target, staged, cleanup, bytes, hooks);
    const reconciled = readSuccessor(directory.path);
    if (reconciled) {
      if (!reconciled.bytes.equals(bytes)) fail("schema-8 successor has other authority");
      fs.fsyncSync(directory.descriptor);
      const current = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
      if (!current?.successor || current.receipt.phase !== "active") {
        fail("schema-8 successor could not be requalified after reconciliation");
      }
      assertPublicationAuthority();
      return current as typeof current & {
        readonly receipt: HermesPortableConfiguredReceipt;
        readonly successor: HermesPortableSuccessorSnapshot;
      };
    }
    if (disposition === "complete") fail("completed schema-8 publication is unreadable");
    if (disposition === "absent") writeStage(staged, bytes, hooks);
    revalidateDirectory(directory);
    assertPublicationAuthority();
    fsyncExactStage(staged, bytes, hooks);
    revalidateDirectory(directory);
    try {
      fs.linkSync(staged, target);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const raced = readSuccessor(directory.path);
      if (!raced || !raced.bytes.equals(bytes)) fail("schema-8 publication raced another writer");
    }
    hooks.afterCanonicalLink?.();
    assertPublicationAuthority();
    fs.fsyncSync(directory.descriptor);
    hooks.afterDirectoryFsync?.();
    detachPublishedStage(target, staged, cleanup, bytes, hooks);
    assertPublicationAuthority();
    fs.fsyncSync(directory.descriptor);
    const published = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
    if (!published?.successor || published.receipt.phase !== "active") {
      fail("schema-8 successor disappeared after publication");
    }
    assertPublicationAuthority();
    return published as typeof published & {
      readonly receipt: HermesPortableConfiguredReceipt;
      readonly successor: HermesPortableSuccessorSnapshot;
    };
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function existingPath(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`legacy receipt path is unsafe: ${target}`);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Select receipt identity by durable agent identity and reject duplicate ownership. */
export function inspectPortableAgentReceiptAuthority(
  sandboxName: string,
  stateDir: string,
): PortableAgentReceiptAuthority {
  const legacyPath = portableDemoReceiptPath(sandboxName, stateDir);
  const openclaw = existingPath(legacyPath);
  const hermes = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (openclaw && hermes) fail(`agent authority is ambiguous for '${sandboxName}'`);
  if (hermes) return { kind: "hermes", snapshot: hermes };
  if (openclaw) return { kind: "openclaw", path: legacyPath };
  return { kind: "none" };
}

/** Select agent authority for read-only routing across a replaceable-HOME transition. */
export function inspectPortableAgentReceiptAuthorityForClassification(
  sandboxName: string,
  stateDir: string,
): PortableAgentReceiptAuthority {
  const legacyPath = portableDemoReceiptPath(sandboxName, stateDir);
  const openclaw = existingPath(legacyPath);
  const hermes = readHermesPortableLifecycleReceiptForClassification(sandboxName, stateDir);
  if (openclaw && hermes) fail(`agent authority is ambiguous for '${sandboxName}'`);
  if (hermes) return { kind: "hermes", snapshot: hermes };
  if (openclaw) return { kind: "openclaw", path: legacyPath };
  return { kind: "none" };
}

export function createHermesPortableTransactionId(): string {
  return randomUUID();
}

export const hermesPortableReceiptInternals = {
  parseReceiptBytes,
  parseSuccessorBytes,
  phasePath,
  policyStagePath,
  stagePath,
  successorPath,
  successorStagePath,
};
