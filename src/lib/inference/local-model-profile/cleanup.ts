// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerCapture, dockerForceRm, dockerRun } from "../../adapters/docker/local-model-runtime";
import {
  MANAGED_LLAMA_CPP_AUTH_LABEL,
  MANAGED_LLAMA_CPP_CACHE_OWNER_ID,
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_GENERATION_LABEL,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
  MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE,
} from "../llama-cpp/managed-installer";
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
} from "../serving/vllm-host-local-lifecycle";
import { loadManagedVllmApiKey } from "../vllm-api-key";

interface CleanupDeps {
  capture: typeof dockerCapture;
  currentUserId: number | null;
  forceRm: typeof dockerForceRm;
  run: typeof dockerRun;
}

interface ManagedLlamaCppCacheOwner {
  id: typeof MANAGED_LLAMA_CPP_CACHE_OWNER_ID;
  generation: string;
}

interface ManagedLlamaCppRuntimeReceipt {
  containerId: string;
  networkId: string;
}

export interface LocalModelRuntimeCleanupOptions {
  deleteModels: boolean;
  homeDir?: string;
  deps?: Partial<CleanupDeps>;
}

export type LocalModelRuntimeCleanupResult =
  | { ok: true; removed: string[]; preserved: string[] }
  | { ok: false; reason: string; removed: string[]; preserved: string[] };

type InspectedResource =
  | { kind: "absent" }
  | { kind: "foreign" }
  | { kind: "owned"; id: string; row: Record<string, unknown> };

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
  const id = row.Id;
  const observedName = row.Name;
  const config = row.Config;
  const labels =
    kind === "container" && config && typeof config === "object" && !Array.isArray(config)
      ? (config as { Labels?: unknown }).Labels
      : row.Labels;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test(id) ||
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

function realOwnerDirectory(
  homeDir: string,
  directory: string,
  currentUserId: number | null,
): boolean {
  const relative = path.relative(homeDir, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("host-local model cleanup path is outside the selected home directory");
  }
  let current = homeDir;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`host-local model path is a symlink: ${current}`);
      if (current === directory) {
        if (!stat.isDirectory()) {
          throw new Error(`host-local model path is not a directory: ${current}`);
        }
        if (currentUserId !== null && stat.uid !== currentUserId) {
          throw new Error(`host-local model path is not owned by the current user: ${current}`);
        }
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function readOwnerOnlyRegularFile(filePath: string): string {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform");
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error(`managed llama.cpp cache state is not owner-only: ${filePath}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function cacheOwner(cacheDir: string): ManagedLlamaCppCacheOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerOnlyRegularFile(path.join(cacheDir, "owner.json")));
  } catch (error) {
    throw new Error(`managed llama.cpp cache owner state is invalid: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed llama.cpp cache owner state is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    !exactKeys(record, ["generation", "id"]) ||
    record.id !== MANAGED_LLAMA_CPP_CACHE_OWNER_ID ||
    typeof record.generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.generation)
  ) {
    throw new Error("managed llama.cpp cache owner state is invalid");
  }
  return { id: MANAGED_LLAMA_CPP_CACHE_OWNER_ID, generation: record.generation };
}

