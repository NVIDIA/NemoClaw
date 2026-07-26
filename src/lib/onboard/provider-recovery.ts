// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { isSafeModelId } from "../validation";
import {
  type InferenceEndpointSource,
  normalizeInferenceEndpointSource,
} from "../inference/selection";

export type RemoteProviderConfigEntryLike = { providerName?: string };

export function providerNameToOptionKey(
  remoteProviderConfig: Record<string, RemoteProviderConfigEntryLike>,
  name: string | null | undefined,
  opts: { hasNimContainer?: boolean } = {},
): string | null {
  if (!name) return null;
  if (name === "nvidia-router") return "routed";
  if (name === "ollama-local") return "ollama";
  // Local NIM and standalone vLLM both persist as provider="vllm-local". NIM
  // is positively identified by a nimContainer record; the absence of one in
  // registry/session recovery reliably means standalone vLLM (the standalone
  // path never records a container), so default to "vllm" there. Live-gateway
  // recovery doesn't carry container info either, but the caller's
  // option-availability check still gates on whether vllm is actually running.
  if (name === "vllm-local") return opts.hasNimContainer ? "nim-local" : "vllm";
  // `nvidia-nim` is a legacy alias for cloud NVIDIA Endpoints (see
  // setupInference: it routes nvidia-nim through REMOTE_PROVIDER_CONFIG.build),
  // not a marker for Local NIM. Local NIM persists as vllm-local + nimContainer.
  if (name === "nvidia-nim") return "build";
  for (const [key, cfg] of Object.entries(remoteProviderConfig)) {
    if (cfg.providerName === name) return key;
  }
  return null;
}

export interface ProviderRecoveryDeps {
  parseGatewayInference(
    output: string | null,
  ): { provider: string | null; model: string | null } | null;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  warn?(message: string): void;
}

