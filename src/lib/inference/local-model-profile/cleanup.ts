// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContainerEngine } from "../../adapters/container-engine";
import { dockerCapture, dockerForceRm, dockerRun } from "../../adapters/docker/local-model-runtime";
import {
  createManagedLlamaCppEngine,
  dockerLlamaCppBindingSha256,
} from "../../onboard/runtime-provider/docker-llama-cpp-operation";
import {
  createDockerLlamaCppPrivateBridgeController,
  type DockerLlamaCppPrivateBridgeController,
} from "../../onboard/runtime-provider/docker-llama-cpp-private-bridge";
import {
  createHostLocalCreateJournalStore,
  HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
  reconcileAndReadHostLocalCreateJournalRecords,
  serializeHostLocalCreateJournalRecord,
  type HostLocalCreateJournalExecutionLease,
  type HostLocalCreateJournalRecord,
  type HostLocalCreateJournalStore,
} from "../../onboard/runtime-provider/host-local-create-journal";
import {
  createFilePersistedEngineAuthorityStore,
  openFilePersistedEngineAuthorityStore,
  PERSISTED_ENGINE_AUTHORITY_DIRECTORY,
  requirePersistedEngineAuthority,
  serializePersistedEngineAuthority,
} from "../../onboard/runtime-provider/persisted-engine-authority";
import {
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
} from "../llama-cpp/managed-installer";
import {
  loadManagedLlamaCppOwner,
  loadManagedLlamaCppReceipt,
  MANAGED_LLAMA_CPP_API_KEY_FILE,
  MANAGED_LLAMA_CPP_OWNER_FILE,
  MANAGED_LLAMA_CPP_RECEIPT_FILE,
  type ManagedLlamaCppStatePaths,
  managedLlamaCppStatePaths,
} from "../llama-cpp/managed-state";
import {
  normalizeHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
  type HostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
  MANAGED_VLLM_API_KEY_FILE,
} from "../serving/managed-runtime-receipts";
import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CONTAINER_NAME,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  validateHostLocalVllmRuntimeReceipt,
} from "../serving/vllm-host-local-lifecycle";
import { loadManagedVllmApiKey, managedVllmStateDir } from "../vllm-api-key";

export { HOST_LOCAL_VLLM_CONTAINER_NAME, HOST_LOCAL_VLLM_MANAGED_LABEL };

const LLAMA_MANAGED_LABEL = "io.nvidia.nemoclaw.host-local-inference.managed";
const LLAMA_PROVIDER_LABEL = "io.nvidia.nemoclaw.host-local-inference.provider";
const LLAMA_SERVICE_LABEL = "io.nvidia.nemoclaw.host-local-inference.service";
const LLAMA_SPEC_LABEL = "io.nvidia.nemoclaw.host-local-inference.spec-sha256";
const LLAMA_TRANSACTION_LABEL = "io.nvidia.nemoclaw.host-local-inference.transaction-sha256";
const LLAMA_NETWORK_TRANSACTION_LABEL =
  "io.nvidia.nemoclaw.host-local-inference.network-transaction-sha256";
const HUGGING_FACE_CREDENTIAL_ENTRIES = new Set(["stored_tokens", "token"]);
const MANAGED_LLAMA_CPP_PRIVATE_FILE_MAX_BYTES = 64 * 1024;
const HOST_LOCAL_CREATE_JOURNAL_RECORD_FILE = /^[a-f0-9]{64}\.json$/u;
const HOST_LOCAL_CREATE_JOURNAL_TRANSIENT_FILES = new Set([
  ".execution-lease.json",
  ".execution-recovery.json",
]);

interface CleanupDeps {
  capture: typeof dockerCapture;
  currentUserId: number | null;
  forceRm: typeof dockerForceRm;
  run: typeof dockerRun;
}

export interface LocalModelRuntimeCleanupOptions {
  gatewayPort?: number;
  homeDir?: string;
  sandboxName?: string;
  env?: NodeJS.ProcessEnv;
  engine?: ContainerEngine;
  privateBridge?: DockerLlamaCppPrivateBridgeController;
  deps?: Partial<CleanupDeps>;
}

export interface HuggingFaceCacheDataCleanupOptions {
  homeDir?: string;
  currentUserId?: number | null;
}

export type LocalModelRuntimeCleanupResult =
  | { ok: true; removed: string[]; preserved: string[] }
  | { ok: false; reason: string; removed: string[]; preserved: string[] };

type InspectedResource =
  | { kind: "absent" }
  | { kind: "foreign" }
  | { kind: "owned"; id: string; row: Record<string, unknown> };

const DOCKER_INSPECT_TIMEOUT_MS = 15_000;
const DOCKER_MUTATION_TIMEOUT_MS = 30 * 60 * 1000;
const UNCERTAIN_CREATE_ABSENCE_GRACE_MS = DOCKER_MUTATION_TIMEOUT_MS + DOCKER_INSPECT_TIMEOUT_MS;

