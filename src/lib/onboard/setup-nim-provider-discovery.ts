// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayRouteDiscoveryConstraints } from "../inference/gateway-route-compatibility";
import type { ProviderInferenceProbeRoute } from "./machine/handlers/provider-inference-route-containment";
import { providerNameToOptionKey } from "./provider-recovery";
import type { RebuildRouteHandoff, RegistryInferenceRoute } from "./rebuild-route-handoff";

interface ProviderDiscoveryDeps {
  remoteProviderConfig: Record<string, { providerName: string }>;
  isNonInteractive(): boolean;
  getNonInteractiveProvider(): string | null;
  getNonInteractiveModel(providerKey: string): string | null;
  readRecordedProvider(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  readRecordedNimContainer(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  readRecordedModel(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
}

interface RecordedProviderReaders {
  readRecordedProvider(sandboxName: string | null | undefined): string | null;
  readRecordedNimContainer(sandboxName: string | null | undefined): string | null;
  readRecordedModel(sandboxName: string | null | undefined): string | null;
}

const OLLAMA_PROBE_PROVIDER_KEYS = new Set([
  "ollama",
  "install-ollama",
  "start-windows-ollama",
  "install-windows-ollama",
]);
const VLLM_ROUTE_PROVIDER_KEYS = new Set(["vllm", "install-vllm"]);
const VLLM_PROBE_PROVIDER_KEYS = new Set(["vllm", "install-vllm"]);

function localProviderProbeIntent(providerKey: string | null): {
  ollama: boolean;
  vllm: boolean;
} {
  if (!providerKey) return { ollama: true, vllm: true };
  return {
    ollama: OLLAMA_PROBE_PROVIDER_KEYS.has(providerKey),
    vllm: VLLM_PROBE_PROVIDER_KEYS.has(providerKey),
  };
}

function localProbeRouteProvider(providerKey: string | null): string | null {
  if (providerKey && OLLAMA_PROBE_PROVIDER_KEYS.has(providerKey)) return "ollama-local";
  if (providerKey && VLLM_ROUTE_PROVIDER_KEYS.has(providerKey)) return "vllm-local";
  return null;
}

function bindRecordedProviderReaders(
  deps: ProviderDiscoveryDeps,
  recoverProvider: boolean,
  recoveredRegistryRoute: RegistryInferenceRoute | null,
  recoverySessionId: string | null | undefined,
): RecordedProviderReaders {
  if (!recoverProvider) {
    return {
      readRecordedProvider: () => null,
      readRecordedNimContainer: () => null,
      readRecordedModel: () => null,
    };
  }
  return {
    readRecordedProvider: (name) =>
      recoveredRegistryRoute?.provider ?? deps.readRecordedProvider(name, recoverySessionId),
    readRecordedNimContainer: (name) => deps.readRecordedNimContainer(name, recoverySessionId),
    readRecordedModel: (name) =>
      recoveredRegistryRoute?.model ?? deps.readRecordedModel(name, recoverySessionId),
  };
}

export function prepareProviderDiscovery(options: {
  deps: ProviderDiscoveryDeps;
  sandboxName: string | null;
  recoverProvider: boolean;
  rebuildRegistryInferenceRoute: RebuildRouteHandoff | null;
  assertRouteCompatible?: (route: ProviderInferenceProbeRoute) => GatewayRouteDiscoveryConstraints;
  canProbeRoute?: (provider: string) => boolean;
  recoverySessionId: string | null | undefined;
}): {
  requestedProvider: string | null;
  requestedModel: string | null;
  recoveredRegistryRoute: RegistryInferenceRoute | null;
  recordedProviderReaders: RecordedProviderReaders;
  probeOllama: boolean;
  probeVllm: boolean;
} {
  const {
    deps,
    sandboxName,
    recoverProvider,
    rebuildRegistryInferenceRoute,
    assertRouteCompatible,
    canProbeRoute,
    recoverySessionId,
  } = options;
  const nonInteractive = deps.isNonInteractive();
  const requestedProvider = deps.getNonInteractiveProvider();
  const requestedModel = nonInteractive
    ? deps.getNonInteractiveModel(requestedProvider || "build")
    : null;
  const recoveredRegistryRoute =
    rebuildRegistryInferenceRoute?.sandboxName === sandboxName &&
    rebuildRegistryInferenceRoute.route.source === "registry"
      ? rebuildRegistryInferenceRoute.route
      : null;
  const recordedProviderReaders = bindRecordedProviderReaders(
    deps,
    recoverProvider,
    recoveredRegistryRoute,
    recoverySessionId,
  );
  const recoveredProbeProvider =
    nonInteractive && !requestedProvider
      ? recordedProviderReaders.readRecordedProvider(sandboxName)
      : null;
  const recoveredProbeKey = providerNameToOptionKey(
    deps.remoteProviderConfig,
    recoveredProbeProvider,
    {
      hasNimContainer:
        recoveredProbeProvider === "vllm-local" &&
        Boolean(recordedProviderReaders.readRecordedNimContainer(sandboxName)),
    },
  );
  const providerIntentKey =
    requestedProvider || recoveredProbeKey || (nonInteractive ? "build" : null);
  const intent = localProviderProbeIntent(providerIntentKey);
  const guardedProvider = localProbeRouteProvider(providerIntentKey);
  if (guardedProvider && assertRouteCompatible) {
    const recoveredModel =
      recoveredRegistryRoute?.model ??
      (!requestedProvider ? recordedProviderReaders.readRecordedModel(sandboxName) : null);
    assertRouteCompatible({
      provider: guardedProvider,
      model: requestedModel || recoveredModel,
      endpointUrl: null,
      preferredInferenceApi: null,
      credentialEnv: null,
    });
  }
  const ollamaPreflightPassed =
    guardedProvider === "ollama-local" && Boolean(assertRouteCompatible);
  const vllmPreflightPassed = guardedProvider === "vllm-local" && Boolean(assertRouteCompatible);
  return {
    requestedProvider,
    requestedModel,
    recoveredRegistryRoute,
    recordedProviderReaders,
    // Interactive menus always probe: the probe only drives status display
    // (" — running" suffix, detection banner), and route conflicts are still
    // enforced at selection time via assertRouteCompatible. Gating the probe
    // on the route preflight hid a running daemon from the menu whenever the
    // registry held an unrelated same-gateway route (#6750).
    probeOllama:
      intent.ollama &&
      (!nonInteractive || ollamaPreflightPassed || (canProbeRoute?.("ollama-local") ?? true)),
    probeVllm:
      intent.vllm &&
      (!nonInteractive || vllmPreflightPassed || (canProbeRoute?.("vllm-local") ?? true)),
  };
}
