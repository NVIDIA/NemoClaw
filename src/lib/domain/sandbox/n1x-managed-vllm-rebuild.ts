// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { VLLM_PORT } from "../../core/vllm-port";

const N1X_EXPRESS_PROVIDER = "vllm-local";
const N1X_EXPRESS_MODEL = "nvidia/Qwen3.6-35B-A3B-NVFP4";

/** True only for the provider and model identity reserved by N1x Express. */
export function isN1xManagedVllmProviderModel(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return provider === N1X_EXPRESS_PROVIDER && model === N1X_EXPRESS_MODEL;
}

/** Recheck the staged N1x replacement authority before destructive boundaries. */
export function hasValidDeferredN1xManagedVllmReplacementAuthority(
  recreateOptions: {
    allowDeferredN1xManagedVllm?: boolean;
    reinstallDeferredN1xManagedVllm?: boolean;
  },
  sandboxEntry: { openshellDriver?: string | null; nimContainer?: unknown },
  rebuildSelection: { provider: string; model: string },
): boolean {
  return (
    recreateOptions.reinstallDeferredN1xManagedVllm !== true ||
    (recreateOptions.allowDeferredN1xManagedVllm === true &&
      isN1xManagedVllmProviderModel(rebuildSelection.provider, rebuildSelection.model) &&
      sandboxEntry.openshellDriver === "docker" &&
      !sandboxEntry.nimContainer)
  );
}

export interface DeferredN1xManagedVllmAcceptanceRoute {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  endpointSource?: string | null;
  nimContainer?: unknown;
  openshellDriver?: string | null;
}

/** True only when durable Deferred N1x acceptance is valid for this route. */
export function isDeferredN1xManagedVllmAcceptanceRoute(
  route: DeferredN1xManagedVllmAcceptanceRoute,
): boolean {
  return (
    isN1xManagedVllmProviderModel(route.provider, route.model) &&
    route.endpointUrl === null &&
    route.endpointSource === null &&
    route.nimContainer == null &&
    route.openshellDriver === "docker"
  );
}

export interface RecordedN1xManagedVllmRoute {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  endpointSource?: string | null;
  openshellDriver?: string | null;
  hostLocalInferenceReceipt?: string | null;
  deferredN1xManagedVllmAccepted?: unknown;
}

export interface N1xManagedVllmRebuildSelection {
  provider: string;
  model: string;
  pinEndpoint: boolean;
  endpointUrl: string | null;
}

export interface N1xManagedVllmReceipt {
  service: string;
  endpoint: { host: string; port: number };
  inference?: { model: string };
}

export type ParseN1xManagedVllmReceipt = (serialized: string) => N1xManagedVllmReceipt;

/** Decide whether a recorded route proves the exact Deferred N1x managed-vLLM selection. */
export function isRecordedN1xManagedVllmRebuildEligible(
  sandboxEntry: RecordedN1xManagedVllmRoute,
  rebuildSelection: N1xManagedVllmRebuildSelection,
  parseReceipt: ParseN1xManagedVllmReceipt,
  options: { vllmPort?: number; explicitPreviewIntent?: boolean } = {},
): boolean {
  const vllmPort = options.vllmPort ?? VLLM_PORT;
  if (!Number.isInteger(vllmPort) || vllmPort < 1024 || vllmPort > 65535) return false;
  const canonicalEndpointUrl = `http://host.openshell.internal:${String(vllmPort)}/v1`;
  const recordedEndpointUsesCanonicalLocalRoute =
    sandboxEntry.endpointUrl === null || sandboxEntry.endpointUrl === canonicalEndpointUrl;
  const recordedSourceIsEligible =
    sandboxEntry.endpointSource === "onboard" ||
    (sandboxEntry.endpointSource === null &&
      sandboxEntry.endpointUrl === null &&
      (sandboxEntry.deferredN1xManagedVllmAccepted === true ||
        options.explicitPreviewIntent === true));
  if (
    !isN1xManagedVllmProviderModel(sandboxEntry.provider, sandboxEntry.model) ||
    !recordedEndpointUsesCanonicalLocalRoute ||
    !recordedSourceIsEligible ||
    sandboxEntry.openshellDriver !== "docker" ||
    rebuildSelection.provider !== sandboxEntry.provider ||
    rebuildSelection.model !== sandboxEntry.model ||
    rebuildSelection.pinEndpoint !== true ||
    rebuildSelection.endpointUrl !== null
  ) {
    return false;
  }
  const serialized = sandboxEntry.hostLocalInferenceReceipt;
  if (serialized === undefined || serialized === null) return true;
  try {
    const receipt = parseReceipt(serialized);
    return (
      receipt.service === "vllm" &&
      receipt.endpoint.host === "host.openshell.internal" &&
      receipt.endpoint.port === vllmPort &&
      receipt.inference?.model === N1X_EXPRESS_MODEL
    );
  } catch {
    return false;
  }
}