function inspectOwnedResource(
  kind: "container" | "network",
  name: string,
  ownerLabel: string,
  ownerValue: string,
  capture: typeof dockerCapture,
  expectedLabels: Readonly<Record<string, string>> = {},
): InspectedResource {
  const source = capture([kind, "inspect", name], {
    ignoreError: true,
    timeout: 10_000,
  }).trim();
  if (!source) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${kind} ${name} inspection returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${kind} ${name} inspection was ambiguous`);
  }
  const row = parsed[0] as Record<string, unknown>;
  const config = row.Config;
  const labels =
    kind === "container" && config && typeof config === "object" && !Array.isArray(config)
      ? (config as { Labels?: unknown }).Labels
      : row.Labels;
  const id = row.Id;
  const observedName = row.Name;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{12,64}$/u.test(id) ||
    observedName !== (kind === "container" ? `/${name}` : name) ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)[ownerLabel] !== ownerValue ||
    Object.entries(expectedLabels).some(
      ([label, value]) => (labels as Record<string, unknown>)[label] !== value,
    ) ||
    (kind === "network" &&
      (row.Internal !== true || row.Driver !== "bridge" || row.Scope !== "local"))
  ) {
    return { kind: "foreign" };
  }
  return { kind: "owned", id, row };
}

function distributedReceiptPresent(stateDir: string): boolean {
  return [MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE].some(
    (name) => fs.existsSync(path.join(stateDir, name)),
  );
}

function cleanupHostLocalVllm(stateDir: string, deps: CleanupDeps, removed: string[]): void {
  const hasDistributedReceipt = distributedReceiptPresent(stateDir);
  const inspected = inspectOwnedResource(
    "container",
    HOST_LOCAL_VLLM_CONTAINER_NAME,
    HOST_LOCAL_VLLM_MANAGED_LABEL,
    "true",
    deps.capture,
  );
  if (inspected.kind === "absent") return;
  if (inspected.kind === "foreign") {
    throw new Error("host-local vLLM container name is foreign while managed key state remains");
  }
  const config = inspected.row.Config as { Env?: unknown; Labels?: unknown } | undefined;
  const labels = config?.Labels as Record<string, unknown> | undefined;
  const authFingerprint = labels?.[HOST_LOCAL_VLLM_AUTH_LABEL];
  const dualRole = labels?.["com.nvidia.nemoclaw.vllm-role"];
  if (dualRole === "head" || dualRole === "worker") {
    if (hasDistributedReceipt) return;
    throw new Error("distributed vLLM container exists without its ownership receipt");
  }
  const apiKey = loadManagedVllmApiKey({ stateDir });
  const env = Array.isArray(config?.Env) ? config.Env : [];
  const keys = env.filter(
    (value): value is string => typeof value === "string" && value.startsWith("VLLM_API_KEY="),
  );
  if (
    !apiKey ||
    keys.length !== 1 ||
    keys[0] !== `VLLM_API_KEY=${apiKey}` ||
    authFingerprint !== runtimeAuthFingerprint(apiKey)
  ) {
    throw new Error("host-local vLLM ownership or authentication does not match persisted state");
  }
  const servingIdentity = validateHostLocalVllmRuntimeReceipt(
    { containerId: inspected.id, labels: labels ?? {}, authFingerprint },
    stateDir,
  );
  const removal = deps.forceRm(inspected.id, { ignoreError: true, suppressOutput: true });
  if (removal.status !== 0) throw new Error("host-local vLLM container removal failed");
  removed.push(`container:${inspected.id}`);
  if (servingIdentity) {
    fs.unlinkSync(path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE));
  }
  fs.unlinkSync(path.join(stateDir, MANAGED_VLLM_API_KEY_FILE));
}

function requirePrivateManagedState(paths: ManagedLlamaCppStatePaths, uid: number | null): void {
  const status = fs.lstatSync(paths.stateDir);
  if (status.isSymbolicLink()) throw new Error("managed llama.cpp state directory is a symlink");
  if (!status.isDirectory()) throw new Error("managed llama.cpp state path is not a directory");
  if (uid !== null && status.uid !== uid) {
    throw new Error("managed llama.cpp state directory is not owned by the current user");
  }
  const resolvedParent = fs.realpathSync(path.dirname(paths.stateDir));
  const resolvedStateDir = path.join(resolvedParent, path.basename(paths.stateDir));
  if ((status.mode & 0o077) !== 0 || fs.realpathSync(paths.stateDir) !== resolvedStateDir) {
    throw new Error("managed llama.cpp state directory is not private current-user authority");
  }
}

function statePathExists(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

function canonicalCleanupHomeDir(homeDir: string): string {
  return statePathExists(homeDir) ? fs.realpathSync(homeDir) : path.resolve(homeDir);
}

function sharedHuggingFaceCacheDir(homeDir: string): string {
  return path.join(homeDir, ".cache", "huggingface");
}

function requireCurrentUserCacheDirectory(
  directory: string,
  label: string,
  currentUserId: number | null,
): void {
  if (currentUserId === null) {
    throw new Error(`${label} ownership cannot be verified on this host`);
  }
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!status.isDirectory()) throw new Error(`${label} is not a directory`);
  if (status.uid !== currentUserId) {
    throw new Error(`${label} is not owned by the current user`);
  }
  const expectedPath = path.join(
    fs.realpathSync(path.dirname(directory)),
    path.basename(directory),
  );
  if ((status.mode & 0o022) !== 0 || fs.realpathSync(directory) !== expectedPath) {
    throw new Error(`${label} is not current-user filesystem authority`);
  }
}

function removeSharedHuggingFaceCacheData(
  homeDir: string,
  currentUserId: number | null,
  removed: string[],
  preserved: string[],
): void {
  const cacheDir = sharedHuggingFaceCacheDir(homeDir);
  if (!statePathExists(cacheDir)) return;
  const cacheParent = path.dirname(cacheDir);
  requireCurrentUserCacheDirectory(cacheParent, "Hugging Face cache parent", currentUserId);
  requireCurrentUserCacheDirectory(cacheDir, "Hugging Face model cache", currentUserId);
  const entries = fs.readdirSync(cacheDir);
  let deletedCacheData = false;
  for (const entry of entries) {
    const target = path.join(cacheDir, entry);
    if (HUGGING_FACE_CREDENTIAL_ENTRIES.has(entry)) {
      preserved.push(target);
      continue;
    }
    fs.rmSync(target, { force: true, recursive: true });
    deletedCacheData = true;
  }
  const unexpectedEntry = fs
    .readdirSync(cacheDir)
    .find((entry) => !HUGGING_FACE_CREDENTIAL_ENTRIES.has(entry));
  if (unexpectedEntry) {
    throw new Error(
      `Hugging Face cache cleanup left an unexpected entry at ${path.join(cacheDir, unexpectedEntry)}`,
    );
  }
  if (deletedCacheData) removed.push(`cache-contents:${cacheDir}`);
}

function preserveSharedHuggingFaceCache(homeDir: string, preserved: string[]): void {
  const cacheDir = sharedHuggingFaceCacheDir(homeDir);
  if (statePathExists(cacheDir)) preserved.push(cacheDir);
}

function requireEngineSuccess(
  label: string,
  result: ReturnType<ContainerEngine["capture"]>,
): string {
  if (result.error || result.status !== 0) {
    throw new Error(`managed llama.cpp ${label} failed (exit ${String(result.status)})`);
  }
  return result.stdout;
}

function exactAbsenceProbe(
  engine: ContainerEngine,
  kind: "container" | "network",
  name: string,
): boolean {
  const filter = kind === "container" ? `name=^/${name}$` : `name=^${name}$`;
  const result = engine.capture(
    [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      "--no-trunc",
      "--filter",
      filter,
      "--format",
      "{{.ID}}",
    ],
    DOCKER_INSPECT_TIMEOUT_MS,
  );
  const rows = requireEngineSuccess(`${kind} absence proof`, result)
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  return rows.length === 0;
}

function inspectOwnedLlamaResource(
  engine: ContainerEngine,
  kind: "container" | "network",
  target: string,
  expectedLabels: Readonly<Record<string, string>> = {},
  expectedName: string = target,
): InspectedResource {
  const result = engine.capture([kind, "inspect", target], DOCKER_INSPECT_TIMEOUT_MS);
  if (result.error || result.status !== 0) {
    if (exactAbsenceProbe(engine, kind, expectedName)) return { kind: "absent" };
    throw new Error(`managed llama.cpp ${kind} inspection failed without an exact absence proof`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`managed llama.cpp ${kind} inspection returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`managed llama.cpp ${kind} inspection was ambiguous`);
  }
  const row = parsed[0] as Record<string, unknown>;
  const config = row.Config;
  const labels =
    kind === "container" && config && typeof config === "object" && !Array.isArray(config)
      ? (config as { Labels?: unknown }).Labels
      : row.Labels;
  const id = row.Id;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(id) ||
    row.Name !== (kind === "container" ? `/${expectedName}` : expectedName) ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_OWNER_LABEL] !==
      MANAGED_LLAMA_CPP_OWNER_VALUE ||
    Object.entries(expectedLabels).some(
      ([label, value]) => (labels as Record<string, unknown>)[label] !== value,
    ) ||
    (kind === "network" &&
      (row.Internal !== true || row.Driver !== "bridge" || row.Scope !== "local"))
  ) {
    return { kind: "foreign" };
  }
  return { kind: "owned", id, row };
}

