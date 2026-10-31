// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireNativeProviderPolicy } from "../../adapters/openshell/provider-policy";
import { InferenceSetError } from "../inference-set-error";
import type { SandboxEntry } from "../../state/registry";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { resolveHermesLocalSwitchRuntime } from "../inference-set/local-runtime";
import {
  normalizeNativeLocalProviderAttachment,
  nativeLocalIdentity,
  usesNativeLocalInference,
  usesNativeLocalInferenceForAgent,
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
  provider: string;
  agentName?: string;
  gatewayName: string;
  sandboxName: string;
  previous?: NativeLocalProviderAttachment;
  binding: InferenceSetProviderBinding | null;
  adapter: OpenShellProviderAdapter;
  resolveCredentialValue: (name: string) => string;
  readAuthority?: Parameters<typeof prepareNativeLocalSelection>[0]["readAuthority"];
  writeAuthority?: Parameters<typeof prepareNativeLocalSelection>[0]["writeAuthority"];
}) {
  if (
    input.previous?.provider === input.provider &&
    !input.binding &&
    input.previous.profileId === nativeLocalIdentity(input.previous).profileId
  ) {
    return {
      ...(await ensureNativeLocalProviderAttached({
        adapter: input.adapter,
        expected: input.previous,
        sandboxName: input.sandboxName,
      })),
      previousDetached: false,
    };
  }
  const runtime = resolveHermesLocalSwitchRuntime(
    input.provider,
    input.binding,
    input.resolveCredentialValue,
  );
  const receipt = await prepareNativeLocalSelection({
    adapter: input.adapter,
    binding: {
      provider: input.provider as NativeLocalProvider,
      gatewayName: input.gatewayName,
      sandboxName: input.sandboxName,
      endpointUrl: runtime.endpointUrl,
      ...(input.agentName === "hermes" ? { agent: "hermes" as const } : {}),
      authMode: runtime.authMode,
    },
    credentialValue: runtime.credentialValue || null,
    ownedProxy: runtime.ownedProxy,
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
    if (previousDetached) {
      try {
        await ensureNativeLocalProviderAttached({
          adapter: input.adapter,
          sandboxName: input.sandboxName,
          expected: input.previous!,
        });
      } catch (restoreError) {
        throw nativeLocalRestorationFailure(error, restoreError);
      }
    }
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
  sandboxName: string;
  provider: string;
  endpointUrl?: string | null;
  gatewayName: string;
  requirePolicy?: typeof requireNativeProviderPolicy;
}) {
  const selectingNativeLocal = usesNativeLocalInferenceForAgent(
    "hermes",
    input.provider,
    input.endpointUrl ?? (input.entry.provider === input.provider ? input.entry.endpointUrl : null),
    Boolean(input.entry.nimContainer),
  );
  const previous = normalizeNativeLocalProviderAttachment(
    input.entry.nativeLocalProviderAttachment,
  );
  if (
    input.entry.nativeLocalProviderAttachment !== undefined &&
    (!previous ||
      input.entry.name !== input.sandboxName ||
      previous.sandboxName !== input.sandboxName ||
      previous.gatewayName !== input.gatewayName ||
      previous.provider !== input.entry.provider)
  ) {
    throw new InferenceSetError(
      "The recorded local provider attachment does not match this sandbox's selection. Recreate this beta sandbox before changing its inference selection.",
      2,
    );
  }
  if (input.entry.agent === "hermes" && previous && previous.agent !== "hermes") {
    throw new InferenceSetError(
      "The recorded local provider does not authorize Hermes. Recreate this beta sandbox before changing its inference selection.",
      2,
    );
  }
  if (
    selectingNativeLocal &&
    usesNativeLocalInference(input.entry.provider, input.entry.endpointUrl) &&
    !previous
  ) {
    throw new InferenceSetError(
      "Recreate this beta sandbox before changing its native local inference selection.",
      2,
    );
  }
  if (selectingNativeLocal)
    await (input.requirePolicy ?? requireNativeProviderPolicy)(input.gatewayName);
  return { previous, selectingNativeLocal };
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
    try {
      await ensureNativeLocalProviderAttached({
        adapter: input.adapter,
        sandboxName: input.sandboxName,
        expected: input.previous,
      });
    } catch (restoreError) {
      throw nativeLocalRestorationFailure(error, restoreError);
    }
    throw error;
  }
  return true;
}

function nativeLocalRestorationFailure(original: unknown, restoration: unknown): Error {
  const originalDetail = original instanceof Error ? original.message : String(original);
  const restorationDetail =
    restoration instanceof Error ? restoration.message : String(restoration);
  return new Error(
    `${originalDetail}\n  Restoring the previous native local provider attachment also failed: ${restorationDetail}`,
    { cause: new AggregateError([original, restoration]) },
  );
}

export function nativeLocalSelectionRegistryFields(
  attachment: NativeLocalProviderAttachment | undefined,
  previousDetached: boolean,
) {
  if (attachment) return { nativeLocalProviderAttachment: attachment };
  return previousDetached ? { nativeLocalProviderAttachment: undefined } : {};
}
