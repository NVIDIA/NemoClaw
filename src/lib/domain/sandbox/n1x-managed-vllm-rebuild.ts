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

export interface RecordedN1xManagedVllmRoute {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  endpointSource?: string | null;
  openshellDriver?: string | null;
  hostLocalInferenceReceipt?: string | null;
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
  vllmPort = VLLM_PORT,
): boolean {
  if (!Number.isInteger(vllmPort) || vllmPort < 1024 || vllmPort > 65535) return false;
  const canonicalEndpointUrl = `http://host.openshell.internal:${String(vllmPort)}/v1`;
  const recordedEndpointUsesCanonicalLocalRoute =
    sandboxEntry.endpointUrl === null || sandboxEntry.endpointUrl === canonicalEndpointUrl;
  if (
    !isN1xManagedVllmProviderModel(sandboxEntry.provider, sandboxEntry.model) ||
    !recordedEndpointUsesCanonicalLocalRoute ||
    sandboxEntry.endpointSource !== "onboard" ||
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