function requireManagedLlamaJournal(
  journal: HostLocalCreateJournalRecord,
  ownerRecipeId: string,
): void {
  if (
    journal.providerId !== "docker" ||
    journal.service !== "llama-cpp" ||
    journal.containerName !== MANAGED_LLAMA_CPP_CONTAINER_NAME
  ) {
    throw new Error("managed llama.cpp lifecycle journal is incompatible");
  }
  if (journal.serializedReceipt !== null) {
    const receipt = JSON.parse(journal.serializedReceipt) as {
      runtime?: { model?: { recipeId?: unknown } };
    };
    if (receipt.runtime?.model?.recipeId !== ownerRecipeId) {
      throw new Error("managed llama.cpp journal does not match gateway ownership");
    }
  }
}

function requireManagedLlamaReceiptJournalAgreement(
  receipt: HostLocalInferenceReceipt,
  journal: HostLocalCreateJournalRecord,
  ownerRecipeId: string,
): void {
  requireManagedLlamaJournal(journal, ownerRecipeId);
  if (
    receipt.service !== "llama-cpp" ||
    receipt.runtime.kind !== "container" ||
    receipt.runtime.name !== MANAGED_LLAMA_CPP_CONTAINER_NAME ||
    receipt.endpoint.networkName !== MANAGED_LLAMA_CPP_NETWORK_NAME ||
    receipt.runtime.model?.recipeId !== ownerRecipeId ||
    receipt.runtime.model.generation !== journal.transactionId ||
    receipt.runtime.runtimeId !== journal.runtimeId ||
    receipt.runtime.specSha256 !== journal.specSha256 ||
    JSON.stringify(receipt.engineAuthority) !== JSON.stringify(journal.engineAuthority) ||
    (journal.phase !== "receipt-prepared" && journal.phase !== "finalized")
  ) {
    throw new Error("managed llama.cpp receipt does not match gateway lifecycle authority");
  }
}

interface ManagedLlamaCppPrivateAuthority {
  readonly sha256: string;
  readonly staticStateSha256: string;
}

interface ManagedLlamaCppExecutionOwnership {
  readonly lease: HostLocalCreateJournalExecutionLease;
  readonly assert: () => void;
  readonly release: () => void;
}

function acquireManagedLlamaCppExecutionOwnership(
  store: HostLocalCreateJournalStore,
  transactionId: string,
  stateDir: string,
): ManagedLlamaCppExecutionOwnership {
  const lease = store.acquireExecution(transactionId);
  const leasePath = path.join(
    stateDir,
    HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
    ".execution-lease.json",
  );
  let held = true;
  return Object.freeze({
    lease,
    assert: () => {
      if (!held) throw new Error("managed llama.cpp execution ownership was already released");
      store.assertExecution(lease);
    },
    release: () => {
      if (!held) return;
      if (!statePathExists(leasePath)) {
        held = false;
        return;
      }
      store.releaseExecution(lease);
      held = false;
    },
  });
}

interface ManagedLlamaCppPrivateStateEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly uid: number;
  readonly contentSha256?: string;
}

