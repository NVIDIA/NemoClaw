// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeModelRouterEndpoint } from "../../inference/native-local/model-router";
import {
  assertNativeModelRouterOwner,
  prepareNativeModelRouterSelection,
} from "../../onboard/routed-inference";
import type { NimSwitchSelection } from "./local-runtime";
import type { InferenceSetDeps } from "../inference-set";
import { InferenceSetError } from "../inference-set-error";
import {
  usesNativeLocalInferenceForAgent,
  gatewayReachableCompatibleEndpointUrl,
} from "../../inference/native-local/eligibility";
import {
  detachNativeLocalProvider,
  ensureNativeLocalProviderAttached,
  normalizeNativeLocalProviderAttachment,
  nativeLocalIdentity,
  retireNativeLocalProvider,
  type NativeLocalProviderAttachment,
  verifyNativeLocalProviderAttachment,
} from "../../inference/native-local/profile";
import { prepareNativeLocalSelection } from "../../inference/native-local/selection";
import type { SandboxEntry } from "../../state/registry";
import { usesLoopbackNoAuthProxyRoute } from "../inference-set-route-containment";
import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";

export type OpenClawLocalSwitch = {
  selected?: NativeLocalProviderAttachment;
  previous?: NativeLocalProviderAttachment;
  prepare?: boolean;
};

/** Reuse a matching attachment or prepare a new sandbox-owned local selection. */
export async function resolveOpenClawLocalSwitch(input: {
  agentName: string;
  entry: SandboxEntry;
  provider: string;
  endpointUrl?: string | null;
  inferenceApi?: string | null;
  customRouteChanged?: boolean;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
}): Promise<OpenClawLocalSwitch> {
  if (input.agentName !== "openclaw") return {};
  const { entry, provider, sandboxName, gatewayName, deps } = input;
  const previous = normalizeNativeLocalProviderAttachment(entry.nativeLocalProviderAttachment);
  if (entry.nativeLocalProviderAttachment !== undefined && !previous) {
    throw new InferenceSetError(
      "Recorded native local provider ownership is invalid. Retain this sandbox for repair.",
      2,
    );
  }
  if (previous) {
    if (
      previous.agent !== "openclaw" ||
      previous.sandboxName !== sandboxName ||
      previous.gatewayName !== gatewayName ||
      previous.provider !== entry.provider
    ) {
      throw new InferenceSetError(
        "Recorded native local provider ownership does not match this sandbox. Retain it for repair.",
        2,
      );
    }
    await verifyNativeLocalProviderAttachment({
      adapter: deps.providerAdapter,
      sandboxName,
      expected: previous,
    });
  }
  const router = Boolean(nativeModelRouterEndpoint(provider));
  if (
    previous &&
    input.endpointUrl &&
    usesLoopbackNoAuthProxyRoute(entry, provider) &&
    new URL(input.endpointUrl).href.replace(/\/+$/, "") !==
      new URL(entry.endpointUrl!).href.replace(/\/+$/, "")
  ) {
    throw new InferenceSetError(
      "The no-auth proxy is bound to the recorded backend. Reuse that endpoint; inference set cannot change its host, port, or path.",
      2,
    );
  }
  const endpointUrl = input.endpointUrl ?? (entry.provider === provider ? entry.endpointUrl : null);
  if (
    !usesNativeLocalInferenceForAgent(
      "openclaw",
      provider,
      endpointUrl,
      Boolean(entry.nimContainer),
    )
  )
    return { previous };
  // Only onboarding establishes loopback rewrites. New live selections keep
  // the existing reserved-alias admission rule; recorded proxy reuse is separate.
  if (
    provider === "compatible-endpoint" &&
    input.endpointUrl &&
    new URL(input.endpointUrl).hostname !== "host.openshell.internal" &&
    !usesLoopbackNoAuthProxyRoute(entry, provider) &&
    (!previous ||
      gatewayReachableCompatibleEndpointUrl(provider, input.endpointUrl) !== previous.endpointUrl)
  )
    return { previous };
  // A retained OpenClaw row may still own the historical shared route.
  if (!previous && entry.provider === provider) {
    if (router)
      throw new InferenceSetError(
        "Recreate this legacy Model Router sandbox before changing inference.",
        2,
      );
    return {};
  }
  if (!previous || entry.provider !== provider) return { previous, prepare: true };
  const expectedEndpoint = usesLoopbackNoAuthProxyRoute(entry, provider)
    ? `http://host.openshell.internal:${OLLAMA_PROXY_PORT}${new URL(entry.endpointUrl!).pathname.replace(/\/+$/, "")}`
    : gatewayReachableCompatibleEndpointUrl(provider, endpointUrl);
  if (
    provider === "compatible-endpoint" &&
    (previous.endpointUrl !== expectedEndpoint ||
      (previous.api ?? "openai-completions") !== (input.inferenceApi ?? "openai-completions"))
  ) {
    if (input.customRouteChanged) return { previous, prepare: true };
    throw new InferenceSetError(
      "Recorded compatible provider API or endpoint does not match its native attachment.",
    );
  }
  if (router) {
    const runtime = deps.resolveLocalSwitchRuntime?.(provider, deps.resolveCredentialValue);
    if (
      !runtime?.endpointUrl ||
      !runtime.credentialValue ||
      runtime.endpointUrl !== previous.endpointUrl
    )
      throw new InferenceSetError("Model Router ownership requires its configured credential.", 2);
    assertNativeModelRouterOwner(runtime.endpointUrl, runtime.credentialValue);
  }
  if (previous.profileId !== nativeLocalIdentity(previous).profileId)
    return { previous, prepare: true };
  return { selected: previous, previous };
}

