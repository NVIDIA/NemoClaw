// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireNativeProviderPolicy } from "../../adapters/openshell/provider-policy";
import { InferenceSetError } from "../inference-set-error";
import type { SandboxEntry } from "../../state/registry";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_GATEWAY_BASE_URL,
} from "../../inference/llama-cpp/contract";
import { getOllamaProxyToken } from "../../inference/ollama/proxy";
import {
  normalizeNativeLocalProviderAttachment,
  usesNativeLocalInference,
  type NativeLocalProvider,
  type NativeLocalProviderAttachment,
} from "../../inference/native-local/contract";
import {
  ensureNativeLocalProviderAttached,
  detachNativeLocalProvider,
} from "../../inference/native-local/profile";
import { prepareNativeLocalSelection } from "../../inference/native-local/selection";
import type { InferenceSetProviderBinding } from "../inference-set-route-containment";

export async function prepareNativeLocalSwitch(input: {
  local: Pick<
    typeof import("../../inference/local"),
    "getLocalProviderBaseUrl" | "getManagedVllmProviderBinding" | "shouldFrontOllamaWithProxy"
  >;
  provider: string;
  gatewayName: string;
  sandboxName: string;
  previous?: NativeLocalProviderAttachment;
  binding: InferenceSetProviderBinding | null;
  adapter: OpenShellProviderAdapter;
  resolveCredentialValue: (name: string) => string;
  readAuthority?: Parameters<typeof prepareNativeLocalSelection>[0]["readAuthority"];
  writeAuthority?: Parameters<typeof prepareNativeLocalSelection>[0]["writeAuthority"];
}) {
  if (input.previous?.provider === input.provider && !input.binding) {
    return {
      ...(await ensureNativeLocalProviderAttached({
        adapter: input.adapter,
        expected: input.previous,
        sandboxName: input.sandboxName,
      })),
      previousDetached: false,
    };
  }
  const vllm = input.provider === "vllm-local" ? input.local.getManagedVllmProviderBinding() : null;
  const proxy = input.provider === "ollama-local" && input.local.shouldFrontOllamaWithProxy();
  const endpointUrl =
    input.binding?.baseUrl ??
    vllm?.baseUrl ??
    (input.provider === "llama-cpp-local"
      ? LLAMA_CPP_GATEWAY_BASE_URL
      : input.local.getLocalProviderBaseUrl(input.provider));
  if (!endpointUrl)
    throw new Error("The local inference endpoint is unavailable. Run onboarding to qualify it.");
  const credentialValue =
    input.binding?.token ??
    vllm?.apiKey ??
    (input.provider === "ollama-local"
      ? proxy
        ? getOllamaProxyToken()
        : "ollama"
      : input.provider === "vllm-local"
        ? "dummy"
        : input.resolveCredentialValue(LLAMA_CPP_CREDENTIAL_ENV));
  const receipt = await prepareNativeLocalSelection({
    adapter: input.adapter,
    binding: {
      provider: input.provider as NativeLocalProvider,
      gatewayName: input.gatewayName,
      sandboxName: input.sandboxName,
      endpointUrl,
      authMode:
        !input.binding && !vllm && !proxy && input.provider !== "llama-cpp-local"
          ? "sentinel"
          : "authenticated",
    },
    credentialValue: credentialValue || null,
    ownedProxy: proxy,
    readAuthority: input.readAuthority,
    writeAuthority: input.writeAuthority,
  });
  const previousDetached = Boolean(
    input.previous && input.previous.providerName !== receipt.providerName,
  );
  try {
    if (previousDetached)
      await detachNativeLocalProvider({
        adapter: input.adapter,
        sandboxName: input.sandboxName,
        expected: input.previous!,
      });
    const attached = await ensureNativeLocalProviderAttached({
      adapter: input.adapter,
      expected: receipt,
      sandboxName: input.sandboxName,
    });
    return { ...attached, previousDetached };
  } catch (error) {
    const observed = await input.adapter.listProviderAttachments({
      target: { kind: "named", gatewayName: input.gatewayName },
      sandboxName: input.sandboxName,
    });
    if (!observed.ok || observed.value.names.includes(receipt.providerName))
      throw new Error(
        "Native attachment failure could not be reconciled. Provider ownership was retained; inspect sandbox attachments before retrying.",
        { cause: error },
      );
    if (previousDetached)
      await ensureNativeLocalProviderAttached({
        adapter: input.adapter,
        sandboxName: input.sandboxName,
        expected: input.previous!,
      });
    throw error;
  }
}

