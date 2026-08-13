// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "./contract";
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
  service: "ollama" | "nim" | "vllm",
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
  readonly provider: "ollama-local" | "vllm-local";
  readonly model: string;
  readonly providerBaseUrl: string;
}

/**
 * Injected exact-state transaction for the OpenShell gateway mutation. The
 * owner captures the prior provider and inference selection before returning.
 */
export interface HostLocalInferenceGatewayMutation {
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
      readonly service: "nim" | "vllm";
      readonly managed: HostLocalManagedInferenceInput;
      /** Exact durable receipt for a previously published canonical route. */
      readonly resumeReceipt?: HostLocalInferenceReceipt;
      /** Recover only an interrupted, not-yet-published same-transaction start. */
      readonly recover?: boolean;
      readonly receiptWriter: HostLocalInferenceReceiptWriter;
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
  readonly service: "ollama" | "nim" | "vllm";
  readonly directHostPort: number;
  readonly directHealthPath: "/api/tags" | "/v1/health/ready" | "/health";
  readonly toolCallingRequired: boolean;
}

export function hostLocalInferenceSandboxProofAuthority(
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceSandboxProofAuthority {
  const input = request.service === "ollama" ? request.endpoint : request.managed;
  const directHealthPath =
    request.service === "ollama"
      ? "/api/tags"
      : request.service === "nim"
        ? "/v1/health/ready"
        : "/health";
  return Object.freeze({
    service: request.service,
    directHostPort: input.hostPort,
    directHealthPath,
    toolCallingRequired: input.requireToolCalling,
  });
}

export interface HostLocalInferenceStartupRoute {
  readonly prepared: HostLocalInferencePreparedStartup;
  readonly receipt: HostLocalInferenceReceipt;
  readonly gatewayProvider: "ollama-local" | "vllm-local";
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
): HostLocalInferenceReceipt {
  const normalized = normalizeHostLocalInferenceReceipt(receipt);
  const model =
    request.service === "ollama"
      ? normalizeHostLocalOllamaModelRef(request.endpoint.model)
      : request.managed.model;
  const toolCallingRequired =
    request.service === "ollama"
      ? request.endpoint.requireToolCalling
      : request.managed.requireToolCalling;
  const protocol = "openai-chat-completions";
  const { inference, publication } = normalized;
  const requestInput = request.service === "ollama" ? request.endpoint : request.managed;
  const expectedProbeImageRef = normalizeHostLocalInferenceImageRef(requestInput.probeImageRef);
  const endpointMatches =
    "networkId" in normalized.endpoint &&
    normalized.endpoint.host === HOST_LOCAL_INFERENCE_SANDBOX_HOST &&
    normalized.endpoint.port === requestInput.hostPort &&
    normalized.endpoint.networkName === requestInput.networkName &&
    normalized.endpoint.networkId === requestInput.networkId &&
    normalized.endpoint.networkGatewayIp === requestInput.networkGatewayIp;
  const runtimeMatches =
    request.service === "ollama"
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
  if (
    normalized.providerId !== operation.providerId ||
    normalized.providerId !== runtime.providerId ||
    normalized.engineAuthority.providerId !== operation.providerId ||
    normalized.engineAuthority.operation !== "host-local-inference" ||
    normalized.engineAuthority.engineId !== operation.engine.engineId ||
    normalized.engineAuthority.authorityId !== operation.engine.authorityId ||
    normalized.engineAuthority.authorityId !== runtime.authorityId ||
    normalized.engineAuthority.bindingSha256 !== operation.bindingSha256 ||
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

export function prepareHostLocalInferenceStartup(
  operation: HostLocalInferenceOperation,
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceStartupRoute {
  requireApplication(request.application);
  operation.assertAuthority();
  const runtime: HostLocalInferenceRuntime | undefined = operation.managedRuntime;
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
  if (request.service === "ollama") {
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
    receipt = normalizeStartupReceipt(operation, runtime, request, prepared.receipt);
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
  const expectedRollbackPriorState =
    request.service !== "ollama" && request.resumeReceipt !== undefined
      ? prepared.rollbackPriorState
      : receipt.publication?.priorState;
  if (
    prepared.rollbackPriorState !== expectedRollbackPriorState ||
    (request.service !== "ollama" &&
      request.resumeReceipt !== undefined &&
      prepared.rollbackPriorState !== "running" &&
      prepared.rollbackPriorState !== "stopped") ||
    (request.service !== "ollama" &&
      request.resumeReceipt !== undefined &&
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
    gatewayProvider: request.service === "ollama" ? "ollama-local" : "vllm-local",
    gatewayProviderBaseUrl: providerBaseUrl(receipt),
    applicationBaseUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
  });
}

export function hostLocalInferenceApplicationBaseUrl(
  application: HostLocalInferenceApplication,
  route: HostLocalInferenceStartupRoute,
): typeof HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL {
  requireApplication(application);
  return route.applicationBaseUrl;
}