function llamaCppRuntimeReceipt(
  stateDir: string,
  owner: ManagedLlamaCppCacheOwner,
  authFingerprint: string,
): ManagedLlamaCppRuntimeReceipt | null {
  const receiptPath = path.join(stateDir, MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE);
  if (!fs.existsSync(receiptPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerOnlyRegularFile(receiptPath));
  } catch (error) {
    throw new Error(`managed llama.cpp runtime receipt is invalid: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed llama.cpp runtime receipt is invalid");
  }
  const receipt = parsed as Record<string, unknown>;
  const receiptOwner = receipt.owner;
  const authentication = receipt.authentication;
  const container = receipt.container;
  const network = receipt.network;
  const runtime = receipt.runtime;
  const model = receipt.model;
  if (
    !exactKeys(receipt, [
      "authentication",
      "container",
      "model",
      "network",
      "owner",
      "receiptRef",
      "runtime",
      "schemaVersion",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.receiptRef !== "llama-cpp.host-local.receipt/v1" ||
    !receiptOwner ||
    typeof receiptOwner !== "object" ||
    Array.isArray(receiptOwner) ||
    !exactKeys(receiptOwner as Record<string, unknown>, ["generation", "id"]) ||
    (receiptOwner as Record<string, unknown>).id !== owner.id ||
    (receiptOwner as Record<string, unknown>).generation !== owner.generation ||
    !authentication ||
    typeof authentication !== "object" ||
    Array.isArray(authentication) ||
    !exactKeys(authentication as Record<string, unknown>, ["fingerprint"]) ||
    (authentication as Record<string, unknown>).fingerprint !== authFingerprint ||
    !container ||
    typeof container !== "object" ||
    Array.isArray(container) ||
    !exactKeys(container as Record<string, unknown>, ["id", "name"]) ||
    (container as Record<string, unknown>).name !== MANAGED_LLAMA_CPP_CONTAINER_NAME ||
    typeof (container as Record<string, unknown>).id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test((container as Record<string, unknown>).id as string) ||
    !network ||
    typeof network !== "object" ||
    Array.isArray(network) ||
    !exactKeys(network as Record<string, unknown>, ["id", "name"]) ||
    (network as Record<string, unknown>).name !== MANAGED_LLAMA_CPP_NETWORK_NAME ||
    typeof (network as Record<string, unknown>).id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test((network as Record<string, unknown>).id as string) ||
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    !exactKeys(runtime as Record<string, unknown>, ["image"]) ||
    typeof (runtime as Record<string, unknown>).image !== "string" ||
    !/@sha256:[a-f0-9]{64}$/.test((runtime as Record<string, unknown>).image as string) ||
    !model ||
    typeof model !== "object" ||
    Array.isArray(model) ||
    !exactKeys(model as Record<string, unknown>, ["digest", "servedName", "sizeBytes"]) ||
    typeof (model as Record<string, unknown>).digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test((model as Record<string, unknown>).digest as string) ||
    typeof (model as Record<string, unknown>).servedName !== "string" ||
    typeof (model as Record<string, unknown>).sizeBytes !== "number" ||
    !Number.isSafeInteger((model as Record<string, unknown>).sizeBytes) ||
    ((model as Record<string, unknown>).sizeBytes as number) < 1
  ) {
    throw new Error("managed llama.cpp runtime receipt does not match persisted ownership state");
  }
  return {
    containerId: (container as Record<string, string>).id,
    networkId: (network as Record<string, string>).id,
  };
}

function assertOwnedCacheReceipt(
  entryDir: string,
  entryName: string,
  owner: ManagedLlamaCppCacheOwner,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerOnlyRegularFile(path.join(entryDir, "receipt.json")));
  } catch (error) {
    throw new Error(`managed llama.cpp cache receipt is invalid: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed llama.cpp cache receipt is invalid");
  }
  const receipt = parsed as Record<string, unknown>;
  const receiptOwner = receipt.owner;
  const cache = receipt.cache;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptRef !== "llama-cpp.gguf-cache-entry.receipt/v1" ||
    !receiptOwner ||
    typeof receiptOwner !== "object" ||
    Array.isArray(receiptOwner) ||
    !exactKeys(receiptOwner as Record<string, unknown>, ["generation", "id"]) ||
    (receiptOwner as Record<string, unknown>).id !== owner.id ||
    (receiptOwner as Record<string, unknown>).generation !== owner.generation ||
    !cache ||
    typeof cache !== "object" ||
    Array.isArray(cache) ||
    !exactKeys(cache as Record<string, unknown>, ["key", "ref"]) ||
    (cache as Record<string, unknown>).ref !== "llama-cpp.gguf-content-addressed/v1" ||
    (cache as Record<string, unknown>).key !== entryName
  ) {
    throw new Error("managed llama.cpp cache receipt does not match its owner or entry");
  }
}

