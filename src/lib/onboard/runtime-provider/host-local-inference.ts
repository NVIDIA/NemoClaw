// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { spawn } from "node:child_process";
import { isIPv4 } from "node:net";

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
export const HOST_LOCAL_INFERENCE_PROOF_RECEIPT_SCHEMA_VERSION = 2 as const;
/** Exact sandbox-side host alias committed into the OpenShell gateway route. */
export const HOST_LOCAL_INFERENCE_SANDBOX_HOST = "host.openshell.internal" as const;

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
  /** Full immutable provider-network identity; names alone are not authority. */
  readonly networkId: string;
  /** Exact bridge gateway listener used by provider-network probes. */
  readonly networkGatewayIp: string;
  /** Optional qualified host listener when it differs from the bridge IPAM gateway. */
  readonly networkListenerIp?: string;
  readonly hostPort: number;
  readonly probeImageRef: string;
  /** Secret-free provider-native model identity used for a real inference proof. */
  readonly model: string;
  /** Require the selected model to return an OpenAI-compatible tool call. */
  readonly requireToolCalling: boolean;
}

/** Exact provider-neutral compute authority for one host-owned Ollama model. */
export type HostLocalOllamaAccelerationAuthority = "cpu" | "nvidia-gpu";

export interface HostLocalOllamaInferenceInput extends HostLocalInferenceEndpointInput {
  readonly acceleration: HostLocalOllamaAccelerationAuthority;
}

export interface HostLocalInferenceMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface HostLocalManagedInferenceInput extends HostLocalInferenceEndpointInput {
  readonly service: "ollama" | "nim" | "vllm";
  readonly containerName: string;
  readonly containerPort: number;
  readonly imageRef: string;
  readonly gpuDevices: readonly string[];
  /** Environment variable names forwarded from the current process; values are never persisted. */
  readonly environment?: readonly string[];
  /** Exact non-secret Ollama daemon context window persisted as managed runtime authority. */
  readonly ollamaContextLength?: number;
  readonly mounts?: readonly HostLocalInferenceMount[];
  readonly sharedMemory?: string;
  readonly ipc?: "host" | "private";
  readonly command?: readonly string[];
}

export interface HostLocalInferenceLegacyEndpointAuthority {
  readonly host: string;
  readonly port: number;
  readonly networkName: string;
}

export interface HostLocalInferenceProofEndpointAuthority extends HostLocalInferenceLegacyEndpointAuthority {
  readonly networkId: string;
  readonly networkGatewayIp: string;
  /** Qualified host listener used by Portable sandboxes and provider probes. */
  readonly networkListenerIp?: string;
  /** Digest of the exact inspected bridge configuration and ownership labels. */
  readonly networkAuthoritySha256: string;
}

export type HostLocalInferenceEndpointAuthority =
  | HostLocalInferenceLegacyEndpointAuthority
  | HostLocalInferenceProofEndpointAuthority;

export interface HostLocalInferenceProofAuthority {
  readonly protocol: "openai-chat-completions";
  readonly model: string;
  readonly toolCallingRequired: boolean;
}

export interface HostLocalInferencePublicationAuthority {
  readonly transactionId: string;
  readonly targetSha256: string;
  readonly priorState: HostLocalInferencePriorRuntimeState;
}

