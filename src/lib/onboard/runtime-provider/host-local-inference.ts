// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { spawn } from "node:child_process";

import type { ContainerEngine } from "../../adapters/container-engine";
import type { LlamaCppGgufCachePlan } from "../../inference/llama-cpp/gguf-cache-plan";
import type {
  LlamaCppHostLocalLaunchContract,
  LlamaCppHostLocalRuntimeBindings,
} from "../../inference/llama-cpp/host-local-runtime";
import type { HostLocalCreateJournalStore } from "./host-local-create-journal";
import {
  normalizePersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
} from "./persisted-engine-authority";

export const HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type HostLocalInferenceService = "ollama" | "nim" | "vllm" | "llama-cpp";

export interface HostLocalInferenceModelAuthority {
  /** Digest of the complete YAML-compiled acquisition plan. */
  readonly planDigest: string;
  readonly recipeId: string;
  /** Provider-owned create transaction generation; never a filesystem or secret identity. */
  readonly generation: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface HostLocalInferenceEndpointInput {
  readonly networkName: string;
  readonly hostPort: number;
  readonly probeImageRef: string;
}

export interface HostLocalInferenceMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface HostLocalManagedInferenceInput extends HostLocalInferenceEndpointInput {
  readonly service: "nim" | "vllm";
  readonly containerName: string;
  readonly containerPort: number;
  readonly imageRef: string;
  readonly gpuDevices: readonly string[];
  /** Environment variable names forwarded from the current process; values are never persisted. */
  readonly environment?: readonly string[];
  readonly mounts?: readonly HostLocalInferenceMount[];
  readonly sharedMemory?: string;
  readonly ipc?: "host" | "private";
  readonly command?: readonly string[];
}

export interface HostLocalInferenceEndpointAuthority {
  readonly host: string;
  readonly port: number;
  readonly networkName: string;
}

export type HostLocalInferenceRuntimeAuthority =
  | {
      readonly kind: "host";
      /** Immutable utility image used to prove endpoint reachability from the runtime network. */
      readonly probeImageRef: string;
    }
  | {
      readonly kind: "container";
      readonly runtimeId: string;
      readonly name: string;
      readonly imageRef: string;
      /** Immutable utility image used to re-prove service readiness from the runtime network. */
      readonly probeImageRef: string;
      /** Secret-free digest of the complete provider-owned container specification. */
      readonly specSha256: string;
      /**
       * Declarative model identity for runtimes that bind one verified local
       * artifact. Host paths and executor-only filesystem identity never enter
       * durable provider state.
       */
      readonly model?: HostLocalInferenceModelAuthority;
      readonly gpu:
        | { readonly vendor: "nvidia"; readonly devices: readonly string[] }
        | { readonly vendor: "nvidia"; readonly count: 1 };
    };

/**
 * Secret-free durable proof for one host-local inference route. The injected
 * provider owns command reconstruction; central consumers retain only this
 * normalized endpoint and runtime authority.
 */
export interface HostLocalInferenceReceipt {
  readonly schemaVersion: typeof HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION;
  readonly providerId: string;
  readonly service: HostLocalInferenceService;
  readonly engineAuthority: PersistedEngineAuthority;
  readonly endpoint: HostLocalInferenceEndpointAuthority;
  readonly runtime: HostLocalInferenceRuntimeAuthority;
}

export interface HostLocalManagedInferenceInspection {
  readonly running: boolean;
  readonly receipt: HostLocalInferenceReceipt;
}

export type HostLocalInferenceDestroyResult =
  | {
      readonly status: "retained";
      readonly reason: "host-process";
      readonly receipt: HostLocalInferenceReceipt;
    }
  | {
      readonly status: "removed" | "already-absent";
      readonly receipt: HostLocalInferenceReceipt;
    };

export interface HostLocalInferenceRouteAuthority {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly service: "ollama";
  readonly authorityId: string;
  /** Digest of the provider-owned route and probe authority, excluding secrets. */
  readonly receiptSha256: string;
}

/**
 * Provider-owned protected storage for host-process route identity. A runtime
 * must inject a durable implementation before production activation; tests
 * use a write-once memory implementation.
 */
export interface HostLocalInferenceRouteAuthorityStore {
  readonly load: (service: "ollama") => HostLocalInferenceRouteAuthority | null;
  readonly record: (
    authority: HostLocalInferenceRouteAuthority,
  ) => HostLocalInferenceRouteAuthority;
}

/**
 * Operation-scoped durable writer for one exact receipt target. Implementations
 * must atomically retain an absent target or the exact same canonical receipt,
 * reject a different current value, and return the committed canonical bytes.
 */
export interface HostLocalInferenceReceiptWriter {
  /** Exact create transaction this writer may publish. */
  readonly transactionId: string;
  /** Path- and value-free identity of the one external state target. */
  readonly targetSha256: string;
  readonly writeExact: (serializedReceipt: string) => string;
}

export interface HostLocalInferenceRecoveryResult {
  readonly recovered: readonly string[];
  readonly failures: readonly {
    readonly transactionId: string;
    readonly message: string;
  }[];
}

/**
 * Provider-neutral inputs for the existing managed llama.cpp lifecycle. Every
 * runtime, model, probe, and launch value is compiled from the selected YAML
 * recipe before this provider boundary is entered.
 */
export interface HostLocalLlamaCppLifecycleInput {
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly apiKeyRootHostPath: string;
  readonly bindingSha256: string;
  readonly bindings: LlamaCppHostLocalRuntimeBindings & { readonly hostPort: number };
  readonly cacheRootHostPath: string;
  readonly contract: LlamaCppHostLocalLaunchContract;
  readonly engine: ContainerEngine;
  readonly journalStore: HostLocalCreateJournalStore;
  readonly plan: LlamaCppGgufCachePlan;
  readonly probeImageReference: string;
  readonly readinessTimeoutSeconds: number;
}

export interface HostLocalLlamaCppLifecycle {
  readonly runtime: HostLocalInferenceRuntime;
  start(writer: HostLocalInferenceReceiptWriter): HostLocalInferenceReceipt;
  resume(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
  recoverUnfinished(writer: HostLocalInferenceReceiptWriter): HostLocalInferenceRecoveryResult;
}

export type HostLocalInferenceCommandSpawner = (
  args: readonly string[],
  options?: Parameters<typeof spawn>[2],
) => ReturnType<typeof spawn>;

export interface HostLocalInferenceOperationInput {
  readonly env: NodeJS.ProcessEnv;
}

/**
 * One provider-owned host-local-inference operation. The engine authority and
 * lifecycle factory are immutable for this invocation and never consult a
 * process-global runtime selector.
 */
export interface HostLocalInferenceOperation {
  readonly providerId: string;
  readonly engine: ContainerEngine;
  readonly bindingSha256: string;
  readonly assertAuthority: () => void;
  readonly spawn: HostLocalInferenceCommandSpawner;
  readonly createLlamaCppLifecycle: (
    input: HostLocalLlamaCppLifecycleInput,
  ) => HostLocalLlamaCppLifecycle;
}

export interface HostLocalInferenceRuntime {
  readonly providerId: string;
  /** Exact opaque endpoint identity shared with the operation-scoped engine. */
  readonly authorityId: string;
  readonly services: readonly HostLocalInferenceService[];
  translateContainerArgs(args: readonly string[]): readonly string[];
  qualifyOllama(input: HostLocalInferenceEndpointInput): HostLocalInferenceReceipt;
  startManaged(input: HostLocalManagedInferenceInput): HostLocalInferenceReceipt;
  inspectManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection;
  stopManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection;
  /**
   * Re-prove the same out-of-sandbox service before carrying it across a
   * lifecycle boundary. Every invocation must perform a fresh provider-native
   * identity inspection and network health probe; cached or receipt-only
   * validation does not satisfy this contract.
   */
  preserveForRebuild(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
  /** Prove exact ownership for teardown without requiring the service to be healthy. */
  prepareDestroy(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
  /**
   * Retire only the exact provider-owned runtime; host processes remain
   * externally owned. Managed cleanup must remain idempotent across retries and
   * revalidate exact runtime authority before each deletion so a retained
   * ownership journal can resume teardown after a process crash or provider
   * failure.
   */
  destroy(receipt: HostLocalInferenceReceipt): HostLocalInferenceDestroyResult;
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,511}$/u;
const OCI_DIGEST_REFERENCE =
  /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)*(?:[A-Za-z0-9._-]+)@sha256:[a-f0-9]{64}$/u;
const CDI_DEVICE = /^nvidia\.com\/gpu=[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RECIPE_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/u;
const SERVICES = new Set<HostLocalInferenceService>(["ollama", "nim", "vllm", "llama-cpp"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SERIALIZED_BYTES = 32 * 1024;

function fail(message: string): never {
  throw new Error(`Host-local inference receipt is invalid: ${message}`);
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail(`${label} schema is unsupported`);
  }
}

function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    !pattern.test(value)
  ) {
    fail(`${label} is malformed`);
  }
  return value;
}

function exactPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    fail(`${label} is malformed`);
  }
  return Number(value);
}

export function normalizeHostLocalInferenceImageRef(value: unknown): string {
  return exactText(value, OCI_DIGEST_REFERENCE, "runtime image reference");
}

function normalizeEndpoint(value: unknown): HostLocalInferenceEndpointAuthority {
  const endpoint = exactRecord(value, "endpoint authority");
  exactKeys(endpoint, ["host", "networkName", "port"], "endpoint authority");
  return Object.freeze({
    host: exactText(endpoint.host, SAFE_HOST, "endpoint host"),
    port: exactPort(endpoint.port, "endpoint port"),
    networkName: exactText(endpoint.networkName, SAFE_NAME, "endpoint network"),
  });
}

function normalizeRuntime(
  service: HostLocalInferenceService,
  value: unknown,
): HostLocalInferenceRuntimeAuthority {
  const runtime = exactRecord(value, "runtime authority");
  if (runtime.kind === "host") {
    exactKeys(runtime, ["kind", "probeImageRef"], "host runtime authority");
    if (service !== "ollama") fail("only Ollama may use host-process authority");
    return Object.freeze({
      kind: "host" as const,
      probeImageRef: normalizeHostLocalInferenceImageRef(runtime.probeImageRef),
    });
  }
  if (runtime.kind !== "container") fail("runtime kind is unsupported");
  exactKeys(
    runtime,
    service === "llama-cpp"
      ? ["gpu", "imageRef", "kind", "model", "name", "probeImageRef", "runtimeId", "specSha256"]
      : ["gpu", "imageRef", "kind", "name", "probeImageRef", "runtimeId", "specSha256"],
    "container authority",
  );
  if (service === "ollama") fail("Ollama must use host-process authority");
  const gpu = exactRecord(runtime.gpu, "GPU authority");
  exactKeys(
    gpu,
    service === "llama-cpp" ? ["count", "vendor"] : ["devices", "vendor"],
    "GPU authority",
  );
  if (gpu.vendor !== "nvidia") fail("GPU authority must identify NVIDIA devices");
  let normalizedGpu:
    | { readonly vendor: "nvidia"; readonly devices: readonly string[] }
    | { readonly vendor: "nvidia"; readonly count: 1 };
  if (service === "llama-cpp") {
    if (gpu.count !== 1) fail("llama.cpp GPU authority must identify exactly one GPU");
    normalizedGpu = Object.freeze({ vendor: "nvidia" as const, count: 1 as const });
  } else {
    if (!Array.isArray(gpu.devices) || gpu.devices.length === 0) {
      fail("GPU authority must identify NVIDIA devices");
    }
    const devices = gpu.devices.map((device) => exactText(device, CDI_DEVICE, "GPU device"));
    if (new Set(devices).size !== devices.length) fail("GPU devices must be unique");
    normalizedGpu = Object.freeze({
      vendor: "nvidia" as const,
      devices: Object.freeze(devices),
    });
  }
  let model: HostLocalInferenceModelAuthority | undefined;
  if (service === "llama-cpp") {
    const source = exactRecord(runtime.model, "model authority");
    exactKeys(
      source,
      ["digest", "generation", "planDigest", "recipeId", "sizeBytes"],
      "model authority",
    );
    if (!Number.isSafeInteger(source.sizeBytes) || Number(source.sizeBytes) < 1) {
      fail("model size is malformed");
    }
    model = Object.freeze({
      planDigest: exactText(source.planDigest, SHA256_DIGEST, "model plan digest"),
      recipeId: exactText(source.recipeId, RECIPE_ID, "model recipe identity"),
      generation: exactText(source.generation, SHA256, "model lifecycle generation"),
      digest: exactText(source.digest, SHA256_DIGEST, "model digest"),
      sizeBytes: Number(source.sizeBytes),
    });
  }
  return Object.freeze({
    kind: "container" as const,
    runtimeId: exactText(runtime.runtimeId, RUNTIME_ID, "runtime identity"),
    name: exactText(runtime.name, SAFE_NAME, "runtime name"),
    imageRef: normalizeHostLocalInferenceImageRef(runtime.imageRef),
    probeImageRef: normalizeHostLocalInferenceImageRef(runtime.probeImageRef),
    specSha256: exactText(runtime.specSha256, SHA256, "runtime specification digest"),
    ...(model ? { model } : {}),
    gpu: normalizedGpu,
  });
}

export function normalizeHostLocalInferenceReceipt(value: unknown): HostLocalInferenceReceipt {
  const receipt = exactRecord(value, "receipt");
  exactKeys(
    receipt,
    ["endpoint", "engineAuthority", "providerId", "runtime", "schemaVersion", "service"],
    "receipt",
  );
  if (receipt.schemaVersion !== HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION) {
    fail("schema version is unsupported");
  }
  if (
    typeof receipt.service !== "string" ||
    !SERVICES.has(receipt.service as HostLocalInferenceService)
  ) {
    fail("service is unsupported");
  }
  const service = receipt.service as HostLocalInferenceService;
  const engineAuthority = normalizePersistedEngineAuthority(receipt.engineAuthority);
  if (engineAuthority.operation !== "host-local-inference") {
    fail("engine authority has the wrong operation scope");
  }
  const providerId = exactText(receipt.providerId, PROVIDER_ID, "provider identity");
  if (engineAuthority.providerId !== providerId) {
    fail("provider identity does not match engine authority");
  }
  return Object.freeze({
    schemaVersion: HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION,
    providerId,
    service,
    engineAuthority,
    endpoint: normalizeEndpoint(receipt.endpoint),
    runtime: normalizeRuntime(service, receipt.runtime),
  });
}

export function serializeHostLocalInferenceReceipt(receipt: HostLocalInferenceReceipt): string {
  const serialized = `${JSON.stringify(normalizeHostLocalInferenceReceipt(receipt))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) {
    fail("serialized receipt exceeds its bounded transport");
  }
  return serialized;
}

export function parseHostLocalInferenceReceipt(serialized: string): HostLocalInferenceReceipt {
  if (
    serialized.length === 0 ||
    serialized.includes("\0") ||
    Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES
  ) {
    fail("serialized receipt is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("serialized receipt is not valid JSON");
  }
  const receipt = normalizeHostLocalInferenceReceipt(parsed);
  if (serializeHostLocalInferenceReceipt(receipt) !== serialized) {
    fail("serialized receipt is not canonical");
  }
  return receipt;
}
