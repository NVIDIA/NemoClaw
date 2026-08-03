// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ensureLocalAdapterStateDir } from "../local-adapter-lifecycle";
import { loadManagedVllmApiKey, managedVllmStateDir } from "../vllm-api-key";
import {
  clearDualStationSshBinding,
  copyDualStationSshBinding,
  type DualStationSshBinding,
  encodeDualStationSshBindingHandoff,
  loadDualStationSshBindingHandoff,
} from "../vllm-station-ssh-binding";
import { loadManagedInferenceCatalog } from "./catalog";
import { managedInferenceHexDigest } from "./catalog-integrity";
import {
  assertDualSparkVllmExecutorConfig,
  createDualSparkVllmExecutor,
  type DualSparkVllmNodeSnapshots,
  inspectDualSparkVllmNodesSync,
} from "./dual-spark-executor";
import {
  classifyDualSparkExistingState,
  cleanupDualSparkManagedVllm,
  type DualSparkVllmLifecycleDeps,
  dualSparkVllmApiKeyFingerprint,
} from "./dual-spark-lifecycle";
import type { DualSparkVllmPlan } from "./dual-spark-materialize";
import { DUAL_SPARK_VLLM_RUNTIME_RECEIPT_FILE } from "./spark-runtime-receipt-path";

const MAX_RECEIPT_BYTES = 128 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const BINDING_HANDLE = /^[A-Za-z0-9_-]{1,8192}$/;
const RECEIPT_KEYS = [
  "apiKeyFingerprint",
  "headContainerId",
  "localCacheRoot",
  "peerCacheRoot",
  "plan",
  "planDigest",
  "schemaVersion",
  "sshBinding",
  "workerContainerId",
] as const;

interface PersistedReceipt {
  readonly schemaVersion: 1;
  readonly plan: DualSparkVllmPlan;
  readonly planDigest: string;
  readonly sshBinding: string;
  readonly localCacheRoot: string;
  readonly peerCacheRoot: string;
  readonly apiKeyFingerprint: string;
  readonly headContainerId: string;
  readonly workerContainerId: string;
}

export interface PersistDualSparkVllmRuntimeReceiptInput {
  readonly plan: DualSparkVllmPlan;
  readonly peerSshBinding: DualStationSshBinding;
  readonly localCacheRoot: string;
  readonly peerCacheRoot: string;
  readonly apiKeyFingerprint: string;
  readonly headContainerId: string;
  readonly workerContainerId: string;
}

export interface LoadedDualSparkVllmRuntime {
  readonly plan: DualSparkVllmPlan;
  readonly peerSshBinding: DualStationSshBinding;
  readonly sshBinding: string;
  readonly localCacheRoot: string;
  readonly peerCacheRoot: string;
  readonly apiKeyFingerprint: string;
  readonly headContainerId: string;
  readonly workerContainerId: string;
}

type CleanupDeps = Pick<
  DualSparkVllmLifecycleDeps,
  "inspectNode" | "removeContainer" | "withLifecycleLock"
>;

export interface DualSparkVllmRuntimeReceiptOptions {
  readonly stateDir?: string;
  /** @internal Test seam. */
  readonly loadApiKey?: () => string | null;
  /** @internal Test seam. */
  readonly createLifecycleDeps?: (runtime: LoadedDualSparkVllmRuntime) => CleanupDeps;
  /** @internal Test seam. */
  readonly inspectNodesSync?: (runtime: LoadedDualSparkVllmRuntime) => DualSparkVllmNodeSnapshots;
}

export interface RecoveredDualSparkVllmEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyFingerprint: string;
  readonly plan: DualSparkVllmPlan;
}

export type DualSparkVllmRuntimeCleanupResult =
  | { readonly kind: "not-installed" }
  | { readonly kind: "removed"; readonly removedContainerIds: readonly string[] };

