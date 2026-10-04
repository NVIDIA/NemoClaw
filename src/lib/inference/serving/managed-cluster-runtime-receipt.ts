// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ensureLocalAdapterStateDir } from "../local-adapter-lifecycle";
import { loadManagedVllmApiKey, managedVllmStateDir } from "../vllm-api-key";
import { managedInferenceHexDigest } from "./catalog-integrity";
import {
  assertManagedClusterVllmExecutorConfig,
  createManagedClusterVllmExecutor,
  inspectManagedClusterVllmNodesSync,
  type ManagedClusterVllmNodeSnapshots,
} from "./managed-cluster-executor";
import { MANAGED_CLUSTER_ID_PATTERN } from "./managed-cluster-identifiers";
import {
  classifyManagedClusterExistingState,
  cleanupManagedClusterManagedVllm,
  type ManagedClusterVllmLifecycleDeps,
  managedClusterVllmApiKeyFingerprint,
} from "./managed-cluster-lifecycle";
import { type ManagedClusterVllmPlan, managedClusterHeadRole } from "./managed-cluster-materialize";
import { MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE } from "./managed-cluster-runtime-receipt-path";
import {
  clearManagedVllmSshBinding,
  copyManagedVllmSshBinding,
  encodeManagedVllmSshBindingHandoff,
  loadManagedVllmSshBindingForStatePath,
  loadManagedVllmSshBindingHandoff,
  type ManagedVllmSshBinding,
} from "./managed-cluster-ssh-binding";

const MAX_RECEIPT_BYTES = 128 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const BINDING_HANDLE = /^[A-Za-z0-9_-]{1,8192}$/;
const RECEIPT_KEYS = ["apiKeyFingerprint", "nodes", "plan", "planDigest", "schemaVersion"] as const;
const RECEIPT_NODE_KEYS = [
  "cacheRoot",
  "containerId",
  "discoveryBindingDigest",
  "discoveryStatePath",
  "nodeId",
  "sshBinding",
] as const;
function exactBindingKeys<const Keys extends readonly (keyof ManagedVllmSshBinding)[]>(
  keys: Keys & (Exclude<keyof ManagedVllmSshBinding, Keys[number]> extends never ? unknown : never),
): Keys {
  return keys;
}

const EXACT_BINDING_KEYS = exactBindingKeys([
  "schemaVersion",
  "peerTarget",
  "resolvedHost",
  "sshUser",
  "port",
  "lookupHost",
  "hostKeyDigest",
  "dockerCliFile",
  "dockerShimFile",
  "dockerShimSha256",
  "knownHostsFile",
  "knownHostsSha256",
  "bindingFile",
  "sshWrapperDirectory",
  "sshWrapperFile",
  "sshWrapperSha256",
] as const);

interface PersistedReceipt {
  readonly schemaVersion: 1;
  readonly plan: ManagedClusterVllmPlan;
  readonly planDigest: string;
  readonly nodes: readonly PersistedReceiptNode[];
  readonly apiKeyFingerprint: string;
}

interface PersistedReceiptNode {
  readonly nodeId: string;
  readonly cacheRoot: string;
  readonly containerId: string;
  readonly sshBinding: string | null;
  readonly discoveryStatePath: string | null;
  readonly discoveryBindingDigest: string | null;
}

export interface PersistManagedClusterVllmRuntimeReceiptInput {
  readonly plan: ManagedClusterVllmPlan;
  readonly nodes: readonly PersistManagedClusterVllmRuntimeReceiptNode[];
  readonly apiKeyFingerprint: string;
}

export interface PersistManagedClusterVllmRuntimeReceiptNode {
  readonly nodeId: string;
  readonly cacheRoot: string;
  readonly containerId: string;
  readonly sshBinding?: ManagedVllmSshBinding;
  readonly discoveryStatePath?: string;
}

export interface LoadedManagedClusterVllmRuntime {
  readonly plan: ManagedClusterVllmPlan;
  readonly nodes: readonly LoadedManagedClusterVllmRuntimeNode[];
  readonly apiKeyFingerprint: string;
}

export interface LoadedManagedClusterVllmRuntimeNode extends PersistedReceiptNode {
  readonly binding?: ManagedVllmSshBinding;
}

type CleanupDeps = Pick<
  ManagedClusterVllmLifecycleDeps,
  "inspectNode" | "removeContainer" | "withLifecycleLock"
>;