/** Observe durable selection before compensating a failed provider replacement. */
export async function rollbackNativeLocalSelection(input: {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  provider: string;
  attachment?: NativeLocalProviderAttachment;
  previous?: NativeLocalProviderAttachment;
  attachmentChanged: boolean;
  registryCommitted: boolean;
  previousDetached: boolean;
  previousDetachCommitted: boolean;
  getSandbox: typeof import("../../state/registry").getSandbox;
}): Promise<void> {
  if (!input.attachment && !input.previous) return;
  const entry = input.getSandbox(input.sandboxName);
  const recorded = normalizeNativeLocalProviderAttachment(entry?.nativeLocalProviderAttachment);
  if (entry?.nativeLocalProviderAttachment !== undefined && !recorded) {
    throw new Error(
      "Malformed native local provider attachment; compensation requires valid authority.",
    );
  }
  const committed =
    input.registryCommitted ||
    Boolean(
      recorded &&
      recorded.providerId === input.attachment?.providerId &&
      recorded.providerName === input.attachment?.providerName,
    );
  const previousDetachCommitted =
    input.previousDetachCommitted ||
    committed ||
    (input.previousDetached &&
      !input.attachment &&
      entry?.provider === input.provider &&
      entry.nativeLocalProviderAttachment === undefined);
  if (input.attachmentChanged && !committed && input.attachment) {
    await detachNativeLocalProvider({
      adapter: input.adapter,
      sandboxName: input.sandboxName,
      expected: input.attachment,
    });
  }
  if (input.previousDetached && !previousDetachCommitted && input.previous) {
    await ensureNativeLocalProviderAttached({
      adapter: input.adapter,
      sandboxName: input.sandboxName,
      expected: input.previous,
    });
  }
}

export async function prepareNativeLocalSelectionBoundary(input: {
  entry: SandboxEntry;
  selectingNativeLocal: boolean;
  gatewayName: string;
  requirePolicy?: typeof requireNativeProviderPolicy;
}) {
  if (input.selectingNativeLocal)
    await (input.requirePolicy ?? requireNativeProviderPolicy)(input.gatewayName);
  const previous = normalizeNativeLocalProviderAttachment(
    input.entry.nativeLocalProviderAttachment,
  );
  if (
    input.selectingNativeLocal &&
    usesNativeLocalInference(input.entry.provider, input.entry.endpointUrl) &&
    !previous
  ) {
    throw new InferenceSetError(
      "Recreate this beta sandbox before changing its native local inference selection.",
      2,
    );
  }
  return previous;
}

export async function detachPreviousNativeLocalBeforePublish(input: {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  detached: boolean;
  previous?: NativeLocalProviderAttachment;
  next?: NativeLocalProviderAttachment;
}): Promise<boolean> {
  if (input.detached || !input.previous || input.previous.providerName === input.next?.providerName)
    return input.detached;
  try {
    await detachNativeLocalProvider({
      adapter: input.adapter,
      sandboxName: input.sandboxName,
      expected: input.previous,
    });
  } catch (error) {
    await ensureNativeLocalProviderAttached({
      adapter: input.adapter,
      sandboxName: input.sandboxName,
      expected: input.previous,
    });
    throw error;
  }
  return true;
}

export function nativeLocalSelectionRegistryFields(
  attachment: NativeLocalProviderAttachment | undefined,
  previousDetached: boolean,
) {
  if (attachment) return { nativeLocalProviderAttachment: attachment };
  return previousDetached ? { nativeLocalProviderAttachment: undefined } : {};
}