function readManagedLlamaCppPrivateFileEntry(
  target: string,
  relativePath: string,
): ManagedLlamaCppPrivateStateEntry {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("managed llama.cpp private state requires no-follow file reads");
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid()) ||
      (before.mode & 0o077) !== 0 ||
      before.size > MANAGED_LLAMA_CPP_PRIVATE_FILE_MAX_BYTES
    ) {
      throw new Error("managed llama.cpp private state contains an unsafe file");
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.uid !== after.uid ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("managed llama.cpp private state changed while it was read");
    }
    return Object.freeze({
      path: relativePath,
      kind: "file" as const,
      mode: before.mode & 0o777,
      uid: before.uid,
      contentSha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function readManagedLlamaCppPrivateDirectoryEntry(
  target: string,
  relativePath: string,
): ManagedLlamaCppPrivateStateEntry {
  const status = fs.lstatSync(target);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (status.mode & 0o077) !== 0
  ) {
    throw new Error("managed llama.cpp private state contains an unsafe directory");
  }
  return Object.freeze({
    path: relativePath,
    kind: "directory" as const,
    mode: status.mode & 0o777,
    uid: status.uid,
  });
}

function managedLlamaCppStaticStateSha256(paths: ManagedLlamaCppStatePaths): string {
  const entries: ManagedLlamaCppPrivateStateEntry[] = [];
  const rootFiles = new Set<string>([
    MANAGED_LLAMA_CPP_API_KEY_FILE,
    MANAGED_LLAMA_CPP_OWNER_FILE,
    MANAGED_LLAMA_CPP_RECEIPT_FILE,
  ]);
  const rootDirectories = new Set<string>([
    HOST_LOCAL_CREATE_JOURNAL_DIRECTORY,
    PERSISTED_ENGINE_AUTHORITY_DIRECTORY,
  ]);
  for (const name of fs.readdirSync(paths.stateDir).sort()) {
    const target = path.join(paths.stateDir, name);
    if (rootFiles.has(name)) {
      entries.push(readManagedLlamaCppPrivateFileEntry(target, name));
      continue;
    }
    if (!rootDirectories.has(name)) {
      throw new Error(`managed llama.cpp private state contains unexpected entry '${name}'`);
    }
    entries.push(readManagedLlamaCppPrivateDirectoryEntry(target, name));
    for (const child of fs.readdirSync(target).sort()) {
      const relativePath = `${name}/${child}`;
      const childTarget = path.join(target, child);
      if (name === HOST_LOCAL_CREATE_JOURNAL_DIRECTORY) {
        if (
          HOST_LOCAL_CREATE_JOURNAL_RECORD_FILE.test(child) ||
          HOST_LOCAL_CREATE_JOURNAL_TRANSIENT_FILES.has(child)
        ) {
          const childStatus = fs.lstatSync(childTarget);
          if (!childStatus.isFile() || childStatus.isSymbolicLink()) {
            throw new Error("managed llama.cpp lifecycle authority contains an unsafe entry");
          }
          continue;
        }
        throw new Error(
          `managed llama.cpp lifecycle authority contains unexpected entry '${child}'`,
        );
      }
      if (child !== "host-local-inference.json") {
        throw new Error(`managed llama.cpp engine authority contains unexpected entry '${child}'`);
      }
      entries.push(readManagedLlamaCppPrivateFileEntry(childTarget, relativePath));
    }
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function managedLlamaCppPrivateAuthority(
  paths: ManagedLlamaCppStatePaths,
): ManagedLlamaCppPrivateAuthority {
  const owner = loadManagedLlamaCppOwner(paths);
  const receipt = loadManagedLlamaCppReceipt(paths);
  const journals = reconcileAndReadHostLocalCreateJournalRecords(paths.stateDir);
  const authority = serializedManagedLlamaCppPersistedAuthority(paths);
  const staticStateSha256 = managedLlamaCppStaticStateSha256(paths);
  const sha256 = createHash("sha256")
    .update(
      JSON.stringify({
        owner,
        receipt: receipt === null ? null : serializeHostLocalInferenceReceipt(receipt),
        journals: journals.map(serializeHostLocalCreateJournalRecord),
        authority,
        staticStateSha256,
      }),
    )
    .digest("hex");
  return Object.freeze({ sha256, staticStateSha256 });
}

function serializedManagedLlamaCppPersistedAuthority(
  paths: ManagedLlamaCppStatePaths,
): string | null {
  const authorityDirectory = path.join(paths.stateDir, PERSISTED_ENGINE_AUTHORITY_DIRECTORY);
  const authority = statePathExists(authorityDirectory)
    ? openFilePersistedEngineAuthorityStore(paths.stateDir).load("host-local-inference")
    : null;
  return authority === null ? null : serializePersistedEngineAuthority(authority);
}

function requireManagedLlamaCppPrivateAuthority(
  paths: ManagedLlamaCppStatePaths,
  expected: ManagedLlamaCppPrivateAuthority | undefined,
): void {
  if (expected === undefined) return;
  try {
    if (managedLlamaCppPrivateAuthority(paths).sha256 === expected.sha256) return;
  } catch {
    // A malformed, missing, or newly introduced entry is authority drift too.
  }
  throw new Error("managed llama.cpp private authority changed after cleanup preparation");
}

function requireManagedLlamaCppStaticState(
  paths: ManagedLlamaCppStatePaths,
  expected: ManagedLlamaCppPrivateAuthority | undefined,
): void {
  if (expected === undefined) return;
  try {
    if (managedLlamaCppStaticStateSha256(paths) === expected.staticStateSha256) return;
  } catch {
    // Preserve the same fail-closed boundary for malformed or unexpected entries.
  }
  throw new Error("managed llama.cpp private authority changed after cleanup preparation");
}

function requireQualifiedEngine(
  authority: HostLocalCreateJournalRecord["engineAuthority"],
  engine: ContainerEngine,
): void {
  requirePersistedEngineAuthority(authority, "docker", engine, dockerLlamaCppBindingSha256(engine));
}

function inspectExactContainerForJournal(
  engine: ContainerEngine,
  journal: HostLocalCreateJournalRecord,
): InspectedResource {
  const expectedLabels = {
    [LLAMA_MANAGED_LABEL]: "true",
    [LLAMA_PROVIDER_LABEL]: "docker",
    [LLAMA_SERVICE_LABEL]: "llama-cpp",
    [LLAMA_SPEC_LABEL]: journal.specSha256,
    [LLAMA_TRANSACTION_LABEL]: journal.transactionId,
  };
  if (journal.phase === "network-creating" || journal.phase === "prepared") {
    const unexpected = inspectOwnedLlamaResource(
      engine,
      "container",
      journal.containerName,
      expectedLabels,
    );
    if (unexpected.kind !== "absent") {
      throw new Error("managed llama.cpp pre-container journal unexpectedly has a container");
    }
    return unexpected;
  }
  const target = journal.runtimeId ?? journal.containerName;
  const inspected = inspectOwnedLlamaResource(
    engine,
    "container",
    target,
    expectedLabels,
    journal.containerName,
  );
  if (
    inspected.kind === "absent" &&
    journal.phase === "creating" &&
    (journal.createIntentUnixMs === null ||
      Date.now() - journal.createIntentUnixMs < UNCERTAIN_CREATE_ABSENCE_GRACE_MS)
  ) {
    throw new Error("managed llama.cpp uncertain create remains inside its absence grace period");
  }
  if (inspected.kind === "foreign") {
    throw new Error("managed llama.cpp container does not match its exact journal");
  }
  if (inspected.kind === "owned") {
    if (journal.runtimeId !== null && inspected.id !== journal.runtimeId) {
      throw new Error("managed llama.cpp container identity changed from its exact journal");
    }
  }
  return inspected;
}

function removeExactContainerForJournal(
  engine: ContainerEngine,
  journal: HostLocalCreateJournalRecord,
  removed: string[],
): void {
  const inspected = inspectExactContainerForJournal(engine, journal);
  if (inspected.kind === "owned") {
    requireEngineSuccess(
      "container removal",
      engine.capture(["rm", "--force", inspected.id], DOCKER_MUTATION_TIMEOUT_MS),
    );
    removed.push(`container:${inspected.id}`);
  }
  const after = inspectOwnedLlamaResource(engine, "container", journal.containerName, {
    [LLAMA_MANAGED_LABEL]: "true",
    [LLAMA_PROVIDER_LABEL]: "docker",
    [LLAMA_SERVICE_LABEL]: "llama-cpp",
    [LLAMA_SPEC_LABEL]: journal.specSha256,
    [LLAMA_TRANSACTION_LABEL]: journal.transactionId,
  });
  if (after.kind !== "absent") {
    throw new Error("managed llama.cpp container removal was not proven exact and absent");
  }
}

function inspectExactNetworkForJournal(
  engine: ContainerEngine,
  journal: HostLocalCreateJournalRecord,
): InspectedResource {
  const network = inspectOwnedLlamaResource(engine, "network", MANAGED_LLAMA_CPP_NETWORK_NAME, {
    [LLAMA_NETWORK_TRANSACTION_LABEL]: journal.transactionId,
  });
  if (
    journal.phase === "network-creating" &&
    network.kind === "absent" &&
    (journal.createIntentUnixMs === null ||
      Date.now() - journal.createIntentUnixMs < UNCERTAIN_CREATE_ABSENCE_GRACE_MS)
  ) {
    throw new Error(
      "managed llama.cpp uncertain network create remains inside its absence grace period",
    );
  }
  if (
    network.kind === "foreign" ||
    (network.kind === "owned" && journal.networkId !== null && network.id !== journal.networkId) ||
    (journal.phase !== "network-creating" && journal.networkId === null)
  ) {
    throw new Error("managed llama.cpp network does not match its exact journal");
  }
  return network;
}

function cleanupLlamaCpp(
  homeDir: string,
  deps: CleanupDeps,
  removed: string[],
  options: {
    gatewayPort?: number;
    sandboxName?: string;
    env?: NodeJS.ProcessEnv;
    engine?: ContainerEngine;
    privateBridge?: DockerLlamaCppPrivateBridgeController;
    expectedPrivateAuthority?: ManagedLlamaCppPrivateAuthority;
    executionOwnership?: ManagedLlamaCppExecutionOwnership;
  } = {},
): boolean {
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  if (!statePathExists(paths.stateDir)) {
    if (options.expectedPrivateAuthority !== undefined) {
      throw new Error("managed llama.cpp private authority changed after cleanup preparation");
    }
    return false;
  }
  requirePrivateManagedState(paths, deps.currentUserId);
  if (!fs.existsSync(paths.ownerPath)) {
    if (options.expectedPrivateAuthority !== undefined) {
      throw new Error("managed llama.cpp private authority changed after cleanup preparation");
    }
    return false;
  }
  const owner = loadManagedLlamaCppOwner(paths);
  if (!owner) throw new Error("managed llama.cpp owner state is missing");
  if (options.sandboxName !== undefined && owner.sandboxName !== options.sandboxName) {
    if (options.expectedPrivateAuthority !== undefined) {
      throw new Error("managed llama.cpp private authority changed after cleanup preparation");
    }
    return false;
  }
  requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);

  const receipt = loadManagedLlamaCppReceipt(paths);
  const persistedAuthority = serializedManagedLlamaCppPersistedAuthority(paths);
  const journalStore = createHostLocalCreateJournalStore(paths.stateDir);
  const journalRecords = journalStore.list();
  const journals = journalRecords.filter(
    ({ providerId, service }) => providerId === "docker" && service === "llama-cpp",
  );
  if (journalRecords.length > 1) {
    throw new Error("managed llama.cpp has more than one lifecycle journal");
  }
  if (journalRecords.length !== journals.length) {
    throw new Error("managed llama.cpp has an incompatible lifecycle journal");
  }
  if (journals.length === 0) {
    if (receipt !== null) {
      throw new Error("managed llama.cpp receipt exists without lifecycle authority");
    }
    const engine = options.engine ?? createManagedLlamaCppEngine(options.env ?? process.env);
    const authority = createFilePersistedEngineAuthorityStore(paths.stateDir).load(
      "host-local-inference",
    );
    if (authority === null) {
      throw new Error("managed llama.cpp engine authority is missing while ownership remains");
    }
    requireQualifiedEngine(authority, engine);
    requireEngineSuccess(
      "engine availability check",
      engine.capture(["info"], DOCKER_INSPECT_TIMEOUT_MS),
    );
    const container = inspectOwnedLlamaResource(
      engine,
      "container",
      MANAGED_LLAMA_CPP_CONTAINER_NAME,
    );
    const network = inspectOwnedLlamaResource(engine, "network", MANAGED_LLAMA_CPP_NETWORK_NAME);
    if (container.kind !== "absent" || network.kind !== "absent") {
      throw new Error(
        "managed llama.cpp pre-start cleanup cannot prove its fixed runtime names absent",
      );
    }
    requirePrivateManagedState(paths, deps.currentUserId);
    if (
      JSON.stringify(loadManagedLlamaCppOwner(paths)) !== JSON.stringify(owner) ||
      loadManagedLlamaCppReceipt(paths) !== null ||
      journalStore.list().length !== 0
    ) {
      throw new Error("managed llama.cpp state changed during pre-start cleanup");
    }
    requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);
    requireManagedLlamaCppStaticState(paths, options.expectedPrivateAuthority);
    fs.rmSync(paths.stateDir, { recursive: true });
    removed.push(`state:${paths.stateDir}`);
    return true;
  }
  const journal = journals[0]!;
  if (receipt !== null) {
    requireManagedLlamaReceiptJournalAgreement(receipt, journal, owner.recipeId);
  } else {
    requireManagedLlamaJournal(journal, owner.recipeId);
    if (journal.phase === "finalized") {
      throw new Error("managed llama.cpp finalized receipt is missing");
    }
  }

  const executionOwnership =
    options.executionOwnership ??
    acquireManagedLlamaCppExecutionOwnership(journalStore, journal.transactionId, paths.stateDir);
  if (executionOwnership.lease.transactionId !== journal.transactionId) {
    throw new Error("managed llama.cpp execution ownership changed after cleanup preparation");
  }
  try {
    executionOwnership.assert();
    requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);
    const privateBridge =
      options.privateBridge ??
      (process.platform === "linux" ? createDockerLlamaCppPrivateBridgeController() : undefined);
    if (privateBridge) {
      privateBridge.stopTransaction(journal.transactionId);
      privateBridge.assertStopped(journal.transactionId);
    }
    executionOwnership.assert();
    const engine = options.engine ?? createManagedLlamaCppEngine(options.env ?? process.env);
    requireQualifiedEngine(receipt?.engineAuthority ?? journal.engineAuthority, engine);
    requireEngineSuccess(
      "engine availability check",
      engine.capture(["info"], DOCKER_INSPECT_TIMEOUT_MS),
    );
    executionOwnership.assert();
    requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);
    removeExactContainerForJournal(engine, journal, removed);
    executionOwnership.assert();
    requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);
    let network = inspectExactNetworkForJournal(engine, journal);
    if (network.kind === "owned") {
      requireEngineSuccess(
        "network removal",
        engine.capture(["network", "rm", network.id], DOCKER_MUTATION_TIMEOUT_MS),
      );
      removed.push(`network:${network.id}`);
    }
    network = inspectOwnedLlamaResource(engine, "network", MANAGED_LLAMA_CPP_NETWORK_NAME, {
      [LLAMA_NETWORK_TRANSACTION_LABEL]: journal.transactionId,
    });
    if (network.kind !== "absent") {
      throw new Error("managed llama.cpp network removal was not proven exact and absent");
    }
    executionOwnership.assert();
    requireManagedLlamaCppPrivateAuthority(paths, options.expectedPrivateAuthority);
    journalStore.retire(journal.transactionId);
    executionOwnership.assert();
    requirePrivateManagedState(paths, deps.currentUserId);
    const finalReceipt = loadManagedLlamaCppReceipt(paths);
    if (
      JSON.stringify(loadManagedLlamaCppOwner(paths)) !== JSON.stringify(owner) ||
      (receipt === null
        ? finalReceipt !== null
        : finalReceipt === null ||
          serializeHostLocalInferenceReceipt(finalReceipt) !==
            serializeHostLocalInferenceReceipt(receipt)) ||
      serializedManagedLlamaCppPersistedAuthority(paths) !== persistedAuthority ||
      journalStore.list().length !== 0
    ) {
      throw new Error("managed llama.cpp state changed during exact cleanup");
    }
    requireManagedLlamaCppStaticState(paths, options.expectedPrivateAuthority);
    fs.rmSync(paths.stateDir, { recursive: true });
    removed.push(`state:${paths.stateDir}`);
    return true;
  } finally {
    executionOwnership.release();
  }
}