export interface ManagedClusterVllmRuntimeReceiptOptions {
  readonly stateDir?: string;
  /** @internal Test seam. */
  readonly loadApiKey?: () => string | null;
  /** @internal Test seam. */
  readonly createLifecycleDeps?: (runtime: LoadedManagedClusterVllmRuntime) => CleanupDeps;
  /** @internal Test seam. */
  readonly inspectNodesSync?: (
    runtime: LoadedManagedClusterVllmRuntime,
  ) => ManagedClusterVllmNodeSnapshots;
}

export interface RecoveredManagedClusterVllmEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyFingerprint: string;
  readonly plan: ManagedClusterVllmPlan;
}

export type ManagedClusterVllmRuntimeCleanupResult =
  | { readonly kind: "not-installed" }
  | { readonly kind: "removed"; readonly removedContainerIds: readonly string[] };

export function managedClusterVllmRuntimeReceiptPath(stateDir = managedVllmStateDir()): string {
  return path.join(stateDir, MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requireString(value: unknown, label: string, pattern: RegExp, maximum = 8192): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const candidate = requireString(value, label, /^[^\u0000-\u001f\u007f]+$/, 4096);
  if (!path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate) {
    throw new Error(`${label} must be a normalized absolute POSIX path`);
  }
  return candidate;
}

function planDigest(plan: ManagedClusterVllmPlan): string {
  return managedInferenceHexDigest(plan);
}

function workerTarget(plan: ManagedClusterVllmPlan, nodeId: string): string {
  const roles = Array.isArray(plan.roles) ? plan.roles : [];
  const worker = roles.find((role) => isRecord(role) && role.nodeId === nodeId);
  const execution = worker && isRecord(worker.execution) ? worker.execution : null;
  if (!execution || execution.kind !== "ssh") {
    throw new Error("Managed cluster worker SSH execution is invalid");
  }
  return requireString(
    execution.expectedTarget,
    "managed cluster worker SSH target",
    /^(?:[A-Za-z_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/,
    286,
  );
}

function assertExecutorContract(
  plan: ManagedClusterVllmPlan,
  nodes: readonly LoadedManagedClusterVllmRuntimeNode[],
): void {
  assertManagedClusterVllmExecutorConfig({
    plan,
    nodes: nodes.map(({ nodeId, cacheRoot, binding }) => ({
      nodeId,
      modelCacheRoot: cacheRoot,
      ...(binding ? { sshBinding: binding } : {}),
    })),
  });
}

function parseReceipt(value: unknown): PersistedReceipt {
  if (!isRecord(value)) throw new Error("Managed cluster vLLM runtime receipt is invalid");
  exactKeys(value, RECEIPT_KEYS, "Managed cluster vLLM runtime receipt");
  if (value.schemaVersion !== 1 || !isRecord(value.plan)) {
    throw new Error("Managed cluster vLLM runtime receipt schema is unsupported");
  }
  const plan = value.plan as unknown as ManagedClusterVllmPlan;
  if (!Array.isArray(plan.roles)) {
    throw new Error("Managed cluster runtime receipt node ownership is incomplete");
  }
  const digest = requireString(value.planDigest, "managed cluster plan digest", SHA256, 64);
  if (planDigest(plan) !== digest)
    throw new Error("Managed cluster vLLM runtime plan digest changed");
  if (!Array.isArray(value.nodes) || value.nodes.length !== plan.roles.length) {
    throw new Error("Managed cluster runtime receipt node ownership is incomplete");
  }
  const nodes = value.nodes.map((entry, index): PersistedReceiptNode => {
    if (!isRecord(entry)) throw new Error("Managed cluster runtime receipt node is invalid");
    exactKeys(entry, RECEIPT_NODE_KEYS, "Managed cluster runtime receipt node");
    const nodeId = requireString(
      entry.nodeId,
      "managed cluster node ID",
      MANAGED_CLUSTER_ID_PATTERN,
      128,
    );
    const rolePlan = plan.roles.find((role) => role.nodeId === nodeId);
    if (!rolePlan || rolePlan.rank !== index) {
      throw new Error("Managed cluster runtime receipt node order does not match the plan");
    }
    const remote = rolePlan.execution.kind === "ssh";
    return {
      nodeId,
      cacheRoot: requireAbsolutePath(entry.cacheRoot, "managed cluster cache root"),
      containerId: requireString(
        entry.containerId,
        "managed cluster container ID",
        CONTAINER_ID,
        64,
      ),
      sshBinding: remote
        ? requireString(entry.sshBinding, "managed cluster SSH binding", BINDING_HANDLE)
        : entry.sshBinding === null
          ? null
          : (() => {
              throw new Error("Managed cluster local node cannot contain an SSH binding");
            })(),
      discoveryStatePath: remote
        ? requireAbsolutePath(entry.discoveryStatePath, "managed cluster discovery state path")
        : entry.discoveryStatePath === null
          ? null
          : (() => {
              throw new Error("Managed cluster local node cannot contain discovery state");
            })(),
      discoveryBindingDigest: remote
        ? requireString(
            entry.discoveryBindingDigest,
            "managed cluster discovery SSH binding digest",
            SHA256,
            64,
          )
        : entry.discoveryBindingDigest === null
          ? null
          : (() => {
              throw new Error("Managed cluster local node cannot contain a binding digest");
            })(),
    };
  });
  if (
    new Set(nodes.map(({ nodeId }) => nodeId)).size !== nodes.length ||
    new Set(nodes.map(({ containerId }) => containerId)).size !== nodes.length
  ) {
    throw new Error("Managed cluster container identities are ambiguous");
  }
  return {
    schemaVersion: 1,
    plan,
    planDigest: digest,
    nodes,
    apiKeyFingerprint: requireString(
      value.apiKeyFingerprint,
      "managed cluster API key fingerprint",
      SHA256,
      64,
    ),
  };
}

function assertPrivateReceipt(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(
      `Managed cluster vLLM runtime receipt must be a private regular file: ${filePath}`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Managed cluster vLLM runtime receipt has the wrong owner: ${filePath}`);
  }
}

function loadPersistedReceipt(stateDir: string): PersistedReceipt | null {
  const filePath = managedClusterVllmRuntimeReceiptPath(stateDir);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform");
  }
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") {
        throw new Error(`Refusing to read managed cluster runtime receipt through a symbolic link`);
      }
      throw error;
    }
    const stat = fs.fstatSync(fd);
    assertPrivateReceipt(stat, filePath);
    if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      throw new Error(`Managed cluster vLLM runtime receipt is malformed: ${filePath}`);
    }
    return parseReceipt(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Managed cluster vLLM runtime receipt is malformed: ${filePath}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeReceipt(receipt: PersistedReceipt, stateDir: string): void {
  ensureLocalAdapterStateDir(stateDir);
  const filePath = managedClusterVllmRuntimeReceiptPath(stateDir);
  const temporary = `${filePath}.tmp-${String(process.pid)}-${Date.now().toString(16)}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    assertPrivateReceipt(fs.fstatSync(fd), temporary);
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(stateDir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the receipt-write failure.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A leftover unique temporary file must not mask the receipt-write failure.
    }
    throw error;
  }
}

function durablePlan(
  plan: ManagedClusterVllmPlan,
  sshBindings: ReadonlyMap<string, string>,
): ManagedClusterVllmPlan {
  return {
    ...plan,
    roles: plan.roles.map((rolePlan) =>
      rolePlan.execution.kind === "ssh"
        ? {
            ...rolePlan,
            execution: {
              ...rolePlan.execution,
              bindingHandle:
                sshBindings.get(rolePlan.nodeId) ??
                (() => {
                  throw new Error(`Managed cluster worker ${rolePlan.nodeId} has no SSH binding`);
                })(),
            },
          }
        : rolePlan,
    ),
  };
}

function loadedRuntime(receipt: PersistedReceipt): LoadedManagedClusterVllmRuntime {
  const nodes = receipt.nodes.map((node): LoadedManagedClusterVllmRuntimeNode => {
    if (node.sshBinding === null) return node;
    const binding = loadManagedVllmSshBindingHandoff(
      node.sshBinding,
      workerTarget(receipt.plan, node.nodeId),
    );
    if (encodeManagedVllmSshBindingHandoff(binding) !== node.sshBinding) {
      throw new Error("Managed cluster runtime SSH binding identity changed");
    }
    return { ...node, binding };
  });
  assertExecutorContract(receipt.plan, nodes);
  return { ...receipt, nodes };
}

function bindingDigest(binding: ManagedVllmSshBinding): string {
  return managedInferenceHexDigest(
    Object.fromEntries(EXACT_BINDING_KEYS.map((field) => [field, binding[field]])),
  );
}

function loadReceiptOwnedDiscoveryBinding(
  runtime: LoadedManagedClusterVllmRuntime,
): readonly { readonly nodeId: string; readonly binding: ManagedVllmSshBinding | null }[] {
  return runtime.nodes
    .filter((node) => node.binding)
    .map((node) => {
      const binding = loadManagedVllmSshBindingForStatePath(
        node.discoveryStatePath!,
        node.binding!.peerTarget,
        node.binding!.hostKeyDigest,
      );
      if (binding && bindingDigest(binding) !== node.discoveryBindingDigest) {
        throw new Error(
          "Managed cluster discovery SSH binding does not match the runtime receipt identity",
        );
      }
      return { nodeId: node.nodeId, binding };
    });
}

export function loadManagedClusterVllmRuntimeReceipt(
  options: Pick<ManagedClusterVllmRuntimeReceiptOptions, "stateDir"> = {},
): LoadedManagedClusterVllmRuntime | null {
  const receipt = loadPersistedReceipt(options.stateDir ?? managedVllmStateDir());
  return receipt ? loadedRuntime(receipt) : null;
}

function sameInput(
  existing: LoadedManagedClusterVllmRuntime,
  input: PersistManagedClusterVllmRuntimeReceiptInput,
): boolean {
  const durable = durablePlan(
    input.plan,
    new Map(
      existing.nodes.flatMap((node) =>
        node.sshBinding ? [[node.nodeId, node.sshBinding] as const] : [],
      ),
    ),
  );
  const existingNodes = new Map(existing.nodes.map((node) => [node.nodeId, node]));
  return (
    planDigest(durable) === planDigest(existing.plan) &&
    input.apiKeyFingerprint === existing.apiKeyFingerprint &&
    input.nodes.length === existing.nodes.length &&
    input.nodes.every((node) => {
      const current = existingNodes.get(node.nodeId);
      return (
        current?.nodeId === node.nodeId &&
        current.cacheRoot === node.cacheRoot &&
        current.containerId === node.containerId &&
        current.discoveryStatePath === (node.discoveryStatePath ?? null) &&
        current.discoveryBindingDigest === (node.sshBinding ? bindingDigest(node.sshBinding) : null)
      );
    })
  );
}

/** Persist immutable ownership and pinned transport state for recovery/uninstall. */
export function persistManagedClusterVllmRuntimeReceipt(
  input: PersistManagedClusterVllmRuntimeReceiptInput,
  options: Pick<ManagedClusterVllmRuntimeReceiptOptions, "stateDir"> = {},
): LoadedManagedClusterVllmRuntime {
  const stateDir = options.stateDir ?? managedVllmStateDir();
  ensureLocalAdapterStateDir(stateDir);
  requireString(input.apiKeyFingerprint, "managed cluster API key fingerprint", SHA256, 64);
  if (
    input.nodes.length !== input.plan.roles.length ||
    new Set(input.nodes.map(({ nodeId }) => nodeId)).size !== input.nodes.length ||
    new Set(input.nodes.map(({ containerId }) => containerId)).size !== input.nodes.length
  ) {
    throw new Error("Managed cluster runtime receipt node ownership is incomplete or ambiguous");
  }
  const inputNodes = input.plan.roles.map(
    (rolePlan, index): LoadedManagedClusterVllmRuntimeNode => {
      const node = input.nodes.find((candidate) => candidate.nodeId === rolePlan.nodeId);
      if (!node) throw new Error(`Managed cluster rank ${String(index)} has no receipt input`);
      requireString(node.containerId, "managed cluster container ID", CONTAINER_ID, 64);
      const cacheRoot = requireAbsolutePath(node.cacheRoot, "managed cluster cache root");
      if (
        (rolePlan.execution.kind === "local" &&
          (node.sshBinding !== undefined || node.discoveryStatePath !== undefined)) ||
        (rolePlan.execution.kind === "ssh" && (!node.sshBinding || !node.discoveryStatePath))
      ) {
        throw new Error(`Managed cluster node ${node.nodeId} transport ownership is invalid`);
      }
      return {
        nodeId: node.nodeId,
        cacheRoot,
        containerId: node.containerId,
        sshBinding: node.sshBinding ? encodeManagedVllmSshBindingHandoff(node.sshBinding) : null,
        discoveryStatePath: node.discoveryStatePath ?? null,
        discoveryBindingDigest: node.sshBinding ? bindingDigest(node.sshBinding) : null,
        ...(node.sshBinding ? { binding: node.sshBinding } : {}),
      };
    },
  );
  assertExecutorContract(input.plan, inputNodes);

  const existing = loadManagedClusterVllmRuntimeReceipt({ stateDir });
  if (existing) {
    if (!sameInput(existing, input)) {
      throw new Error("A different managed cluster runtime receipt already owns recovery state");
    }
    return existing;
  }

  const receiptPath = managedClusterVllmRuntimeReceiptPath(stateDir);
  const createdBindingStatePaths: string[] = [];
  try {
    const runtimeBindings = new Map<string, ManagedVllmSshBinding>();
    const persistedNodes = inputNodes.map((node, index): PersistedReceiptNode => {
      const { binding, ...persisted } = node;
      if (!binding) return persisted;
      const rolePlan = input.plan.roles[index]!;
      const runtimeStatePath = `${receiptPath}.rank-${String(rolePlan.rank)}`;
      const bindingPath = `${runtimeStatePath}.ssh-binding`;
      try {
        fs.mkdirSync(bindingPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Managed cluster SSH binding state already exists: ${bindingPath}`);
        }
        throw error;
      }
      createdBindingStatePaths.push(runtimeStatePath);
      const runtimeBinding = copyManagedVllmSshBinding(runtimeStatePath, binding);
      runtimeBindings.set(node.nodeId, runtimeBinding);
      return { ...persisted, sshBinding: encodeManagedVllmSshBindingHandoff(runtimeBinding) };
    });
    fsyncDirectory(stateDir);
    const plan = durablePlan(
      input.plan,
      new Map(
        persistedNodes.flatMap((node) =>
          node.sshBinding ? [[node.nodeId, node.sshBinding] as const] : [],
        ),
      ),
    );
    const loadedNodes = persistedNodes.map((node) => ({
      ...node,
      ...(runtimeBindings.has(node.nodeId) ? { binding: runtimeBindings.get(node.nodeId)! } : {}),
    }));
    assertExecutorContract(plan, loadedNodes);
    const receipt: PersistedReceipt = {
      schemaVersion: 1,
      plan,
      planDigest: planDigest(plan),
      nodes: persistedNodes,
      apiKeyFingerprint: input.apiKeyFingerprint,
    };
    writeReceipt(receipt, stateDir);
    return loadedRuntime(receipt);
  } catch (error) {
    try {
      for (const statePath of createdBindingStatePaths.reverse()) {
        clearManagedVllmSshBinding(statePath);
      }
    } catch {
      // Preserve the receipt persistence error.
    }
    throw error;
  }
}

function clearReceipt(stateDir: string, runtime: LoadedManagedClusterVllmRuntime): void {
  const filePath = managedClusterVllmRuntimeReceiptPath(stateDir);
  fs.unlinkSync(filePath);
  for (const rolePlan of runtime.plan.roles) {
    if (rolePlan.execution.kind === "ssh") {
      clearManagedVllmSshBinding(`${filePath}.rank-${String(rolePlan.rank)}`);
    }
  }
  fsyncDirectory(stateDir);
}

function defaultCreateLifecycleDeps(runtime: LoadedManagedClusterVllmRuntime): CleanupDeps {
  return createManagedClusterVllmExecutor({
    plan: runtime.plan,
    nodes: runtime.nodes.map(({ nodeId, cacheRoot, binding }) => ({
      nodeId,
      modelCacheRoot: cacheRoot,
      ...(binding ? { sshBinding: binding } : {}),
    })),
  });
}

function defaultInspectNodesSync(
  runtime: LoadedManagedClusterVllmRuntime,
): ManagedClusterVllmNodeSnapshots {
  return inspectManagedClusterVllmNodesSync({
    plan: runtime.plan,
    nodes: runtime.nodes.map(({ nodeId, cacheRoot, binding }) => ({
      nodeId,
      modelCacheRoot: cacheRoot,
      ...(binding ? { sshBinding: binding } : {}),
    })),
  });
}

/** Recover only the exact healthy receipt-owned cluster; unsafe managed state is explicit. */
export function recoverInstalledManagedClusterVllmEndpoint(
  options: Pick<
    ManagedClusterVllmRuntimeReceiptOptions,
    "inspectNodesSync" | "loadApiKey" | "stateDir"
  > = {},
): RecoveredManagedClusterVllmEndpoint | null {
  const runtime = loadManagedClusterVllmRuntimeReceipt({ stateDir: options.stateDir });
  if (!runtime) return null;
  const apiKey = (options.loadApiKey ?? loadManagedVllmApiKey)();
  if (!apiKey || managedClusterVllmApiKeyFingerprint(apiKey) !== runtime.apiKeyFingerprint) {
    throw new Error("Managed cluster API key no longer matches the runtime receipt");
  }
  let snapshots: ManagedClusterVllmNodeSnapshots;
  try {
    snapshots = (options.inspectNodesSync ?? defaultInspectNodesSync)(runtime);
  } catch (error) {
    throw new Error(
      `Could not inspect the managed cluster: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const state = classifyManagedClusterExistingState(
    runtime.plan,
    runtime.apiKeyFingerprint,
    snapshots.nodes,
  );
  const expectedContainers = new Map(
    runtime.nodes.map(({ nodeId, containerId }) => [nodeId, containerId]),
  );
  if (
    state.outcome !== "reuse" ||
    state.containers.length !== expectedContainers.size ||
    state.containers.some(
      ({ nodeId, containerId }) => expectedContainers.get(nodeId) !== containerId,
    )
  ) {
    const reason = "reason" in state ? state.reason : "receipt-owned container IDs changed";
    throw new Error(`Managed cluster runtime is not recoverable: ${reason}`);
  }
  const baseUrl = managedClusterHeadRole(runtime.plan).endpoint;
  if (!baseUrl) throw new Error("Managed cluster head endpoint is invalid");
  return {
    baseUrl,
    apiKey,
    apiKeyFingerprint: runtime.apiKeyFingerprint,
    plan: runtime.plan,
  };
}

/** Remove only receipt-ID-owned containers, then retire fully accounted ownership state. */
export async function cleanupInstalledManagedClusterVllmRuntime(
  options: ManagedClusterVllmRuntimeReceiptOptions = {},
): Promise<ManagedClusterVllmRuntimeCleanupResult> {
  const stateDir = options.stateDir ?? managedVllmStateDir();
  const runtime = loadManagedClusterVllmRuntimeReceipt({ stateDir });
  if (!runtime) return { kind: "not-installed" };

  const apiKey = (options.loadApiKey ?? loadManagedVllmApiKey)();
  if (!apiKey || managedClusterVllmApiKeyFingerprint(apiKey) !== runtime.apiKeyFingerprint) {
    throw new Error("Managed cluster API key no longer matches the runtime receipt");
  }
  const discoveryBindings = loadReceiptOwnedDiscoveryBinding(runtime);
  const deps = (options.createLifecycleDeps ?? defaultCreateLifecycleDeps)(runtime);
  const cleanup = await cleanupManagedClusterManagedVllm(runtime.plan, apiKey, deps, {
    containers: runtime.nodes.map(({ nodeId, containerId }) => ({ nodeId, containerId })),
  });
  if (!cleanup.ok) throw new Error(cleanup.reason);
  const expected = new Set(runtime.nodes.map(({ containerId }) => containerId));
  const accounted = [...cleanup.removedContainerIds, ...(cleanup.alreadyAbsentContainerIds ?? [])];
  if (
    accounted.length !== expected.size ||
    new Set(accounted).size !== expected.size ||
    accounted.some((id) => !expected.has(id))
  ) {
    throw new Error("Managed cluster cleanup returned unexpected container identities");
  }
  const currentDiscoveryBindings = loadReceiptOwnedDiscoveryBinding(runtime);
  if (
    discoveryBindings.length !== currentDiscoveryBindings.length ||
    discoveryBindings.some(
      (entry, index) =>
        entry.nodeId !== currentDiscoveryBindings[index]?.nodeId ||
        (entry.binding === null) !== (currentDiscoveryBindings[index]?.binding === null),
    )
  ) {
    throw new Error("Managed cluster discovery SSH binding changed during runtime cleanup");
  }
  for (const entry of currentDiscoveryBindings) {
    if (entry.binding) {
      const node = runtime.nodes.find(({ nodeId }) => nodeId === entry.nodeId)!;
      clearManagedVllmSshBinding(node.discoveryStatePath!);
    }
  }
  clearReceipt(stateDir, runtime);
  return { kind: "removed", removedContainerIds: cleanup.removedContainerIds };
}
