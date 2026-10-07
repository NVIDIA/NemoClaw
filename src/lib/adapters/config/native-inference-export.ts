// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { createManagedProviderAdapter } from "../openshell/managed-provider-adapter";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../openshell/provider-adapter";
import {
  requireMatchingNativeCompatibleAttachment,
  type NativeCompatibleProviderAttachment,
} from "../../inference/native-compatible/contract";
import { verifyNativeCompatibleProviderAttachment } from "../../inference/native-compatible/profile";
import type { SandboxEntry } from "../../state/registry/types";
import type {
  ObservedExportEndpointEvidence,
  ObservedExportSandboxIdentity,
} from "../../domain/config/export-evidence";

import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { normalizeInferenceSelection } from "../../inference/selection";

import { createSynchronousCliOpenShellInferenceRouteObserver } from "../openshell/inference-route-cli";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
const CAPTURE_TIMEOUT_MS = 30_000;

/** Native selections derive their logical route from recorded selection, never the shared route. */
function resolveNativeExportSelection(
  entry: Readonly<SandboxEntry>,
  evidence?: ObservedExportEndpointEvidence,
) {
  if (evidence) {
    const selected = normalizeInferenceSelection(entry);
    if (!selected.model || !selected.provider)
      throw new Error("The native compatible selection is incomplete.");
    return {
      provider: evidence.provider.name,
      model: selected.model,
      logicalProvider: selected.provider,
    };
  }
  const receipt =
    entry.provider?.trim() === "nvidia-prod" ? entry.nativeNvidiaProviderAttachment : undefined;
  if (!receipt) return undefined;
  const selected = getSandboxEntryInference(entry);
  if (selected.kind !== "configured")
    throw new Error("The native NVIDIA inference selection is incomplete.");
  return {
    provider: receipt.providerName,
    model: selected.model,
    logicalProvider: selected.provider,
  };
}

function matchesReceipt(
  provider: OpenShellProviderMetadata,
  receipt: NativeCompatibleProviderAttachment,
): boolean {
  return (
    provider.revision?.id === receipt.providerId &&
    !!provider.revision.resourceVersion &&
    isDeepStrictEqual(
      [provider.name, provider.type, provider.credentialKeys, provider.configKeys],
      [receipt.providerName, receipt.profileId, ["NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY"], []],
    )
  );
}

export async function nativeCompatibleEvidence(
  entry: Readonly<SandboxEntry>,
  target: Parameters<OpenShellProviderAdapter["getProvider"]>[0]["target"],
  sandbox: ObservedExportSandboxIdentity,
  signal: AbortSignal,
  adapter: OpenShellProviderAdapter = createManagedProviderAdapter(),
): Promise<ObservedExportEndpointEvidence | undefined> {
  const receipt = requireMatchingNativeCompatibleAttachment(
    entry.nativeCompatibleProviderAttachment,
    entry,
  );
  if (!receipt) return undefined;
  if (!sandbox.providerNames.includes(receipt.providerName))
    throw new Error("The native compatible provider is not attached to the sandbox.");
  signal.throwIfAborted();
  if (target.kind !== "named") throw new Error("Config export requires a named gateway.");
  await verifyNativeCompatibleProviderAttachment({
    adapter,
    target,
    sandboxName: entry.name,
    expected: receipt,
  });
  signal.throwIfAborted();
  const observed = await adapter.getProvider({
    target,
    providerName: receipt.providerName,
  });
  signal.throwIfAborted();
  if (!observed.ok || !observed.value || !matchesReceipt(observed.value, receipt))
    throw new Error("The native compatible provider identity changed during export.");
  return {
    endpoint: receipt.endpointUrl,
    source: { kind: "native-compatible-profile", profileId: receipt.profileId },
    provider: {
      gatewayName: target.gatewayName,
      workspace: "default",
      name: receipt.providerName,
      id: receipt.providerId,
      resourceVersion: String(observed.value.revision?.resourceVersion),
    },
  };
}

async function readInferenceRoute(
  entry: Readonly<SandboxEntry>,
  target: Parameters<OpenShellProviderAdapter["getProvider"]>[0]["target"],
) {
  const selected = getSandboxEntryInference(entry);
  const observer = createSynchronousCliOpenShellInferenceRouteObserver((args, options) =>
    captureSanitizedResolvedOpenshell(args, {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: options.maxBuffer,
      timeout: options?.timeout ?? CAPTURE_TIMEOUT_MS,
    }),
  );
  const result = observer.observeInferenceRoute({
    target,
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
  if (!result.ok || result.value.state !== "configured")
    throw new Error("The live gateway inference route could not be read.");
  const live = result.value.route;
  if (
    selected.kind !== "configured" ||
    live.provider !== selected.provider ||
    live.model !== selected.model
  )
    throw new Error("The live gateway inference route does not match the registry.");
  return live;
}

export async function exportInferenceSelection(
  entry: Readonly<SandboxEntry>,
  target: Parameters<OpenShellProviderAdapter["getProvider"]>[0]["target"],
  evidence?: ObservedExportEndpointEvidence,
) {
  const selected = resolveNativeExportSelection(entry, evidence);
  if (selected) return selected;
  const live = await readInferenceRoute(entry, target);
  return { ...live, logicalProvider: live.provider };
}