export interface ManagedLlamaCppSandboxCleanupOptions {
  readonly homeDir?: string;
  readonly gatewayPort?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly engine?: ContainerEngine;
  readonly privateBridge?: DockerLlamaCppPrivateBridgeController;
  readonly deps?: Partial<CleanupDeps>;
}

export interface ManagedLlamaCppLifecycleCleanupOptions extends ManagedLlamaCppSandboxCleanupOptions {
  readonly privateBridge?: DockerLlamaCppPrivateBridgeController;
}

export interface PreparedManagedLlamaCppRuntimeCleanup {
  readonly abort: () => void;
  readonly cleanup: () => LocalModelRuntimeCleanupResult;
}

function managedLlamaCppJournalRecords(paths: ManagedLlamaCppStatePaths): {
  readonly records: readonly HostLocalCreateJournalRecord[];
  readonly journals: readonly HostLocalCreateJournalRecord[];
} {
  const records = reconcileAndReadHostLocalCreateJournalRecords(paths.stateDir);
  const journals = records.filter(
    ({ providerId, service }) => providerId === "docker" && service === "llama-cpp",
  );
  if (records.length > 1) {
    throw new Error("managed llama.cpp has more than one lifecycle journal");
  }
  if (records.length !== journals.length) {
    throw new Error("managed llama.cpp has an incompatible lifecycle journal");
  }
  return { records, journals };
}

