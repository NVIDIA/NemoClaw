// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../../adapters/openshell/provider-adapter";
import type { OpenShellRuntimeSelection } from "../../../adapters/openshell/runtime-selection";
import {
  isPersistedPiSharedLocalInferenceRoute,
  usesNativeLocalInference,
} from "../../../inference/native-local/eligibility";
import { qualifiedNativeLocalEndpointUrl } from "../../../inference/native-local/agent-config";
import {
  normalizeNativeLocalProviderAttachment,
  verifyNativeLocalProviderAttachment,
} from "../../../inference/native-local/profile";
import { gatewayReachableCompatibleEndpointUrl } from "../../../onboard/inference-providers/compatible-endpoint-gateway-route";
import type { SandboxEntry } from "../../../state/registry";
import type { RebuildResumeConfig } from "../rebuild-resume-config";

export type NativeLocalRebuildSelection = Pick<
  RebuildResumeConfig,
  | "nativeLocalProviderAttachment"
  | "nativeNvidiaProviderAttachment"
  | "nativeHostedProviderAttachment"
> & {
  provider?: string | null;
  model?: string | null;
  endpointUrl?: string | null;
  agent?: string | null;
  gatewayName?: string | null;
};

/** Read the recorded sandbox-scoped provider; never recreate a shared logical provider. */
export async function verifyNativeLocalRebuildSelection(
  sandboxName: string,
  selection: NativeLocalRebuildSelection,
  runtimeSelection: OpenShellRuntimeSelection | undefined,
  adapter: OpenShellProviderAdapter,
  readRecordedSandbox: () => SandboxEntry | null,
): Promise<boolean> {
  if (
    selection.nativeLocalProviderAttachment === undefined &&
    !usesNativeLocalInference(selection.provider, selection.endpointUrl)
  )
    return false;
  try {
    if (selection.agent === "pi" && selection.nativeLocalProviderAttachment === undefined) {
      const recorded = readRecordedSandbox();
      if (isPersistedPiSharedLocalInferenceRoute(recorded, selection)) return false;
    }
    const expected = normalizeNativeLocalProviderAttachment(
      selection.nativeLocalProviderAttachment,
    );
    const gatewayName = runtimeSelection?.gatewayName ?? selection.gatewayName;
    const endpoint =
      selection.provider === "compatible-endpoint"
        ? gatewayReachableCompatibleEndpointUrl(selection.provider, selection.endpointUrl)
        : null;
    if (
      !expected ||
      expected.sandboxName !== sandboxName ||
      expected.provider !== selection.provider ||
      (gatewayName != null && expected.gatewayName !== gatewayName) ||
      expected.agent !== (selection.agent === "hermes" ? "hermes" : undefined) ||
      selection.nativeHostedProviderAttachment !== undefined ||
      selection.nativeNvidiaProviderAttachment !== undefined ||
      (selection.provider === "compatible-endpoint" &&
        (!endpoint || qualifiedNativeLocalEndpointUrl(endpoint) !== expected.endpointUrl))
    )
      throw new Error("Native local selection changed");
    await verifyNativeLocalProviderAttachment({ adapter, sandboxName, expected });
    return true;
  } catch {
    // Provider command diagnostics can contain credential material.
    throw new Error(
      "Could not verify the recorded native local provider attachment; sandbox is untouched.",
    );
  }
}
