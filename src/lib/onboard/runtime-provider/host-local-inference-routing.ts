// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "./contract";
import type { ManagedLlamaCppLifecycleAdapter } from "../../inference/llama-cpp/managed-lifecycle-adapter";
import {
  HOST_LOCAL_INFERENCE_SANDBOX_HOST,
  type HostLocalInferenceOperation,
  type HostLocalInferencePreparedStartup,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceReceiptWriter,
  type HostLocalInferenceRuntime,
  type HostLocalManagedInferenceInput,
  type HostLocalOllamaAccelerationAuthority,
  type HostLocalOllamaInferenceInput,
  hostLocalInferenceRollbackStatus,
  normalizeHostLocalInferenceImageRef,
  normalizeHostLocalInferenceReceipt,
  normalizeHostLocalOllamaModelRef,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";

export const HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL = "https://inference.local/v1" as const;

export const HOST_LOCAL_INFERENCE_APPLICATIONS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export type HostLocalInferenceApplication = (typeof HOST_LOCAL_INFERENCE_APPLICATIONS)[number];

export function hostLocalInferenceOperationEnvironment(
  service: "ollama" | "nim" | "vllm" | "llama-cpp",
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const operationEnv = Object.create(null) as NodeJS.ProcessEnv;
  if (service !== "nim") return operationEnv;
  for (const name of ["NGC_API_KEY", "NIM_NGC_API_KEY"] as const) {
    const value = source[name];
    if (typeof value === "string") operationEnv[name] = value;
  }
  return operationEnv;
}

export interface HostLocalInferenceGatewayMutationInput {
  readonly gatewayName: string;
  readonly sandboxName: string;
  readonly provider: "ollama-local" | "vllm-local" | "llama-cpp-local";
  readonly model: string;
  readonly providerBaseUrl: string;
}

/**
 * Injected exact-state transaction for the OpenShell gateway mutation. The
 * owner captures the prior provider and inference selection before returning.
 */
export interface HostLocalInferenceGatewayMutation {
  /** Exact provider mutation owned by a product transaction when supplied. */
  upsertProvider?: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string,
    env?: NodeJS.ProcessEnv,
  ) => { ok: boolean; message?: string; status?: number };
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export type HostLocalInferenceStartupRequest =
  | {
      readonly application: HostLocalInferenceApplication;
      readonly service: "ollama";
      readonly endpoint: HostLocalOllamaInferenceInput;
      readonly receiptWriter: HostLocalInferenceReceiptWriter;
    }
  | {
      readonly application: HostLocalInferenceApplication;
      readonly service: "ollama";
      readonly managed: HostLocalManagedInferenceInput;
      /** Exact durable receipt for a previously published canonical route. */
      readonly resumeReceipt?: HostLocalInferenceReceipt;
      /** Recover only an interrupted, not-yet-published same-transaction start. */
      readonly recover?: boolean;
      readonly receiptWriter: HostLocalInferenceReceiptWriter;
    }
  | {
      readonly application: HostLocalInferenceApplication;
      readonly service: "nim" | "vllm";
      readonly managed: HostLocalManagedInferenceInput;
      /** Exact durable receipt for a previously published canonical route. */
      readonly resumeReceipt?: HostLocalInferenceReceipt;
      /** Recover only an interrupted, not-yet-published same-transaction start. */
      readonly recover?: boolean;
      readonly receiptWriter: HostLocalInferenceReceiptWriter;
    }
  | {
      readonly application: HostLocalInferenceApplication;
      readonly service: "llama-cpp";
      /** Rehydrated only by the hidden operation-scoped lifecycle resolver. */
      readonly adapter: ManagedLlamaCppLifecycleAdapter;
      /** Accepted sandbox proof requirement; schema-v1 receipts intentionally omit it. */
      readonly requireToolCalling: boolean;
      /** True only when the registry route was already durably published. */
      readonly publishedRoute: boolean;
    };

/** Operation-scoped selection injected by the qualification caller. */
export interface HostLocalInferenceStartupSelection {
  /** Exact runtime-provider identity expected from the sandbox-bound resolver. */
  readonly runtimeProviderId: string;
  readonly request: HostLocalInferenceStartupRequest;
  readonly resolveRuntimeProvider: (sandboxName: string) => RuntimeProviderBundle | null;
  readonly prepareGatewayMutation: (
    input: HostLocalInferenceGatewayMutationInput,
  ) => HostLocalInferenceGatewayMutation | Promise<HostLocalInferenceGatewayMutation>;
}

export interface HostLocalInferenceStartupSelectionInput {
  readonly application: HostLocalInferenceApplication;
  readonly sandboxName: string;
  readonly provider: string;
  readonly model: string;
  /** Compute mode accepted from the operation's preflighted host GPU selection. */
  readonly acceleration: HostLocalOllamaAccelerationAuthority;
  /** Null on exact recovery: the resolver must derive this from durable provider authority. */
  readonly requireToolCalling: boolean | null;
  /** True only when an accepted existing session may consume injected exact recovery authority. */
  readonly allowPublishedResume: boolean;
  /** True only for a route already recorded as the canonical published route. */
  readonly recover: boolean;
}

export type HostLocalInferenceStartupSelectionResolver = (
  input: HostLocalInferenceStartupSelectionInput,
) => HostLocalInferenceStartupSelection | null;

export interface HostLocalInferenceSandboxProofAuthority {
  readonly service: "ollama" | "nim" | "vllm" | "llama-cpp";
  readonly directHostPort: number;
  readonly directHealthPath: "/api/tags" | "/v1/health/ready" | "/health";
  readonly toolCallingRequired: boolean;
}

function isHostOllamaRequest(
  request: HostLocalInferenceStartupRequest,
): request is Extract<HostLocalInferenceStartupRequest, { readonly endpoint: unknown }> {
  return request.service === "ollama" && "endpoint" in request;
}

export function hostLocalInferenceSandboxProofAuthority(
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceSandboxProofAuthority {
  const input = isHostOllamaRequest(request)
    ? request.endpoint
    : request.service === "llama-cpp"
      ? null
      : request.managed;
  const directHealthPath =
    request.service === "ollama"
      ? "/api/tags"
      : request.service === "nim"
        ? "/v1/health/ready"
        : "/health";
  return Object.freeze({
    service: request.service,
    directHostPort:
      request.service === "llama-cpp" ? request.adapter.receipt.endpoint.port : input!.hostPort,
    directHealthPath,
    toolCallingRequired:
      request.service === "llama-cpp" ? request.requireToolCalling : input!.requireToolCalling,
  });
}

export function hostLocalInferenceRequestModel(request: HostLocalInferenceStartupRequest): string {
  if (isHostOllamaRequest(request)) return normalizeHostLocalOllamaModelRef(request.endpoint.model);
  return request.service === "llama-cpp" ? request.adapter.model : request.managed.model;
}

export function hostLocalInferenceRequestToolCalling(
  request: HostLocalInferenceStartupRequest,
): boolean {
  if (isHostOllamaRequest(request)) return request.endpoint.requireToolCalling;
  return request.service === "llama-cpp"
    ? request.requireToolCalling
    : request.managed.requireToolCalling;
}

export function hostLocalInferenceRuntimeOwnerSandboxName(
  request: HostLocalInferenceStartupRequest,
  sandboxName: string,
): string {
  return request.service === "llama-cpp" ? request.adapter.runtimeOwnerSandboxName : sandboxName;
}

export function hostLocalInferenceGatewayPort(
  request: HostLocalInferenceStartupRequest,
): number | undefined {
  return request.service === "llama-cpp" ? request.adapter.gatewayPort : undefined;
}

export function hostLocalInferenceGatewayProvider(
  request: HostLocalInferenceStartupRequest,
): "ollama-local" | "vllm-local" | "llama-cpp-local" {
  if (request.service === "ollama") return "ollama-local";
  return request.service === "llama-cpp" ? "llama-cpp-local" : "vllm-local";
}

export interface HostLocalInferenceStartupRoute {
  readonly prepared: HostLocalInferencePreparedStartup;
  readonly receipt: HostLocalInferenceReceipt;
  readonly gatewayProvider: "ollama-local" | "vllm-local" | "llama-cpp-local";
  /** Provider registration target visible inside the OpenShell gateway. */
  readonly gatewayProviderBaseUrl: string;
  /** Stable inference route shared by OpenClaw, Hermes, and Deep Agents Code. */
  readonly applicationBaseUrl: typeof HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL;
}

function requireApplication(application: unknown): HostLocalInferenceApplication {
  if (
    typeof application !== "string" ||
    !HOST_LOCAL_INFERENCE_APPLICATIONS.includes(application as HostLocalInferenceApplication)
  ) {
    throw new Error(`Unsupported host-local inference application '${String(application)}'.`);
  }
  return application as HostLocalInferenceApplication;
}

function normalizeStartupReceipt(
  operation: HostLocalInferenceOperation,
  runtime: HostLocalInferenceRuntime,
  request: HostLocalInferenceStartupRequest,
  receipt: HostLocalInferenceReceipt,
  authorityMode: "current" | "published-recovery" = "current",
): HostLocalInferenceReceipt {
  const normalized = normalizeHostLocalInferenceReceipt(receipt);
  if (request.service === "llama-cpp") {
    if (
      normalized.schemaVersion !== 1 ||
      normalized.service !== "llama-cpp" ||
      normalized.providerId !== operation.providerId ||
      normalized.providerId !== runtime.providerId ||
      normalized.engineAuthority.providerId !== operation.providerId ||
      normalized.engineAuthority.engineId !== operation.engine.engineId ||
      normalized.engineAuthority.authorityId !== operation.engine.authorityId ||
      normalized.engineAuthority.authorityId !== runtime.authorityId ||
      normalized.engineAuthority.bindingSha256 !== operation.bindingSha256 ||
      serializeHostLocalInferenceReceipt(normalized) !==
        serializeHostLocalInferenceReceipt(request.adapter.receipt)
    ) {
      throw new Error(
        "Host-local llama.cpp startup returned a different runtime or receipt authority.",
      );
    }
    return normalized;
  }
  const model = isHostOllamaRequest(request)
    ? normalizeHostLocalOllamaModelRef(request.endpoint.model)
    : request.managed.model;
  const toolCallingRequired = isHostOllamaRequest(request)
    ? request.endpoint.requireToolCalling
    : request.managed.requireToolCalling;
  const protocol = "openai-chat-completions";
  const { inference, publication } = normalized;
  const requestInput = isHostOllamaRequest(request) ? request.endpoint : request.managed;
  const expectedProbeImageRef = normalizeHostLocalInferenceImageRef(requestInput.probeImageRef);
  const endpointMatches =
    "networkId" in normalized.endpoint &&
    normalized.endpoint.host === HOST_LOCAL_INFERENCE_SANDBOX_HOST &&
    normalized.endpoint.port === requestInput.hostPort &&
    normalized.endpoint.networkName === requestInput.networkName &&
    normalized.endpoint.networkId === requestInput.networkId &&
    normalized.endpoint.networkGatewayIp === requestInput.networkGatewayIp &&
    normalized.endpoint.networkListenerIp === requestInput.networkListenerIp;
  const runtimeMatches = isHostOllamaRequest(request)
    ? normalized.runtime.kind === "host" &&
      normalized.runtime.probeImageRef === expectedProbeImageRef &&
      normalized.runtime.acceleration === request.endpoint.acceleration
    : normalized.runtime.kind === "container" &&
      normalized.runtime.name === request.managed.containerName &&
      normalized.runtime.imageRef ===
        normalizeHostLocalInferenceImageRef(request.managed.imageRef) &&
      normalized.runtime.probeImageRef === expectedProbeImageRef &&
      "devices" in normalized.runtime.gpu &&
      canonicalGpuDevices(normalized.runtime.gpu.devices) ===
        canonicalGpuDevices(request.managed.gpuDevices);
  const currentEngineMatchesReceipt =
    normalized.engineAuthority.authorityId === operation.engine.authorityId &&
    normalized.engineAuthority.authorityId === runtime.authorityId &&
    normalized.engineAuthority.bindingSha256 === operation.bindingSha256;
  if (
    normalized.providerId !== operation.providerId ||
    normalized.providerId !== runtime.providerId ||
    normalized.engineAuthority.providerId !== operation.providerId ||
    normalized.engineAuthority.operation !== "host-local-inference" ||
    normalized.engineAuthority.engineId !== operation.engine.engineId ||
    (authorityMode === "current" && !currentEngineMatchesReceipt) ||
    normalized.service !== request.service ||
    !endpointMatches ||
    !runtimeMatches ||
    inference?.protocol !== protocol ||
    inference?.model !== model ||
    inference?.toolCallingRequired !== toolCallingRequired ||
    publication?.transactionId !== request.receiptWriter.transactionId ||
    publication?.targetSha256 !== request.receiptWriter.targetSha256
  ) {
    throw new Error(
      "Host-local inference startup returned a different runtime, proof, or publication authority.",
    );
  }
  return normalized;
}

function canonicalGpuDevices(devices: readonly string[]): string {
  const canonical = devices.map((device) =>
    device.startsWith("nvidia.com/gpu=") ? device : `nvidia.com/gpu=${device}`,
  );
  return canonical.sort().join("\n");
}

function rollbackRejectedStartup(prepared: HostLocalInferencePreparedStartup): void {
  let publicationState: ReturnType<HostLocalInferencePreparedStartup["publicationState"]>;
  try {
    publicationState = prepared.publicationState();
  } catch {
    throw new Error("Rejected host-local inference startup publication state is indeterminate.");
  }
  if (publicationState !== "unpublished") {
    throw new Error("Rejected host-local inference startup publication state is indeterminate.");
  }
  let rejected: HostLocalInferenceReceipt;
  try {
    rejected = normalizeHostLocalInferenceReceipt(prepared.receipt);
  } catch {
    prepared.rollback();
    throw new Error("Rejected host-local inference startup receipt authority is malformed.");
  }
  const result = prepared.rollback();
  const rolledBack = normalizeHostLocalInferenceReceipt(result.receipt);
  const priorState = prepared.rollbackPriorState;
  const expectedStatus = hostLocalInferenceRollbackStatus(priorState);
  if (
    result.priorState !== priorState ||
    result.status !== expectedStatus ||
    serializeHostLocalInferenceReceipt(rolledBack) !== serializeHostLocalInferenceReceipt(rejected)
  ) {
    throw new Error(
      "Rejected host-local inference startup returned indeterminate rollback evidence.",
    );
  }
}

function providerBaseUrl(receipt: HostLocalInferenceReceipt): string {
  return `http://${receipt.endpoint.host}:${String(receipt.endpoint.port)}/v1`;
}

function prepareHostLocalInferenceStartupWithAuthority(
  operation: HostLocalInferenceOperation,
  request: HostLocalInferenceStartupRequest,
  authorityMode: "current" | "published-recovery",
): HostLocalInferenceStartupRoute {
  requireApplication(request.application);
  operation.assertAuthority();
  const runtime: HostLocalInferenceRuntime | undefined =
    request.service === "llama-cpp" ? request.adapter.runtime : operation.managedRuntime;
  if (!runtime) {
    throw new Error(
      `Runtime provider '${operation.providerId}' does not provide managed host-local inference.`,
    );
  }
  if (
    runtime.providerId !== operation.providerId ||
    runtime.authorityId !== operation.engine.authorityId
  ) {
    throw new Error("Host-local inference operation returned a different runtime authority.");
  }
  if (!runtime.services.includes(request.service)) {
    throw new Error(
      `Runtime provider '${runtime.providerId}' does not support host-local ${request.service}.`,
    );
  }
  let prepared: HostLocalInferencePreparedStartup;
  if (request.service === "llama-cpp") {
    if (request.publishedRoute !== true && request.publishedRoute !== false) {
      throw new Error("Managed llama.cpp route publication authority is invalid.");
    }
    prepared = request.adapter.prepareStartup();
  } else if (isHostOllamaRequest(request)) {
    prepared = runtime.qualifyOllama(request.endpoint, request.receiptWriter);
  } else {
    if (request.managed.service !== request.service) {
      throw new Error("Managed host-local inference service identity is inconsistent.");
    }
    if (request.service === "vllm" && (request.managed.environment?.length ?? 0) > 0) {
      throw new Error(
        "Authenticated managed vLLM is unsupported without a gateway credential handoff.",
      );
    }
    if (request.recover !== undefined && typeof request.recover !== "boolean") {
      throw new Error("Managed host-local inference recovery authority is invalid.");
    }
    if (request.recover === true && request.resumeReceipt !== undefined) {
      throw new Error("Managed host-local inference cannot mix recovery and published resume.");
    }
    if (request.resumeReceipt !== undefined) {
      if (!runtime.resumeManaged) {
        throw new Error(
          `Runtime provider '${runtime.providerId}' does not support published managed inference resume.`,
        );
      }
      prepared = runtime.resumeManaged(
        request.managed,
        request.resumeReceipt,
        request.receiptWriter,
      );
    } else if (request.recover) {
      if (!runtime.recoverManaged) {
        throw new Error(
          `Runtime provider '${runtime.providerId}' does not support managed inference recovery.`,
        );
      }
      prepared = runtime.recoverManaged(request.managed, request.receiptWriter);
    } else {
      prepared = runtime.startManaged(request.managed, request.receiptWriter);
    }
  }
  let receipt: HostLocalInferenceReceipt;
  try {
    receipt = normalizeStartupReceipt(operation, runtime, request, prepared.receipt, authorityMode);
  } catch (error) {
    try {
      rollbackRejectedStartup(prepared);
    } catch {
      throw new Error(
        "Rejected host-local inference startup could not prove exact prior-runtime restoration.",
      );
    }
    throw error;
  }
  const managedPublishedResume =
    request.service !== "llama-cpp" &&
    !isHostOllamaRequest(request) &&
    request.resumeReceipt !== undefined;
  const expectedRollbackPriorState =
    request.service === "llama-cpp"
      ? prepared.rollbackPriorState
      : managedPublishedResume
        ? prepared.rollbackPriorState
        : receipt.publication?.priorState;
  if (
    prepared.rollbackPriorState !== expectedRollbackPriorState ||
    (managedPublishedResume &&
      prepared.rollbackPriorState !== "running" &&
      prepared.rollbackPriorState !== "stopped") ||
    (managedPublishedResume &&
      serializeHostLocalInferenceReceipt(
        normalizeHostLocalInferenceReceipt(request.resumeReceipt),
      ) !== serializeHostLocalInferenceReceipt(receipt))
  ) {
    try {
      rollbackRejectedStartup(prepared);
    } catch {
      throw new Error(
        "Rejected published host-local inference resume could not prove state-at-entry restoration.",
      );
    }
    throw new Error("Host-local inference startup returned invalid rollback authority.");
  }
  return Object.freeze({
    prepared,
    receipt,
    gatewayProvider: hostLocalInferenceGatewayProvider(request),
    gatewayProviderBaseUrl: providerBaseUrl(receipt),
    applicationBaseUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
  });
}

export function prepareHostLocalInferenceStartup(
  operation: HostLocalInferenceOperation,
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceStartupRoute {
  return prepareHostLocalInferenceStartupWithAuthority(operation, request, "current");
}

/**
 * Resume one already-published Hermes Portable Ollama runtime. Its provider
 * owns the immutable creation authority while the operation owns the current
 * execution endpoint. No other startup shape may use this split.
 */
export function prepareHermesPortablePublishedHostLocalInferenceStartup(
  operation: HostLocalInferenceOperation,
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceStartupRoute {
  if (
    request.application !== "hermes" ||
    request.service !== "ollama" ||
    isHostOllamaRequest(request) ||
    request.resumeReceipt === undefined ||
    request.recover === true
  ) {
    throw new Error("Hermes Portable published inference recovery authority is invalid.");
  }
  return prepareHostLocalInferenceStartupWithAuthority(operation, request, "published-recovery");
}

export function hostLocalInferenceApplicationBaseUrl(
  application: HostLocalInferenceApplication,
  route: HostLocalInferenceStartupRoute,
): typeof HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL {
  requireApplication(application);
  return route.applicationBaseUrl;
}
