// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";

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
  parseGatewayInference(output: string | null): { provider: string | null; model: string | null } | null;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface ProviderRecoveryHelpers {
  readLiveInference(sandboxName: string | null | undefined): { provider: string | null; model: string | null } | null;
  readRecordedProvider(sandboxName: string | null | undefined): string | null;
  readRecordedNimContainer(sandboxName: string | null | undefined): string | null;
  readRecordedModel(sandboxName: string | null | undefined): string | null;
}

export function createProviderRecoveryHelpers(deps: ProviderRecoveryDeps): ProviderRecoveryHelpers {
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
      return deps.parseGatewayInference(output);
    } catch {
      return null;
    }
  }

  function readRecordedProvider(sandboxName: string | null | undefined): string | null {
    if (!sandboxName) return null;
    try {
      const entry = registry.getSandbox(sandboxName);
      if (entry && typeof entry.provider === "string" && entry.provider) {
        return entry.provider;
      }
    } catch {
      // fall through to session
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

  function readRecordedNimContainer(sandboxName: string | null | undefined): string | null {
    if (!sandboxName) return null;
    try {
      const entry = registry.getSandbox(sandboxName);
      if (entry && typeof entry.nimContainer === "string" && entry.nimContainer) {
        return entry.nimContainer;
      }
    } catch {
      // fall through to session
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

  function readRecordedModel(sandboxName: string | null | undefined): string | null {
    if (!sandboxName) return null;
    try {
      const entry = registry.getSandbox(sandboxName);
      if (entry && typeof entry.model === "string" && entry.model) {
        return entry.model;
      }
    } catch {
      // fall through to session
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

  return { readLiveInference, readRecordedProvider, readRecordedNimContainer, readRecordedModel };
}