export interface ProviderRecoveryHelpers {
  readLiveInference(
    sandboxName: string | null | undefined,
  ): { provider: string | null; model: string | null } | null;
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
  readRecordedEndpointUrl(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null;
  readRecordedInferenceRoute(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): RecordedInferenceRoute | null;
  readRecordedProviderEndpoints(
    provider: string,
    excludeSandboxName: string | null | undefined,
  ): string[] | null;
}

export interface RecordedInferenceRoute {
  provider: string;
  model: string;
  endpointUrl: string | null;
  endpointSource?: InferenceEndpointSource | null;
  preferredInferenceApi: string;
  source: "registry" | "session";
}

const MAX_LIVE_PROVIDER_LENGTH = 128;
const MAX_LIVE_MODEL_LENGTH = 512;
const SAFE_LIVE_PROVIDER = /^[A-Za-z0-9._:-]+$/;

export type SandboxRecoveryAuthority = "missing" | "authorized" | "unauthorized";

export function classifySandboxRecoveryAuthority(
  entry: registry.SandboxEntry | null,
  sessionId: string | null | undefined,
): SandboxRecoveryAuthority {
  if (!entry) return "missing";
  if (entry.pendingRouteReservation !== true) return "authorized";
  return registry.isPendingReservationForSession(entry, sessionId) ? "authorized" : "unauthorized";
}

export function getSandboxRecoveryAuthority(
  sandboxName: string,
  sessionId: string | null | undefined,
): SandboxRecoveryAuthority {
  return classifySandboxRecoveryAuthority(registry.getSandbox(sandboxName), sessionId);
}

export function shouldRecoverRecordedProvider(input: {
  fresh: boolean;
  sandboxName: string | null;
  sandboxRecoveryAuthority: SandboxRecoveryAuthority;
  sessionSandboxName: string | null;
}): boolean {
  return (
    !input.fresh &&
    (!input.sandboxName ||
      input.sandboxRecoveryAuthority === "authorized" ||
      (input.sandboxRecoveryAuthority === "missing" &&
        input.sessionSandboxName === input.sandboxName))
  );
}

function readRegistryRecoveryState(
  sandboxName: string,
  recoverySessionId: string | null | undefined,
): {
  authority: SandboxRecoveryAuthority;
  entry: registry.SandboxEntry | null;
} {
  const entry = registry.getSandbox(sandboxName);
  const authority = classifySandboxRecoveryAuthority(entry, recoverySessionId);
  return { authority, entry };
}

export function validateLiveGatewayInference(
  value: { provider: string | null; model: string | null } | null,
): { provider: string; model: string } | null {
  const provider = typeof value?.provider === "string" ? value.provider.trim() : "";
  const model = typeof value?.model === "string" ? value.model.trim() : "";
  if (
    !provider ||
    provider.length > MAX_LIVE_PROVIDER_LENGTH ||
    !SAFE_LIVE_PROVIDER.test(provider) ||
    !model ||
    model.length > MAX_LIVE_MODEL_LENGTH ||
    !isSafeModelId(model)
  ) {
    return null;
  }
  return { provider, model };
}

function completeRecordedInferenceRoute(
  value: {
    provider?: unknown;
    model?: unknown;
    endpointUrl?: unknown;
    endpointSource?: unknown;
    preferredInferenceApi?: unknown;
  },
  source: RecordedInferenceRoute["source"],
): RecordedInferenceRoute | null {
  const inference = validateLiveGatewayInference({
    provider: typeof value.provider === "string" ? value.provider : null,
    model: typeof value.model === "string" ? value.model : null,
  });
  const preferredInferenceApi =
    typeof value.preferredInferenceApi === "string" ? value.preferredInferenceApi.trim() : "";
  if (!inference || !preferredInferenceApi) return null;
  const endpointUrl =
    typeof value.endpointUrl === "string" && value.endpointUrl.trim()
      ? value.endpointUrl.trim()
      : null;
  const endpointSource = endpointUrl
    ? normalizeInferenceEndpointSource(value.endpointSource)
    : null;
  return { ...inference, endpointUrl, endpointSource, preferredInferenceApi, source };
}

export function createProviderRecoveryHelpers(deps: ProviderRecoveryDeps): ProviderRecoveryHelpers {
  function refuseRecoveryAfterRegistryError(sandboxName: string, error: unknown): null {
    const detail = error instanceof Error ? error.message : String(error);
    deps.warn?.(
      `  Warning: could not verify recorded inference ownership for sandbox '${sandboxName}'; refusing recovery (${detail}).`,
    );
    return null;
  }

  function readLiveInference(
    sandboxName: string | null | undefined,
  ): { provider: string | null; model: string | null } | null {
    if (!sandboxName) return null;
    try {
      const { defaultSandbox, sandboxes } = registry.listSandboxes();
      // The gateway holds one active inference config at a time. Trust the
      // live read for the default sandbox, or when the registry has no
      // entries (rebuild path: destroy wiped the entry but the gateway
      // config persists). Other non-default sandboxes have a stored config
      // that the gateway will swap to on their next connect.
      const trustGateway = sandboxName === defaultSandbox || sandboxes.length === 0;
      if (!trustGateway) return null;
      const output = deps.runCaptureOpenshell(["inference", "get"], { ignoreError: true });
      // `openshell inference get` is a display boundary, not a typed API.
      // Accept it only when both routing fields are complete, bounded, and safe;
      // partial or malformed output must not steer a rebuild.
      return validateLiveGatewayInference(deps.parseGatewayInference(output));
    } catch {
      return null;
    }
  }

  function readRecordedProvider(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null {
    if (!sandboxName) return null;
    try {
      const { authority, entry } = readRegistryRecoveryState(sandboxName, recoverySessionId);
      if (authority === "unauthorized") return null;
      if (entry)
        return typeof entry.provider === "string" && entry.provider ? entry.provider : null;
    } catch (error) {
      return refuseRecoveryAfterRegistryError(sandboxName, error);
    }
    try {
      const session = onboardSession.loadSession();
      if (
        session &&
        session.sandboxName === sandboxName &&
        typeof session.provider === "string" &&
        session.provider
      ) {
        return session.provider;
      }
    } catch {
      // fall through to live gateway
    }
    const live = readLiveInference(sandboxName);
    if (live && typeof live.provider === "string" && live.provider) {
      return live.provider;
    }
    return null;
  }

  function readRecordedNimContainer(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null {
    if (!sandboxName) return null;
    try {
      const { authority, entry } = readRegistryRecoveryState(sandboxName, recoverySessionId);
      if (authority === "unauthorized") return null;
      if (entry)
        return typeof entry.nimContainer === "string" && entry.nimContainer
          ? entry.nimContainer
          : null;
    } catch (error) {
      return refuseRecoveryAfterRegistryError(sandboxName, error);
    }
    try {
      const session = onboardSession.loadSession();
      if (
        session &&
        session.sandboxName === sandboxName &&
        typeof session.nimContainer === "string" &&
        session.nimContainer
      ) {
        return session.nimContainer;
      }
    } catch {
      return null;
    }
    return null;
  }

  function readRecordedModel(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null {
    if (!sandboxName) return null;
    try {
      const { authority, entry } = readRegistryRecoveryState(sandboxName, recoverySessionId);
      if (authority === "unauthorized") return null;
      if (entry) return typeof entry.model === "string" && entry.model ? entry.model : null;
    } catch (error) {
      return refuseRecoveryAfterRegistryError(sandboxName, error);
    }
    try {
      const session = onboardSession.loadSession();
      if (
        session &&
        session.sandboxName === sandboxName &&
        typeof session.model === "string" &&
        session.model
      ) {
        return session.model;
      }
    } catch {
      // fall through to live gateway
    }
    const live = readLiveInference(sandboxName);
    if (live && typeof live.model === "string" && live.model) {
      return live.model;
    }
    return null;
  }

  function readRecordedEndpointUrl(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): string | null {
    if (!sandboxName) return null;
    try {
      const { authority, entry } = readRegistryRecoveryState(sandboxName, recoverySessionId);
      if (authority === "unauthorized") return null;
      if (entry)
        return typeof entry.endpointUrl === "string" && entry.endpointUrl
          ? entry.endpointUrl
          : null;
    } catch (error) {
      return refuseRecoveryAfterRegistryError(sandboxName, error);
    }
    try {
      const session = onboardSession.loadSession();
      if (
        session &&
        session.sandboxName === sandboxName &&
        typeof session.endpointUrl === "string" &&
        session.endpointUrl
      ) {
        return session.endpointUrl;
      }
    } catch {
      return null;
    }
    return null;
  }

  function readRecordedInferenceRoute(
    sandboxName: string | null | undefined,
    recoverySessionId?: string | null,
  ): RecordedInferenceRoute | null {
    if (!sandboxName) return null;
    try {
      const { authority, entry } = readRegistryRecoveryState(sandboxName, recoverySessionId);
      if (authority === "unauthorized") return null;
      // A present registry row is authoritative. If it is incomplete, fail
      // closed instead of filling its gaps from an older onboard session.
      if (entry) return completeRecordedInferenceRoute(entry, "registry");
    } catch (error) {
      return refuseRecoveryAfterRegistryError(sandboxName, error);
    }
    try {
      const session = onboardSession.loadSession();
      return session?.sandboxName === sandboxName
        ? completeRecordedInferenceRoute(session, "session")
        : null;
    } catch {
      return null;
    }
  }

  function readRecordedProviderEndpoints(
    provider: string,
    excludeSandboxName: string | null | undefined,
  ): string[] | null {
    try {
      return registry
        .listSandboxes()
        .sandboxes.filter(
          (entry) => entry.name !== excludeSandboxName && entry.provider === provider,
        )
        .map((entry) => (typeof entry.endpointUrl === "string" ? entry.endpointUrl.trim() : ""));
    } catch {
      return null;
    }
  }

  return {
    readLiveInference,
    readRecordedProvider,
    readRecordedNimContainer,
    readRecordedModel,
    readRecordedEndpointUrl,
    readRecordedInferenceRoute,
    readRecordedProviderEndpoints,
  };
}
