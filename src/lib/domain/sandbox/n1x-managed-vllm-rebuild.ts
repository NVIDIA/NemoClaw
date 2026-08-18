// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const N1X_EXPRESS_PROVIDER = "vllm-local";
const N1X_EXPRESS_MODEL = "nvidia/Qwen3.6-35B-A3B-NVFP4";
const N1X_EXPRESS_ENDPOINT_URL = "http://host.openshell.internal:8000/v1";

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
): boolean {
  const recordedEndpointUsesCanonicalLocalRoute =
    sandboxEntry.endpointUrl === null || sandboxEntry.endpointUrl === N1X_EXPRESS_ENDPOINT_URL;
  if (
    sandboxEntry.provider !== N1X_EXPRESS_PROVIDER ||
    sandboxEntry.model !== N1X_EXPRESS_MODEL ||
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
      receipt.endpoint.port === 8000 &&
      receipt.inference?.model === N1X_EXPRESS_MODEL
    );
  } catch {
    return false;
  }
}
