// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceSetDeps } from "../inference-set";
import { InferenceSetError } from "../inference-set-error";
import { isLocalInferenceProvider } from "../../inference/native-local/agent-config";
import {
  detachNativeLocalProvider,
  ensureNativeLocalProviderAttached,
  normalizeNativeLocalProviderAttachment,
  retireNativeLocalProvider,
  type NativeLocalProviderAttachment,
  verifyNativeLocalProviderAttachment,
} from "../../inference/native-local/profile";
import type { SandboxEntry } from "../../state/registry";

/** A live switch can reuse only the sandbox's own recorded local provider. */
export async function resolveOpenClawLocalSwitch(input: {
  agentName: string;
  entry: SandboxEntry;
  provider: string;
  sandboxName: string;
  gatewayName: string;
  deps: InferenceSetDeps;
}): Promise<{
  selected?: NativeLocalProviderAttachment;
  previous?: NativeLocalProviderAttachment;
}> {
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
  if (!isLocalInferenceProvider(provider) || entry.nimContainer) return { previous };
  // A retained OpenClaw row may still own the historical shared route.
  if (!previous && entry.provider === provider) return {};
  if (!previous || entry.provider !== provider) {
    throw new InferenceSetError(
      `Cannot switch '${sandboxName}' to native local '${provider}' without a matching sandbox-owned provider attachment. Back up the sandbox and create a fresh one with that local selection. The shared gateway route was not changed.`,
      2,
    );
  }
  return { selected: previous, previous };
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
  deps: InferenceSetDeps;
}): Promise<void> {
  if (!input.detached || input.committed || !input.previous) return;
  await ensureNativeLocalProviderAttached({
    adapter: input.deps.providerAdapter,
    sandboxName: input.sandboxName,
    expected: input.previous,
  });
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
