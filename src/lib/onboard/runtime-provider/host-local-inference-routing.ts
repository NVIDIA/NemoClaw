// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HostLocalInferenceEndpointInput,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRuntime,
  type HostLocalManagedInferenceInput,
  normalizeHostLocalInferenceReceipt,
} from "./host-local-inference";

export const HOST_LOCAL_INFERENCE_SANDBOX_HOST = "host.openshell.internal" as const;
export const HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL = "https://inference.local/v1" as const;

export const HOST_LOCAL_INFERENCE_APPLICATIONS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;

export type HostLocalInferenceApplication = (typeof HOST_LOCAL_INFERENCE_APPLICATIONS)[number];

export type HostLocalInferenceStartupRequest =
  | {
      readonly service: "ollama";
      readonly endpoint: HostLocalInferenceEndpointInput;
    }
  | {
      readonly service: "nim" | "vllm";
      readonly managed: HostLocalManagedInferenceInput;
    };

export interface HostLocalInferenceStartupRoute {
  readonly receipt: HostLocalInferenceReceipt;
  readonly gatewayProvider: "ollama-local" | "vllm-local";
  /** Provider registration target visible inside the OpenShell gateway. */
  readonly gatewayProviderBaseUrl: string;
  /** Stable inference route shared by OpenClaw, Hermes, and LangChain Deep Agents Code. */
  readonly applicationBaseUrl: typeof HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL;
}

function normalizeStartupReceipt(
  runtime: HostLocalInferenceRuntime,
  service: HostLocalInferenceStartupRequest["service"],
  receipt: HostLocalInferenceReceipt,
): HostLocalInferenceReceipt {
  const normalized = normalizeHostLocalInferenceReceipt(receipt);
  if (
    normalized.providerId !== runtime.providerId ||
    normalized.engineAuthority.authorityId !== runtime.authorityId ||
    normalized.service !== service
  ) {
    throw new Error("Host-local inference startup returned a different runtime authority.");
  }
  return normalized;
}

function providerBaseUrl(receipt: HostLocalInferenceReceipt): string {
  // The provider-native receipt host proves reachability from its own engine
  // network. It is deliberately not exposed to central orchestration. Every
  // application reaches the gateway through OpenShell's canonical host alias.
  return `http://${HOST_LOCAL_INFERENCE_SANDBOX_HOST}:${String(receipt.endpoint.port)}/v1`;
}

export function prepareHostLocalInferenceStartup(
  runtime: HostLocalInferenceRuntime,
  request: HostLocalInferenceStartupRequest,
): HostLocalInferenceStartupRoute {
  if (!runtime.services.includes(request.service)) {
    throw new Error(
      `Runtime provider '${runtime.providerId}' does not support host-local ${request.service}.`,
    );
  }
  let rawReceipt: HostLocalInferenceReceipt;
  if (request.service === "ollama") {
    rawReceipt = runtime.qualifyOllama(request.endpoint);
  } else {
    if (request.managed.service !== request.service) {
      throw new Error("Managed host-local inference service identity is inconsistent.");
    }
    rawReceipt = runtime.startManaged(request.managed);
  }
  const receipt = normalizeStartupReceipt(runtime, request.service, rawReceipt);
  return Object.freeze({
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
  if (!HOST_LOCAL_INFERENCE_APPLICATIONS.includes(application)) {
    throw new Error(`Unsupported host-local inference application '${String(application)}'.`);
  }
  return route.applicationBaseUrl;
}