export type HostLocalInferenceRuntimeAuthority =
  | {
      readonly kind: "host";
      /** Immutable utility image used to prove endpoint reachability from the runtime network. */
      readonly probeImageRef: string;
      /** Exact compute authority proved for the selected Ollama model. */
      readonly acceleration: HostLocalOllamaAccelerationAuthority;
      /** Immutable provider-native identity of the exact running Ollama model. */
      readonly modelDigest: string;
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
      /** Digest of the exact provider-translated create argv recorded by the engine. */
      readonly launchSha256?: string;
      /** Provider-native digest of the exact model placed inside managed Ollama. */
      readonly modelDigest?: string;
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
  readonly schemaVersion:
    | typeof HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION
    | typeof HOST_LOCAL_INFERENCE_PROOF_RECEIPT_SCHEMA_VERSION;
  readonly providerId: string;
  readonly service: HostLocalInferenceService;
  readonly engineAuthority: PersistedEngineAuthority;
  readonly endpoint: HostLocalInferenceEndpointAuthority;
  readonly runtime: HostLocalInferenceRuntimeAuthority;
  /** Present for routes that require a provider-owned real inference proof. */
  readonly inference?: HostLocalInferenceProofAuthority;
  /** Present for routes published through an operation-scoped exact writer. */
  readonly publication?: HostLocalInferencePublicationAuthority;
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

export type HostLocalInferencePriorRuntimeState = "absent" | "running" | "stopped" | "host-process";

export interface HostLocalInferenceStartupRollbackResult {
  readonly status: "removed" | "restored" | "retained";
  readonly priorState: HostLocalInferencePriorRuntimeState;
  readonly receipt: HostLocalInferenceReceipt;
}

export function hostLocalInferenceRollbackStatus(
  priorState: HostLocalInferencePriorRuntimeState,
): HostLocalInferenceStartupRollbackResult["status"] {
  if (priorState === "absent") return "removed";
  if (priorState === "host-process") return "retained";
  return "restored";
}

export type HostLocalInferencePublicationState = "unpublished" | "indeterminate" | "published";

/**
 * Operation-scoped startup transaction. Central routing validates the
 * provider before its own route mutation, then commits the receipt or restores
 * the exact prior runtime.
 *
 * The experimental published-resume path may return after starting the exact
 * receipt-owned runtime but before its Ready and GPU proofs. That interval is
 * deliberately unpublished and rollback-safe: the caller must validate then
 * finalize, or roll back. If the caller is interrupted, the next recovery
 * reconciles the same exact running receipt-owned runtime before publication.
 */
export interface HostLocalInferencePreparedStartup {
  readonly receipt: HostLocalInferenceReceipt;
  /** Exact runtime state at entry to this preparation transaction. */
  readonly rollbackPriorState: HostLocalInferencePriorRuntimeState;
  /** Durable publication state used to decide whether exact rollback is still safe. */
  publicationState(): HostLocalInferencePublicationState;
  /**
   * Revalidate the prepared runtime while rollback is still safe. Published
   * recovery may defer semantic provider health to its caller's exact managed
   * route proof; creation and ordinary recovery retain full provider-native
   * validation.
   */
  validateBeforeCommit(): HostLocalInferenceReceipt;
  /** Cross only the external publication boundary after validation succeeds. */
  commit(): HostLocalInferenceReceipt;
  /**
   * Finalize an exact published-runtime resume without writing the already
   * published receipt again. The provider keeps rollback available until the
   * caller's final published-authority assertion succeeds.
   */
  finalizePublishedResume?(assertPublishedAuthority: () => void): HostLocalInferenceReceipt;
  rollback(): HostLocalInferenceStartupRollbackResult;
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
  /** Accepted request scope when constructing a managed local-inference operation. */
  readonly acceleration?: HostLocalOllamaAccelerationAuthority;
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
  /** Recheck the pinned executable and endpoint without repeating full provider qualification. */
  readonly assertTransactionCurrent?: () => void;
  readonly assertAuthority: () => void;
  readonly spawn: HostLocalInferenceCommandSpawner;
  readonly createLlamaCppLifecycle: (
    input: HostLocalLlamaCppLifecycleInput,
  ) => HostLocalLlamaCppLifecycle;
  /** Provider-owned Ollama, NIM, and vLLM lifecycle for this exact operation. */
  readonly managedRuntime?: HostLocalInferenceRuntime;
}

export interface HostLocalInferenceRuntime {
  readonly providerId: string;
  /** Exact opaque endpoint identity shared with the operation-scoped engine. */
  readonly authorityId: string;
  readonly services: readonly HostLocalInferenceService[];
  translateContainerArgs(args: readonly string[]): readonly string[];
  qualifyOllama(
    input: HostLocalOllamaInferenceInput,
    writer: HostLocalInferenceReceiptWriter,
  ): HostLocalInferencePreparedStartup;
  startManaged(
    input: HostLocalManagedInferenceInput,
    writer: HostLocalInferenceReceiptWriter,
  ): HostLocalInferencePreparedStartup;
  /** Resume an exact interrupted managed start without creating another runtime. */
  recoverManaged?(
    input: HostLocalManagedInferenceInput,
    writer: HostLocalInferenceReceiptWriter,
  ): HostLocalInferencePreparedStartup;
  /** Re-prove a durably published runtime, restoring its state-at-entry on rollback. */
  resumeManaged?(
    input: HostLocalManagedInferenceInput,
    receipt: HostLocalInferenceReceipt,
    writer: HostLocalInferenceReceiptWriter,
  ): HostLocalInferencePreparedStartup;
  /** Reinspect a failed published resume using only exact rollback-safe authority. */
  inspectPublishedRecoveryRestoration?(
    receipt: HostLocalInferenceReceipt,
  ): HostLocalManagedInferenceInspection;
  /** Reinspect one published recovery through its retained transaction authority. */
  inspectPublishedRecoveryCurrent?(
    receipt: HostLocalInferenceReceipt,
  ): HostLocalManagedInferenceInspection;
  /**
   * Admit one exact published runtime for connect recovery through the
   * operation authority already qualified by the lifecycle owner. This path
   * returns a detached transaction snapshot and never creates a second
   * operation or falls back to generic destroy authority.
   */
  preparePublishedRecoveryEntry?(
    receipt: HostLocalInferenceReceipt,
  ): HostLocalManagedInferenceInspection;
  /**
   * Re-prove exact published-runtime authority and GPU identity before the
   * caller performs its final managed route health proof. This path never
   * replaces creation-time or explicit deep inference qualification.
   */
  validatePublishedResume?(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
  inspectManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection;
  stopManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection;
  /**
   * Re-prove the same out-of-sandbox service before carrying it across a
   * lifecycle boundary. Every invocation must perform a fresh provider-native
   * identity inspection and network health probe; cached or receipt-only
   * validation does not satisfy this contract.
   */
  preserveForRebuild(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
  /** Re-prove provider authority, runtime identity, readiness, GPU use, and inference. */
  validate?(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt;
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
const INFERENCE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/u;
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

/** Canonicalize Ollama's implicit latest tag without treating registry ports as tags. */
export function normalizeHostLocalOllamaModelRef(value: unknown): string {
  const model = exactText(value, INFERENCE_MODEL, "Ollama model");
  const lastSegment = model.slice(model.lastIndexOf("/") + 1);
  // Digest references are not admitted by INFERENCE_MODEL. Keep this guard so
  // a future grammar expansion cannot accidentally append a mutable tag.
  if (model.includes("@") || lastSegment.includes(":")) return model;
  return `${model}:latest`;
}

function exactIpv4(value: unknown, label: string): string {
  const address = exactText(value, /\S+/u, label);
  if (!isIPv4(address)) fail(`${label} is malformed`);
  return address;
}

function normalizeEndpoint(
  value: unknown,
  proofReceipt: boolean,
): HostLocalInferenceEndpointAuthority {
  const endpoint = exactRecord(value, "endpoint authority");
  exactKeys(
    endpoint,
    proofReceipt
      ? "networkListenerIp" in endpoint
        ? [
            "host",
            "networkAuthoritySha256",
            "networkGatewayIp",
            "networkId",
            "networkListenerIp",
            "networkName",
            "port",
          ]
        : ["host", "networkAuthoritySha256", "networkGatewayIp", "networkId", "networkName", "port"]
      : ["host", "networkName", "port"],
    "endpoint authority",
  );
  const common = {
    host: exactText(endpoint.host, SAFE_HOST, "endpoint host"),
    port: exactPort(endpoint.port, "endpoint port"),
    networkName: exactText(endpoint.networkName, SAFE_NAME, "endpoint network"),
  };
  if (!proofReceipt) return Object.freeze(common);
  return Object.freeze({
    ...common,
    networkId: exactText(endpoint.networkId, SHA256, "endpoint network identity"),
    networkGatewayIp: exactIpv4(endpoint.networkGatewayIp, "endpoint network gateway"),
    ...("networkListenerIp" in endpoint
      ? { networkListenerIp: exactIpv4(endpoint.networkListenerIp, "endpoint network listener") }
      : {}),
    networkAuthoritySha256: exactText(
      endpoint.networkAuthoritySha256,
      SHA256,
      "endpoint network authority",
    ),
  });
}

function normalizeInferenceProof(value: unknown): HostLocalInferenceProofAuthority {
  const inference = exactRecord(value, "inference proof authority");
  exactKeys(inference, ["model", "protocol", "toolCallingRequired"], "inference proof authority");
  const expectedProtocol = "openai-chat-completions" as const;
  if (inference.protocol !== expectedProtocol) {
    fail("inference proof protocol is unsupported");
  }
  if (typeof inference.toolCallingRequired !== "boolean") {
    fail("inference proof tool-calling requirement is malformed");
  }
  return Object.freeze({
    protocol: expectedProtocol,
    model: exactText(inference.model, INFERENCE_MODEL, "inference model"),
    toolCallingRequired: inference.toolCallingRequired,
  });
}

function normalizePublicationAuthority(value: unknown): HostLocalInferencePublicationAuthority {
  const publication = exactRecord(value, "receipt publication authority");
  exactKeys(
    publication,
    ["priorState", "targetSha256", "transactionId"],
    "receipt publication authority",
  );
  if (
    publication.priorState !== "absent" &&
    publication.priorState !== "running" &&
    publication.priorState !== "stopped" &&
    publication.priorState !== "host-process"
  ) {
    fail("receipt publication prior state is malformed");
  }
  return Object.freeze({
    transactionId: exactText(publication.transactionId, SHA256, "receipt publication transaction"),
    targetSha256: exactText(publication.targetSha256, SHA256, "receipt publication target"),
    priorState: publication.priorState,
  });
}

function normalizeRuntime(
  service: HostLocalInferenceService,
  value: unknown,
  proofReceipt: boolean,
): HostLocalInferenceRuntimeAuthority {
  const runtime = exactRecord(value, "runtime authority");
  if (runtime.kind === "host") {
    exactKeys(
      runtime,
      ["acceleration", "kind", "modelDigest", "probeImageRef"],
      "host runtime authority",
    );
    if (service !== "ollama") fail("only Ollama may use host-process authority");
    if (runtime.acceleration !== "cpu" && runtime.acceleration !== "nvidia-gpu") {
      fail("Ollama acceleration authority is malformed");
    }
    return Object.freeze({
      kind: "host" as const,
      probeImageRef: normalizeHostLocalInferenceImageRef(runtime.probeImageRef),
      acceleration: runtime.acceleration,
      modelDigest: exactText(runtime.modelDigest, SHA256_DIGEST, "Ollama model digest"),
    });
  }
  if (runtime.kind !== "container") fail("runtime kind is unsupported");
  exactKeys(
    runtime,
    service === "llama-cpp"
      ? ["gpu", "imageRef", "kind", "model", "name", "probeImageRef", "runtimeId", "specSha256"]
      : service === "ollama"
        ? [
            "gpu",
            "imageRef",
            "kind",
            "launchSha256",
            "modelDigest",
            "name",
            "probeImageRef",
            "runtimeId",
            "specSha256",
          ]
        : proofReceipt
          ? [
              "gpu",
              "imageRef",
              "kind",
              "launchSha256",
              "name",
              "probeImageRef",
              "runtimeId",
              "specSha256",
            ]
          : ["gpu", "imageRef", "kind", "name", "probeImageRef", "runtimeId", "specSha256"],
    "container authority",
  );
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
    ...(!proofReceipt || service === "llama-cpp"
      ? {}
      : {
          launchSha256: exactText(
            runtime.launchSha256,
            SHA256,
            "runtime launch specification digest",
          ),
        }),
    ...(model ? { model } : {}),
    ...(service === "ollama"
      ? { modelDigest: exactText(runtime.modelDigest, SHA256_DIGEST, "Ollama model digest") }
      : {}),
    gpu: normalizedGpu,
  });
}

export function normalizeHostLocalInferenceReceipt(value: unknown): HostLocalInferenceReceipt {
  const receipt = exactRecord(value, "receipt");
  if (
    receipt.schemaVersion !== HOST_LOCAL_INFERENCE_RECEIPT_SCHEMA_VERSION &&
    receipt.schemaVersion !== HOST_LOCAL_INFERENCE_PROOF_RECEIPT_SCHEMA_VERSION
  ) {
    fail("schema version is unsupported");
  }
  if (
    typeof receipt.service !== "string" ||
    !SERVICES.has(receipt.service as HostLocalInferenceService)
  ) {
    fail("service is unsupported");
  }
  const service = receipt.service as HostLocalInferenceService;
  const proofReceipt = receipt.schemaVersion === HOST_LOCAL_INFERENCE_PROOF_RECEIPT_SCHEMA_VERSION;
  if (!proofReceipt && service !== "llama-cpp") {
    fail("legacy receipt schema supports only llama.cpp");
  }
  if (proofReceipt && service === "llama-cpp") {
    fail("proof receipt schema does not support llama.cpp");
  }
  exactKeys(
    receipt,
    !proofReceipt
      ? ["endpoint", "engineAuthority", "providerId", "runtime", "schemaVersion", "service"]
      : [
          "endpoint",
          "engineAuthority",
          "inference",
          "publication",
          "providerId",
          "runtime",
          "schemaVersion",
          "service",
        ],
    "receipt",
  );
  const engineAuthority = normalizePersistedEngineAuthority(receipt.engineAuthority);
  if (engineAuthority.operation !== "host-local-inference") {
    fail("engine authority has the wrong operation scope");
  }
  const providerId = exactText(receipt.providerId, PROVIDER_ID, "provider identity");
  if (engineAuthority.providerId !== providerId) {
    fail("provider identity does not match engine authority");
  }
  const publication = proofReceipt ? normalizePublicationAuthority(receipt.publication) : undefined;
  const runtime = normalizeRuntime(service, receipt.runtime, proofReceipt);
  if (
    publication !== undefined &&
    ((service === "ollama" &&
      runtime.kind === "host" &&
      publication.priorState !== "host-process") ||
      (runtime.kind === "container" && publication.priorState === "host-process"))
  ) {
    fail("receipt publication prior state does not match the service lifecycle");
  }
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    providerId,
    service,
    engineAuthority,
    endpoint: normalizeEndpoint(receipt.endpoint, proofReceipt),
    runtime,
    ...(!proofReceipt
      ? {}
      : {
          inference: normalizeInferenceProof(receipt.inference),
          publication,
        }),
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