export async function prepareOpenClawLocalSwitch(input: {
  selection: OpenClawLocalSwitch;
  entry: SandboxEntry;
  provider: string;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
  nimSelection?: NimSwitchSelection;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
  beforeAttach: () => Promise<void>;
}) {
  if (!input.selection.prepare) return;
  const { deps } = input;
  if (
    !deps.resolveLocalSwitchRuntime ||
    !deps.getNativeLocalProviderAuthority ||
    !deps.setNativeLocalProviderAuthority
  )
    throw new InferenceSetError("Native local provider ownership storage is unavailable.");
  const ownedProxy = usesLoopbackNoAuthProxyRoute(input.entry, input.provider);
  const runtime =
    input.provider === "compatible-endpoint"
      ? {
          endpointUrl: ownedProxy
            ? input.selection.previous?.endpointUrl
            : gatewayReachableCompatibleEndpointUrl(input.provider, input.endpointUrl),
          credentialValue: deps.resolveCredentialValue(input.credentialEnv || "COMPATIBLE_API_KEY"),
          authMode: "authenticated" as const,
          ownedProxy,
        }
      : deps.resolveLocalSwitchRuntime(
          input.provider,
          deps.resolveCredentialValue,
          input.nimSelection,
        );
  if (!runtime.endpointUrl)
    throw new InferenceSetError("The local runtime endpoint is unavailable.");
  input.selection.selected = await (
    nativeModelRouterEndpoint(input.provider)
      ? prepareNativeModelRouterSelection
      : prepareNativeLocalSelection
  )({
    adapter: deps.providerAdapter,
    binding: {
      agent: "openclaw",
      provider: input.provider as NativeLocalProviderAttachment["provider"],
      endpointUrl: runtime.endpointUrl,
      authMode: runtime.authMode,
      ...(input.provider === "compatible-endpoint" && input.inferenceApi === "openai-responses"
        ? { api: "openai-responses" as const }
        : {}),
      gatewayName: input.gatewayName,
      sandboxName: input.sandboxName,
    },
    credentialValue: runtime.credentialValue,
    ownedProxy: runtime.ownedProxy,
    readAuthority: deps.getNativeLocalProviderAuthority,
    writeAuthority: deps.setNativeLocalProviderAuthority,
  });
  // Local providers use the same injected credential name. Prepare first, then
  // remove old access before attaching the new provider to avoid a collision.
  await input.beforeAttach();
  await ensureNativeLocalProviderAttached({
    adapter: deps.providerAdapter,
    sandboxName: input.sandboxName,
    expected: input.selection.selected,
  });
}