/**
 * Qualify legacy sandbox-scoped cleanup before deletion. Docker qualification
 * reads ambient DOCKER_CONTEXT, DOCKER_HOST, or persisted currentContext, so
 * the returned capability retains that exact selection across the OpenShell
 * delete boundary and revalidates its endpoint and private ownership at use.
 */
export function prepareManagedLlamaCppRuntimeCleanupForSandbox(
  sandboxName: string,
  options: ManagedLlamaCppSandboxCleanupOptions = {},
): PreparedManagedLlamaCppRuntimeCleanup | null {
  const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  if (!statePathExists(paths.stateDir)) return null;
  const currentUserId =
    options.deps?.currentUserId === undefined
      ? typeof process.getuid === "function"
        ? process.getuid()
        : null
      : options.deps.currentUserId;
  requirePrivateManagedState(paths, currentUserId);
  if (!fs.existsSync(paths.ownerPath)) return null;
  const owner = loadManagedLlamaCppOwner(paths);
  if (!owner || owner.sandboxName !== sandboxName) return null;
  const initial = managedLlamaCppJournalRecords(paths);
  const journalStore = createHostLocalCreateJournalStore(paths.stateDir);
  const executionOwnership = initial.journals[0]
    ? acquireManagedLlamaCppExecutionOwnership(
        journalStore,
        initial.journals[0].transactionId,
        paths.stateDir,
      )
    : undefined;
  try {
    // Pin private state while holding lifecycle execution ownership, then
    // recheck it after external proof so the capability owns one generation.
    const expectedPrivateAuthority = managedLlamaCppPrivateAuthority(paths);
    const engine = options.engine ?? createManagedLlamaCppEngine(options.env ?? process.env);
    const receipt = loadManagedLlamaCppReceipt(paths);
    const { journals } = managedLlamaCppJournalRecords(paths);
    if (
      executionOwnership &&
      journals[0]?.transactionId !== executionOwnership.lease.transactionId
    ) {
      throw new Error("managed llama.cpp lifecycle journal changed during cleanup preparation");
    }
    if (receipt !== null) {
      const journal = journals[0];
      if (!journal) {
        throw new Error("managed llama.cpp receipt exists without lifecycle authority");
      }
      requireManagedLlamaReceiptJournalAgreement(receipt, journal, owner.recipeId);
      prepareManagedLlamaCppLifecycleCleanup(owner.sandboxName, receipt, {
        ...options,
        homeDir,
        engine,
      });
    } else {
      const authority =
        journals[0]?.engineAuthority ??
        openFilePersistedEngineAuthorityStore(paths.stateDir).load("host-local-inference");
      if (authority === null) {
        throw new Error("managed llama.cpp engine authority is missing while ownership remains");
      }
      if (journals[0]) {
        requireManagedLlamaJournal(journals[0], owner.recipeId);
        if (journals[0].phase === "finalized") {
          throw new Error("managed llama.cpp finalized receipt is missing");
        }
      }
      requireQualifiedEngine(authority, engine);
      requireEngineSuccess(
        "engine availability check",
        engine.capture(["info"], DOCKER_INSPECT_TIMEOUT_MS),
      );
      if (journals[0]) {
        inspectExactContainerForJournal(engine, journals[0]);
        inspectExactNetworkForJournal(engine, journals[0]);
      } else {
        const container = inspectOwnedLlamaResource(
          engine,
          "container",
          MANAGED_LLAMA_CPP_CONTAINER_NAME,
        );
        const network = inspectOwnedLlamaResource(
          engine,
          "network",
          MANAGED_LLAMA_CPP_NETWORK_NAME,
        );
        if (container.kind !== "absent" || network.kind !== "absent") {
          throw new Error(
            "managed llama.cpp pre-start cleanup cannot prove its fixed runtime names absent",
          );
        }
      }
    }
    requireManagedLlamaCppPrivateAuthority(paths, expectedPrivateAuthority);
    executionOwnership?.assert();
    let settled = false;
    return Object.freeze({
      abort: () => {
        if (settled) return;
        executionOwnership?.release();
        settled = true;
      },
      cleanup: () => {
        if (settled) {
          return {
            ok: false,
            reason: "managed llama.cpp cleanup capability was already settled",
            removed: [],
            preserved: [],
          };
        }
        settled = true;
        try {
          return cleanupManagedLlamaCppRuntimeForSandboxInternal(
            sandboxName,
            { ...options, homeDir, engine },
            expectedPrivateAuthority,
            executionOwnership,
          );
        } finally {
          executionOwnership?.release();
        }
      },
    });
  } catch (error) {
    executionOwnership?.release();
    throw error;
  }
}

function requireManagedLlamaCppLifecycleCleanupReceipt(
  expectedReceipt: HostLocalInferenceReceipt,
): HostLocalInferenceReceipt & {
  readonly runtime: Extract<
    HostLocalInferenceReceipt["runtime"],
    { readonly kind: "container" }
  > & {
    readonly model: NonNullable<
      Extract<HostLocalInferenceReceipt["runtime"], { readonly kind: "container" }>["model"]
    >;
  };
} {
  const receipt = normalizeHostLocalInferenceReceipt(expectedReceipt);
  if (
    receipt.service !== "llama-cpp" ||
    receipt.schemaVersion !== 1 ||
    receipt.runtime.kind !== "container" ||
    receipt.runtime.model === undefined
  ) {
    throw new Error("managed llama.cpp lifecycle cleanup receipt is invalid");
  }
  return receipt as HostLocalInferenceReceipt & {
    readonly runtime: Extract<
      HostLocalInferenceReceipt["runtime"],
      { readonly kind: "container" }
    > & {
      readonly model: NonNullable<
        Extract<HostLocalInferenceReceipt["runtime"], { readonly kind: "container" }>["model"]
      >;
    };
  };
}