export function dualSparkVllmRuntimeReceiptPath(stateDir = managedVllmStateDir()): string {
  return path.join(stateDir, DUAL_SPARK_VLLM_RUNTIME_RECEIPT_FILE);
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

function planDigest(plan: DualSparkVllmPlan): string {
  return managedInferenceHexDigest(plan);
}

function workerTarget(plan: DualSparkVllmPlan): string {
  const roles = isRecord(plan.roles) ? plan.roles : null;
  const worker = roles && isRecord(roles.worker) ? roles.worker : null;
  const execution = worker && isRecord(worker.execution) ? worker.execution : null;
  if (!execution || execution.kind !== "ssh") {
    throw new Error("Dual-Spark worker SSH execution is invalid");
  }
  return requireString(
    execution.expectedTarget,
    "dual-Spark worker SSH target",
    /^(?:[A-Za-z_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/,
    286,
  );
}

function assertExecutorContract(
  plan: DualSparkVllmPlan,
  peerSshBinding: DualStationSshBinding,
  localCacheRoot: string,
  peerCacheRoot: string,
): void {
  if (plan.catalogDigest !== loadManagedInferenceCatalog().catalogDigest) {
    throw new Error("Dual-Spark runtime plan does not match the shipped catalog");
  }
  assertDualSparkVllmExecutorConfig({
    plan,
    peerSshBinding,
    localCacheRoot,
    peerCacheRoot,
  });
}

function parseReceipt(value: unknown): PersistedReceipt {
  if (!isRecord(value)) throw new Error("Dual-Spark vLLM runtime receipt is invalid");
  exactKeys(value, RECEIPT_KEYS, "Dual-Spark vLLM runtime receipt");
  if (value.schemaVersion !== 1 || !isRecord(value.plan)) {
    throw new Error("Dual-Spark vLLM runtime receipt schema is unsupported");
  }
  const plan = value.plan as unknown as DualSparkVllmPlan;
  const digest = requireString(value.planDigest, "dual-Spark plan digest", SHA256, 64);
  if (planDigest(plan) !== digest) throw new Error("Dual-Spark vLLM runtime plan digest changed");
  const headContainerId = requireString(
    value.headContainerId,
    "dual-Spark head container ID",
    CONTAINER_ID,
    64,
  );
  const workerContainerId = requireString(
    value.workerContainerId,
    "dual-Spark worker container ID",
    CONTAINER_ID,
    64,
  );
  if (headContainerId === workerContainerId) {
    throw new Error("Dual-Spark container identities are ambiguous");
  }
  return {
    schemaVersion: 1,
    plan,
    planDigest: digest,
    sshBinding: requireString(value.sshBinding, "dual-Spark SSH binding", BINDING_HANDLE),
    localCacheRoot: requireAbsolutePath(value.localCacheRoot, "dual-Spark local cache root"),
    peerCacheRoot: requireAbsolutePath(value.peerCacheRoot, "dual-Spark peer cache root"),
    apiKeyFingerprint: requireString(
      value.apiKeyFingerprint,
      "dual-Spark API key fingerprint",
      SHA256,
      64,
    ),
    headContainerId,
    workerContainerId,
  };
}

function assertPrivateReceipt(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Dual-Spark vLLM runtime receipt must be a private regular file: ${filePath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Dual-Spark vLLM runtime receipt has the wrong owner: ${filePath}`);
  }
}

function loadPersistedReceipt(stateDir: string): PersistedReceipt | null {
  const filePath = dualSparkVllmRuntimeReceiptPath(stateDir);
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
        throw new Error(`Refusing to read dual-Spark runtime receipt through a symbolic link`);
      }
      throw error;
    }
    const stat = fs.fstatSync(fd);
    assertPrivateReceipt(stat, filePath);
    if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      throw new Error(`Dual-Spark vLLM runtime receipt is malformed: ${filePath}`);
    }
    return parseReceipt(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Dual-Spark vLLM runtime receipt is malformed: ${filePath}`);
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
  const filePath = dualSparkVllmRuntimeReceiptPath(stateDir);
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
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function durablePlan(plan: DualSparkVllmPlan, sshBinding: string): DualSparkVllmPlan {
  if (plan.roles.worker.execution.kind !== "ssh") {
    throw new Error("Dual-Spark worker SSH execution is invalid");
  }
  return {
    ...plan,
    roles: {
      ...plan.roles,
      worker: {
        ...plan.roles.worker,
        execution: { ...plan.roles.worker.execution, bindingHandle: sshBinding },
      },
    },
  };
}

function loadedRuntime(receipt: PersistedReceipt): LoadedDualSparkVllmRuntime {
  const binding = loadDualStationSshBindingHandoff(receipt.sshBinding, workerTarget(receipt.plan));
  if (encodeDualStationSshBindingHandoff(binding) !== receipt.sshBinding) {
    throw new Error("Dual-Spark runtime SSH binding identity changed");
  }
  assertExecutorContract(receipt.plan, binding, receipt.localCacheRoot, receipt.peerCacheRoot);
  return { ...receipt, peerSshBinding: binding };
}

export function loadDualSparkVllmRuntimeReceipt(
  options: Pick<DualSparkVllmRuntimeReceiptOptions, "stateDir"> = {},
): LoadedDualSparkVllmRuntime | null {
  const receipt = loadPersistedReceipt(options.stateDir ?? managedVllmStateDir());
  return receipt ? loadedRuntime(receipt) : null;
}

function sameInput(
  existing: LoadedDualSparkVllmRuntime,
  input: PersistDualSparkVllmRuntimeReceiptInput,
): boolean {
  return (
    planDigest(durablePlan(input.plan, existing.sshBinding)) === planDigest(existing.plan) &&
    input.peerSshBinding.peerTarget === existing.peerSshBinding.peerTarget &&
    input.peerSshBinding.hostKeyDigest === existing.peerSshBinding.hostKeyDigest &&
    input.peerSshBinding.resolvedHost === existing.peerSshBinding.resolvedHost &&
    input.peerSshBinding.sshUser === existing.peerSshBinding.sshUser &&
    input.peerSshBinding.port === existing.peerSshBinding.port &&
    input.localCacheRoot === existing.localCacheRoot &&
    input.peerCacheRoot === existing.peerCacheRoot &&
    input.apiKeyFingerprint === existing.apiKeyFingerprint &&
    input.headContainerId === existing.headContainerId &&
    input.workerContainerId === existing.workerContainerId
  );
}

/** Persist immutable ownership and pinned transport state for recovery/uninstall. */
export function persistDualSparkVllmRuntimeReceipt(
  input: PersistDualSparkVllmRuntimeReceiptInput,
  options: Pick<DualSparkVllmRuntimeReceiptOptions, "stateDir"> = {},
): LoadedDualSparkVllmRuntime {
  const stateDir = options.stateDir ?? managedVllmStateDir();
  ensureLocalAdapterStateDir(stateDir);
  requireString(input.apiKeyFingerprint, "dual-Spark API key fingerprint", SHA256, 64);
  requireString(input.headContainerId, "dual-Spark head container ID", CONTAINER_ID, 64);
  requireString(input.workerContainerId, "dual-Spark worker container ID", CONTAINER_ID, 64);
  if (input.headContainerId === input.workerContainerId) {
    throw new Error("Dual-Spark container identities are ambiguous");
  }
  assertExecutorContract(
    input.plan,
    input.peerSshBinding,
    input.localCacheRoot,
    input.peerCacheRoot,
  );

  const existing = loadDualSparkVllmRuntimeReceipt({ stateDir });
  if (existing) {
    if (!sameInput(existing, input)) {
      throw new Error("A different managed dual-Spark runtime receipt already owns recovery state");
    }
    return existing;
  }

  const receiptPath = dualSparkVllmRuntimeReceiptPath(stateDir);
  const bindingPath = `${receiptPath}.ssh-binding`;
  try {
    fs.mkdirSync(bindingPath, { mode: 0o700 });
    fsyncDirectory(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Managed dual-Spark SSH binding state already exists: ${bindingPath}`);
    }
    throw error;
  }
  try {
    const runtimeBinding = copyDualStationSshBinding(receiptPath, input.peerSshBinding);
    const sshBinding = encodeDualStationSshBindingHandoff(runtimeBinding);
    const plan = durablePlan(input.plan, sshBinding);
    assertExecutorContract(plan, runtimeBinding, input.localCacheRoot, input.peerCacheRoot);
    const receipt: PersistedReceipt = {
      schemaVersion: 1,
      plan,
      planDigest: planDigest(plan),
      sshBinding,
      localCacheRoot: input.localCacheRoot,
      peerCacheRoot: input.peerCacheRoot,
      apiKeyFingerprint: input.apiKeyFingerprint,
      headContainerId: input.headContainerId,
      workerContainerId: input.workerContainerId,
    };
    writeReceipt(receipt, stateDir);
    return loadedRuntime(receipt);
  } catch (error) {
    try {
      clearDualStationSshBinding(receiptPath);
    } catch {
      // Preserve the receipt persistence error.
    }
    throw error;
  }
}

function clearReceipt(stateDir: string): void {
  const filePath = dualSparkVllmRuntimeReceiptPath(stateDir);
  fs.unlinkSync(filePath);
  clearDualStationSshBinding(filePath);
  fsyncDirectory(stateDir);
}

function defaultCreateLifecycleDeps(runtime: LoadedDualSparkVllmRuntime): CleanupDeps {
  return createDualSparkVllmExecutor({
    plan: runtime.plan,
    peerSshBinding: runtime.peerSshBinding,
    localCacheRoot: runtime.localCacheRoot,
    peerCacheRoot: runtime.peerCacheRoot,
  });
}

function defaultInspectNodesSync(runtime: LoadedDualSparkVllmRuntime): DualSparkVllmNodeSnapshots {
  return inspectDualSparkVllmNodesSync({
    plan: runtime.plan,
    peerSshBinding: runtime.peerSshBinding,
    localCacheRoot: runtime.localCacheRoot,
    peerCacheRoot: runtime.peerCacheRoot,
  });
}

/** Recover only the exact healthy receipt-owned pair; unsafe managed state is explicit. */
export function recoverInstalledDualSparkVllmEndpoint(
  options: Pick<
    DualSparkVllmRuntimeReceiptOptions,
    "inspectNodesSync" | "loadApiKey" | "stateDir"
  > = {},
): RecoveredDualSparkVllmEndpoint | null {
  const runtime = loadDualSparkVllmRuntimeReceipt({ stateDir: options.stateDir });
  if (!runtime) return null;
  const apiKey = (options.loadApiKey ?? loadManagedVllmApiKey)();
  if (!apiKey || dualSparkVllmApiKeyFingerprint(apiKey) !== runtime.apiKeyFingerprint) {
    throw new Error("Managed dual-Spark API key no longer matches the runtime receipt");
  }
  let snapshots: DualSparkVllmNodeSnapshots;
  try {
    snapshots = (options.inspectNodesSync ?? defaultInspectNodesSync)(runtime);
  } catch (error) {
    throw new Error(
      `Could not inspect the managed dual-Spark pair: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const state = classifyDualSparkExistingState(runtime.plan, runtime.apiKeyFingerprint, snapshots);
  if (
    state.outcome !== "reuse" ||
    state.headContainerId !== runtime.headContainerId ||
    state.workerContainerId !== runtime.workerContainerId
  ) {
    const reason = "reason" in state ? state.reason : "receipt-owned container IDs changed";
    throw new Error(`Managed dual-Spark runtime is not recoverable: ${reason}`);
  }
  const baseUrl = runtime.plan.roles.head.endpoint;
  if (!baseUrl) throw new Error("Managed dual-Spark head endpoint is invalid");
  return {
    baseUrl,
    apiKey,
    apiKeyFingerprint: runtime.apiKeyFingerprint,
    plan: runtime.plan,
  };
}

/** Remove only receipt-ID-owned containers, then retire fully accounted ownership state. */
export async function cleanupInstalledDualSparkVllmRuntime(
  options: DualSparkVllmRuntimeReceiptOptions = {},
): Promise<DualSparkVllmRuntimeCleanupResult> {
  const stateDir = options.stateDir ?? managedVllmStateDir();
  const runtime = loadDualSparkVllmRuntimeReceipt({ stateDir });
  if (!runtime) return { kind: "not-installed" };

  const apiKey = (options.loadApiKey ?? loadManagedVllmApiKey)();
  if (!apiKey || dualSparkVllmApiKeyFingerprint(apiKey) !== runtime.apiKeyFingerprint) {
    throw new Error("Managed dual-Spark API key no longer matches the runtime receipt");
  }
  const deps = (options.createLifecycleDeps ?? defaultCreateLifecycleDeps)(runtime);
  const cleanup = await cleanupDualSparkManagedVllm(runtime.plan, apiKey, deps, {
    headContainerId: runtime.headContainerId,
    workerContainerId: runtime.workerContainerId,
  });
  if (!cleanup.ok) throw new Error(cleanup.reason);
  const expected = new Set([runtime.headContainerId, runtime.workerContainerId]);
  const accounted = [...cleanup.removedContainerIds, ...(cleanup.alreadyAbsentContainerIds ?? [])];
  if (
    accounted.length !== expected.size ||
    new Set(accounted).size !== expected.size ||
    accounted.some((id) => !expected.has(id))
  ) {
    throw new Error("Managed dual-Spark cleanup returned unexpected container identities");
  }
  clearReceipt(stateDir);
  return { kind: "removed", removedContainerIds: cleanup.removedContainerIds };
}