function removeOwnedLlamaCppCache(
  homeDir: string,
  cacheDir: string,
  currentUserId: number | null,
  removed: string[],
): void {
  const owner = cacheOwner(cacheDir);
  const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  const ownedEntryDirs: string[] = [];
  for (const entry of entries) {
    if (entry.name === "owner.json" && entry.isFile()) continue;
    if (!/^sha256-[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) {
      throw new Error(`managed llama.cpp cache contains an unowned entry: ${entry.name}`);
    }
    const entryDir = path.join(cacheDir, entry.name);
    if (!realOwnerDirectory(homeDir, entryDir, currentUserId)) {
      throw new Error(`managed llama.cpp cache entry is not an owner directory: ${entry.name}`);
    }
    assertOwnedCacheReceipt(entryDir, entry.name, owner);
    ownedEntryDirs.push(entryDir);
  }
  for (const entryDir of ownedEntryDirs) {
    if (!realOwnerDirectory(homeDir, entryDir, currentUserId)) {
      throw new Error(`managed llama.cpp cache entry changed before deletion: ${entryDir}`);
    }
    fs.rmSync(entryDir, { recursive: true });
  }
  fs.unlinkSync(path.join(cacheDir, "owner.json"));
  fs.rmdirSync(cacheDir);
  removed.push(`cache:${cacheDir}`);
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
  if (authFingerprint === undefined) {
    throw new Error("host-local vLLM ownership or authentication metadata is incomplete");
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
  const removal = deps.forceRm(inspected.id, { ignoreError: true, suppressOutput: true });
  if (removal.status !== 0) throw new Error("host-local vLLM container removal failed");
  removed.push(`container:${inspected.id}`);
  fs.unlinkSync(path.join(stateDir, MANAGED_VLLM_API_KEY_FILE));
}

function cleanupLlamaCpp(
  homeDir: string,
  privateStateDir: string,
  deps: CleanupDeps,
  removed: string[],
): void {
  const hasState = realOwnerDirectory(homeDir, privateStateDir, deps.currentUserId);
  if (!hasState) return;
  const owner = cacheOwner(privateStateDir);
  const apiKey = readOwnerOnlyRegularFile(path.join(privateStateDir, "api-key")).trim();
  if (!/^[a-f0-9]{64}$/.test(apiKey)) {
    throw new Error("managed llama.cpp API-key state is invalid");
  }
  const authFingerprint = runtimeAuthFingerprint(apiKey);
  const receipt = llamaCppRuntimeReceipt(privateStateDir, owner, authFingerprint);
  const container = inspectOwnedResource(
    "container",
    MANAGED_LLAMA_CPP_CONTAINER_NAME,
    MANAGED_LLAMA_CPP_OWNER_LABEL,
    MANAGED_LLAMA_CPP_OWNER_VALUE,
    deps.capture,
    {
      [MANAGED_LLAMA_CPP_GENERATION_LABEL]: owner.generation,
      [MANAGED_LLAMA_CPP_AUTH_LABEL]: authFingerprint,
    },
  );
  if (container.kind === "foreign") {
    throw new Error("llama.cpp container name is foreign while managed state remains");
  }
  if (container.kind === "owned" && (!receipt || container.id !== receipt.containerId)) {
    throw new Error("llama.cpp container does not match its persisted runtime receipt");
  }
  if (container.kind === "owned") {
    const result = deps.forceRm(container.id, { ignoreError: true, suppressOutput: true });
    if (result.status !== 0) throw new Error("managed llama.cpp container removal failed");
    removed.push(`container:${container.id}`);
  }

  const network = inspectOwnedResource(
    "network",
    MANAGED_LLAMA_CPP_NETWORK_NAME,
    MANAGED_LLAMA_CPP_OWNER_LABEL,
    MANAGED_LLAMA_CPP_OWNER_VALUE,
    deps.capture,
    { [MANAGED_LLAMA_CPP_GENERATION_LABEL]: owner.generation },
  );
  if (network.kind === "foreign") {
    throw new Error("llama.cpp network name is foreign while managed state remains");
  }
  if (network.kind === "owned" && (!receipt || network.id !== receipt.networkId)) {
    throw new Error("llama.cpp network does not match its persisted runtime receipt");
  }
  if (network.kind === "owned") {
    const result = deps.run(["network", "rm", network.id], {
      ignoreError: true,
      suppressOutput: true,
    });
    if (result.status !== 0) throw new Error("managed llama.cpp network removal failed");
    removed.push(`network:${network.id}`);
  }
}

/** Remove only exact owned host-local runtime resources before uninstall deletes state. */
export function cleanupLocalModelRuntimes(
  options: LocalModelRuntimeCleanupOptions,
): LocalModelRuntimeCleanupResult {
  const homeDir = options.homeDir ?? os.homedir();
  const stateDir = path.join(homeDir, ".nemoclaw");
  const llamaStateDir = path.join(stateDir, "managed-llama-cpp");
  const cacheDir = path.join(homeDir, ".cache", "nemoclaw", "llama-cpp");
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
    const dockerReady =
      deps.run(["info"], { ignoreError: true, suppressOutput: true }).status === 0;
    const localStateRequiresDocker =
      realOwnerDirectory(homeDir, llamaStateDir, deps.currentUserId) ||
      (fs.existsSync(path.join(stateDir, MANAGED_VLLM_API_KEY_FILE)) &&
        !distributedReceiptPresent(stateDir));
    if (!dockerReady && localStateRequiresDocker) {
      throw new Error("Docker is unavailable while host-local model ownership state remains");
    }
    if (dockerReady) {
      cleanupHostLocalVllm(stateDir, deps, removed);
      cleanupLlamaCpp(homeDir, llamaStateDir, deps, removed);
    }
    if (options.deleteModels && realOwnerDirectory(homeDir, cacheDir, deps.currentUserId)) {
      removeOwnedLlamaCppCache(homeDir, cacheDir, deps.currentUserId, removed);
    } else if (realOwnerDirectory(homeDir, cacheDir, deps.currentUserId)) {
      preserved.push(cacheDir);
    }
    return { ok: true, removed, preserved };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, removed, preserved };
  }
}