/** Re-prove exact cleanup authority without changing the runtime or private state. */
export function prepareManagedLlamaCppLifecycleCleanup(
  runtimeOwnerSandboxName: string,
  expectedReceipt: HostLocalInferenceReceipt,
  options: ManagedLlamaCppLifecycleCleanupOptions = {},
): HostLocalInferenceReceipt {
  const receipt = requireManagedLlamaCppLifecycleCleanupReceipt(expectedReceipt);
  const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  const engine = options.engine ?? createManagedLlamaCppEngine(options.env ?? process.env);
  requireQualifiedEngine(receipt.engineAuthority, engine);
  requireEngineSuccess(
    "engine availability check",
    engine.capture(["info"], DOCKER_INSPECT_TIMEOUT_MS),
  );
  const transactionId = receipt.runtime.model.generation;
  const container = inspectOwnedLlamaResource(
    engine,
    "container",
    receipt.runtime.runtimeId,
    {
      [LLAMA_MANAGED_LABEL]: "true",
      [LLAMA_PROVIDER_LABEL]: "docker",
      [LLAMA_SERVICE_LABEL]: "llama-cpp",
      [LLAMA_SPEC_LABEL]: receipt.runtime.specSha256,
      [LLAMA_TRANSACTION_LABEL]: transactionId,
    },
    receipt.runtime.name,
  );
  if (container.kind === "foreign") {
    throw new Error("managed llama.cpp lifecycle container authority changed");
  }
  const network = inspectOwnedLlamaResource(engine, "network", receipt.endpoint.networkName, {
    [LLAMA_NETWORK_TRANSACTION_LABEL]: transactionId,
  });
  if (network.kind === "foreign") {
    throw new Error("managed llama.cpp lifecycle network authority changed");
  }
  if (statePathExists(paths.stateDir)) {
    requirePrivateManagedState(
      paths,
      options.deps?.currentUserId === undefined
        ? typeof process.getuid === "function"
          ? process.getuid()
          : null
        : options.deps.currentUserId,
    );
    const owner = loadManagedLlamaCppOwner(paths);
    const privateReceipt = loadManagedLlamaCppReceipt(paths);
    if (
      owner?.sandboxName !== runtimeOwnerSandboxName ||
      privateReceipt === null ||
      serializeHostLocalInferenceReceipt(privateReceipt) !==
        serializeHostLocalInferenceReceipt(receipt)
    ) {
      throw new Error("managed llama.cpp private lifecycle authority changed during cleanup");
    }
  }
  return receipt;
}

/**
 * Complete a common-lifecycle llama.cpp retirement after its provider runtime
 * has stopped the bridge, removed the exact container, and retired the journal.
 * The registry receipt remains the retry authority if this final phase fails.
 */
export function finalizeManagedLlamaCppLifecycleCleanup(
  runtimeOwnerSandboxName: string,
  expectedReceipt: HostLocalInferenceReceipt,
  options: ManagedLlamaCppLifecycleCleanupOptions = {},
): LocalModelRuntimeCleanupResult {
  const removed: string[] = [];
  const preserved: string[] = [];
  try {
    const receipt = requireManagedLlamaCppLifecycleCleanupReceipt(expectedReceipt);
    const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
    const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
    const engine = options.engine ?? createManagedLlamaCppEngine(options.env ?? process.env);
    requireQualifiedEngine(receipt.engineAuthority, engine);
    requireEngineSuccess(
      "engine availability check",
      engine.capture(["info"], DOCKER_INSPECT_TIMEOUT_MS),
    );
    const transactionId = receipt.runtime.model.generation;
    const privateBridge = options.privateBridge ?? createDockerLlamaCppPrivateBridgeController();
    privateBridge.stopTransaction(transactionId);
    privateBridge.assertStopped(transactionId);

    const expectedContainerLabels = {
      [LLAMA_MANAGED_LABEL]: "true",
      [LLAMA_PROVIDER_LABEL]: "docker",
      [LLAMA_SERVICE_LABEL]: "llama-cpp",
      [LLAMA_SPEC_LABEL]: receipt.runtime.specSha256,
      [LLAMA_TRANSACTION_LABEL]: transactionId,
    };
    let container = inspectOwnedLlamaResource(
      engine,
      "container",
      receipt.runtime.runtimeId,
      expectedContainerLabels,
      receipt.runtime.name,
    );
    if (container.kind === "foreign") {
      throw new Error("managed llama.cpp lifecycle container authority changed");
    }
    if (container.kind === "owned") {
      requireEngineSuccess(
        "container removal",
        engine.capture(["rm", "--force", container.id], DOCKER_MUTATION_TIMEOUT_MS),
      );
      removed.push(`container:${container.id}`);
    }
    container = inspectOwnedLlamaResource(
      engine,
      "container",
      receipt.runtime.name,
      expectedContainerLabels,
    );
    if (container.kind !== "absent") {
      throw new Error("managed llama.cpp lifecycle container absence is unproven");
    }

    const expectedNetworkLabels = { [LLAMA_NETWORK_TRANSACTION_LABEL]: transactionId };
    let network = inspectOwnedLlamaResource(
      engine,
      "network",
      receipt.endpoint.networkName,
      expectedNetworkLabels,
    );
    if (network.kind === "foreign") {
      throw new Error("managed llama.cpp lifecycle network authority changed");
    }
    if (network.kind === "owned") {
      requireEngineSuccess(
        "network removal",
        engine.capture(["network", "rm", network.id], DOCKER_MUTATION_TIMEOUT_MS),
      );
      removed.push(`network:${network.id}`);
    }
    network = inspectOwnedLlamaResource(
      engine,
      "network",
      receipt.endpoint.networkName,
      expectedNetworkLabels,
    );
    if (network.kind !== "absent") {
      throw new Error("managed llama.cpp lifecycle network absence is unproven");
    }

    if (statePathExists(paths.stateDir)) {
      requirePrivateManagedState(
        paths,
        options.deps?.currentUserId === undefined
          ? typeof process.getuid === "function"
            ? process.getuid()
            : null
          : options.deps.currentUserId,
      );
      const owner = loadManagedLlamaCppOwner(paths);
      const privateReceipt = loadManagedLlamaCppReceipt(paths);
      if (
        owner?.sandboxName !== runtimeOwnerSandboxName ||
        privateReceipt === null ||
        serializeHostLocalInferenceReceipt(privateReceipt) !==
          serializeHostLocalInferenceReceipt(receipt) ||
        createHostLocalCreateJournalStore(paths.stateDir).list().length !== 0
      ) {
        throw new Error("managed llama.cpp private lifecycle authority changed during cleanup");
      }
      fs.rmSync(paths.stateDir, { recursive: true });
      removed.push(`state:${paths.stateDir}`);
    }
    preserveSharedHuggingFaceCache(homeDir, preserved);
    return { ok: true, removed, preserved };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      removed,
      preserved,
    };
  }
}