export async function rollbackOpenClawLocalSwitch(input: {
  selection: OpenClawLocalSwitch;
  committed: boolean;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
  error: unknown;
}): Promise<unknown> {
  if (!input.selection.prepare || input.committed || !input.selection.selected) return input.error;
  try {
    await detachNativeLocalProvider({
      adapter: input.deps.providerAdapter,
      sandboxName: input.sandboxName,
      expected: input.selection.selected,
    });
    const result = await retireNativeLocalProvider({
      adapter: input.deps.providerAdapter,
      expected: input.selection.selected,
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      clearAuthority: input.deps.clearNativeLocalProviderAuthority,
    });
    if (result.status === "attached")
      throw new Error(
        "The failed local selection remains attached; retain its authority for repair.",
      );
  } catch (cleanupError) {
    return new InferenceSetError(
      `${input.error instanceof Error ? input.error.message : String(input.error)}\nLocal selection rollback failed for provider '${input.selection.selected.providerName}' (retained authority): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  return input.error;
}

export function openClawLocalProbeFields(
  nativeEndpointUrl?: string,
  selected?: NativeLocalProviderAttachment,
) {
  const endpointUrl = nativeEndpointUrl ?? selected?.endpointUrl;
  return {
    ...(endpointUrl ? { nativeEndpointUrl: endpointUrl } : {}),
    ...(selected ? { nativeLocalProviderAttachment: selected, agentName: "openclaw" } : {}),
  };
}

export function openClawLocalRegistryFields(
  selected?: NativeLocalProviderAttachment,
  previousDetached = false,
) {
  if (selected) return { nativeLocalProviderAttachment: selected };
  return previousDetached ? { nativeLocalProviderAttachment: undefined } : {};
}

export async function detachPreviousOpenClawLocal(input: {
  previous?: NativeLocalProviderAttachment;
  selected?: NativeLocalProviderAttachment;
  sandboxName: string;
  deps: InferenceSetDeps;
}): Promise<boolean> {
  if (!input.previous || input.previous.providerName === input.selected?.providerName) return false;
  await detachNativeLocalProvider({
    adapter: input.deps.providerAdapter,
    sandboxName: input.sandboxName,
    expected: input.previous,
  });
  return true;
}

export async function restorePreviousOpenClawLocal(input: {
  previous?: NativeLocalProviderAttachment;
  detached: boolean;
  committed: boolean;
  sandboxName: string;
  error: unknown;
  deps: InferenceSetDeps;
}): Promise<unknown> {
  if (!input.detached || input.committed || !input.previous) return input.error;
  try {
    await ensureNativeLocalProviderAttached({
      adapter: input.deps.providerAdapter,
      sandboxName: input.sandboxName,
      expected: input.previous,
    });
  } catch (reattachError) {
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const recoveryDetail =
      reattachError instanceof Error ? reattachError.message : String(reattachError);
    return new InferenceSetError(
      `${detail}\n  Native local provider access was detached before the failed switch, but restoring provider '${input.previous.providerName}' failed: ${recoveryDetail}. Retain this sandbox and its provider authority for repair.`,
      input.error instanceof InferenceSetError ? input.error.exitCode : 1,
    );
  }
  return input.error;
}

export async function retirePreviousOpenClawLocal(input: {
  previous?: NativeLocalProviderAttachment;
  detached: boolean;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
}): Promise<void> {
  if (!input.detached || !input.previous) return;
  const result = await retireNativeLocalProvider({
    adapter: input.deps.providerAdapter,
    expected: input.previous,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    clearAuthority: input.deps.clearNativeLocalProviderAuthority,
  });
  if (result.status === "attached") {
    throw new InferenceSetError(
      `OpenClaw sandbox '${input.sandboxName}' switched routes, but provider '${input.previous.providerName}' remains attached. Its exact cleanup authority was retained. Inspect its OpenShell attachments, then retry inference set for this sandbox to finish cleanup.`,
    );
  }
}

/** The gateway authority map preserves the exact detached provider after registry commit. */
export async function reconcilePreviousOpenClawLocal(input: {
  entry: SandboxEntry;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
}): Promise<void> {
  if (input.entry.agent !== "openclaw") return;
  const current = normalizeNativeLocalProviderAttachment(input.entry.nativeLocalProviderAttachment);
  const candidates =
    input.deps.listNativeLocalProviderAuthorities?.(input.sandboxName, input.gatewayName) ?? [];
  for (const previous of candidates) {
    if (current?.providerName === previous.providerName) continue;
    const result = await retireNativeLocalProvider({
      adapter: input.deps.providerAdapter,
      expected: previous,
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      clearAuthority: input.deps.clearNativeLocalProviderAuthority,
    });
    if (result.status === "attached") {
      throw new InferenceSetError(
        `OpenClaw sandbox '${input.sandboxName}' still has a pending provider cleanup for '${previous.providerName}'. Inspect its OpenShell attachments, then retry inference set for this sandbox. No new route was selected.`,
      );
    }
  }
}