export interface ManagedLlamaCppCleanupTarget {
  readonly gatewayPort: number;
  readonly sandboxName: string;
  readonly stateDir: string;
}

/** Resolve cleanup identity from the private owner record without mutating runtime state. */
export function resolveManagedLlamaCppCleanupTarget(
  homeDir: string,
  gatewayPort: number,
): ManagedLlamaCppCleanupTarget | null {
  const paths = managedLlamaCppStatePaths(canonicalCleanupHomeDir(homeDir), gatewayPort);
  if (!statePathExists(paths.stateDir)) return null;
  requirePrivateManagedState(paths, typeof process.getuid === "function" ? process.getuid() : null);
  if (!statePathExists(paths.ownerPath)) return null;
  const owner = loadManagedLlamaCppOwner(paths);
  if (!owner) {
    throw new Error(
      `managed llama.cpp owner for gateway port ${String(gatewayPort)} could not be read`,
    );
  }
  return Object.freeze({ gatewayPort, sandboxName: owner.sandboxName, stateDir: paths.stateDir });
}

function cleanupManagedLlamaCppRuntimeForSandboxInternal(
  sandboxName: string,
  options: ManagedLlamaCppSandboxCleanupOptions = {},
  expectedPrivateAuthority?: ManagedLlamaCppPrivateAuthority,
  executionOwnership?: ManagedLlamaCppExecutionOwnership,
): LocalModelRuntimeCleanupResult {
  const deps: CleanupDeps = {
    capture: options.deps?.capture ?? dockerCapture,
    currentUserId:
      options.deps?.currentUserId === undefined
        ? typeof process.getuid === "function"
          ? process.getuid()
          : null
        : options.deps.currentUserId,
    forceRm: options.deps?.forceRm ?? dockerForceRm,
    run: options.deps?.run ?? dockerRun,
  };
  const removed: string[] = [];
  const preserved: string[] = [];
  try {
    const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
    const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
    if (!statePathExists(paths.stateDir)) {
      if (expectedPrivateAuthority !== undefined) {
        throw new Error("managed llama.cpp private authority changed after cleanup preparation");
      }
      return { ok: true, removed, preserved };
    }
    requirePrivateManagedState(paths, deps.currentUserId);
    if (!fs.existsSync(paths.ownerPath)) {
      if (expectedPrivateAuthority !== undefined) {
        throw new Error("managed llama.cpp private authority changed after cleanup preparation");
      }
      return { ok: true, removed, preserved };
    }
    const owner = loadManagedLlamaCppOwner(paths);
    if (!owner || owner.sandboxName !== sandboxName) {
      if (expectedPrivateAuthority !== undefined) {
        throw new Error("managed llama.cpp private authority changed after cleanup preparation");
      }
      return { ok: true, removed, preserved };
    }
    cleanupLlamaCpp(homeDir, deps, removed, {
      gatewayPort: options.gatewayPort,
      sandboxName,
      env: options.env,
      engine: options.engine,
      privateBridge: options.privateBridge,
      expectedPrivateAuthority,
      executionOwnership,
    });
    preserveSharedHuggingFaceCache(homeDir, preserved);
    return { ok: true, removed, preserved };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removed, preserved };
  }
}

/** Retire the exact gateway-owned runtime only when the named sandbox owns it. */
export function cleanupManagedLlamaCppRuntimeForSandbox(
  sandboxName: string,
  options: ManagedLlamaCppSandboxCleanupOptions = {},
): LocalModelRuntimeCleanupResult {
  return cleanupManagedLlamaCppRuntimeForSandboxInternal(sandboxName, options);
}

/** Remove only exact owned host-local runtime resources before uninstall deletes state. */
export function cleanupLocalModelRuntimes(
  options: LocalModelRuntimeCleanupOptions,
): LocalModelRuntimeCleanupResult {
  const deps: CleanupDeps = {
    capture: options.deps?.capture ?? dockerCapture,
    currentUserId:
      options.deps?.currentUserId === undefined
        ? typeof process.getuid === "function"
          ? process.getuid()
          : null
        : options.deps.currentUserId,
    forceRm: options.deps?.forceRm ?? dockerForceRm,
    run: options.deps?.run ?? dockerRun,
  };
  const removed: string[] = [];
  const preserved: string[] = [];
  try {
    const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
    const llamaPaths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
    const vllmStateDir = managedVllmStateDir(homeDir);
    if (statePathExists(llamaPaths.stateDir)) {
      requirePrivateManagedState(llamaPaths, deps.currentUserId);
    }
    const vllmStateRequiresDocker =
      fs.existsSync(path.join(vllmStateDir, MANAGED_VLLM_API_KEY_FILE)) &&
      !distributedReceiptPresent(vllmStateDir);
    if (vllmStateRequiresDocker) {
      const dockerReady =
        deps.run(["info"], { ignoreError: true, suppressOutput: true }).status === 0;
      if (!dockerReady) {
        throw new Error("Docker is unavailable while host-local vLLM ownership state remains");
      }
      cleanupHostLocalVllm(vllmStateDir, deps, removed);
    }
    if (statePathExists(llamaPaths.stateDir)) {
      cleanupLlamaCpp(homeDir, deps, removed, {
        gatewayPort: options.gatewayPort,
        sandboxName: options.sandboxName,
        env: options.env,
        engine: options.engine,
        privateBridge: options.privateBridge,
      });
    }
    preserveSharedHuggingFaceCache(homeDir, preserved);
    return { ok: true, removed, preserved };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removed, preserved };
  }
}

/** Remove non-credential Hugging Face cache data after model runtimes have stopped. */
export function cleanupHuggingFaceCacheData(
  options: HuggingFaceCacheDataCleanupOptions = {},
): LocalModelRuntimeCleanupResult {
  const removed: string[] = [];
  const preserved: string[] = [];
  try {
    const homeDir = canonicalCleanupHomeDir(options.homeDir ?? os.homedir());
    const currentUserId =
      options.currentUserId === undefined
        ? typeof process.getuid === "function"
          ? process.getuid()
          : null
        : options.currentUserId;
    removeSharedHuggingFaceCacheData(homeDir, currentUserId, removed, preserved);
    return { ok: true, removed, preserved };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removed, preserved };
  }
}
