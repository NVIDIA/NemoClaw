// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedInferenceApiKey, NVIDIA_INFERENCE_PLACEHOLDER } from "../../inference-credential";
import type { InferenceSetDeps } from "../inference-set";
import type { ConfigObject } from "../../security/credential-filter";
import { nativeHostedAgentConfig } from "../../inference/native-provider/agent-config";
import { isSafeModelId } from "../../validation";
import { InferenceSetError } from "../inference-set-error";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import {
  fixedNativeProvider,
  fixedNativeProviderForAttachment,
} from "../../inference/native-provider/fixed";
import {
  normalizeNativeNvidiaProviderAttachment,
  isNativeNvidiaProvider,
} from "../../inference/native-nvidia";
import {
  hostedNativeProvider,
  usesNativeHermesEndpoint,
} from "../../inference/native-provider/hosted";
import { recordedNativeProviderAttachment } from "../../inference/native-provider/recorded-selection";
import type { SandboxEntry } from "../../state/registry";

export function isNativeInferenceSelection(
  provider: string,
  entry: SandboxEntry,
  endpointUrl: string | null | undefined,
  gatewayName: string,
  deps: InferenceSetDeps,
): boolean {
  if (!fixedNativeProvider(provider)) return false;
  if (provider !== "hermes-provider") return true;
  const authority =
    entry.provider === provider && entry.nativeHostedProviderAttachment
      ? recordedNativeProviderAttachment(entry)
      : deps.getNativeHostedProviderAuthority?.(gatewayName, provider);
  return usesNativeHermesEndpoint(
    endpointUrl ?? (entry.provider === provider ? entry.endpointUrl : undefined),
    authority,
  );
}

function nativeAuthorityAccess(provider: string, deps: InferenceSetDeps, endpointUrl?: string) {
  if (isNativeNvidiaProvider(provider))
    return {
      read: (gateway: string) => deps.getNativeNvidiaProviderAuthority?.(gateway),
      write: (gateway: string, receipt: NativeProviderAttachment) => {
        const normalized = normalizeNativeNvidiaProviderAttachment(receipt);
        if (!normalized) throw new InferenceSetError("Invalid NVIDIA provider authority");
        deps.setNativeNvidiaProviderAuthority(gateway, normalized);
      },
    };
  if (!deps.getNativeHostedProviderAuthority || !deps.setNativeHostedProviderAuthority) {
    throw new InferenceSetError("Native hosted provider ownership storage is unavailable");
  }
  const read = deps.getNativeHostedProviderAuthority;
  const write = deps.setNativeHostedProviderAuthority;
  return {
    read: (gateway: string) => read(gateway, provider, endpointUrl),
    write: (gateway: string, receipt: NativeProviderAttachment) =>
      write(gateway, provider, receipt),
  };
}

export function resolveNativeSelectionAuthority(input: {
  selectingNative: boolean;
  provider: string;
  gatewayName: string;
  previousAttachment?: NativeProviderAttachment;
  deps: InferenceSetDeps;
}): NativeProviderAttachment | undefined {
  if (!input.selectingNative) return undefined;
  const fixed = fixedNativeProvider(input.provider);
  if (!fixed) return undefined;
  const previous =
    input.previousAttachment &&
    fixedNativeProviderForAttachment(input.previousAttachment).logicalProvider === input.provider
      ? input.previousAttachment
      : undefined;
  const access = nativeAuthorityAccess(
    input.provider,
    input.deps,
    previous ? hostedNativeProvider(input.provider, previous.endpointUrl)?.endpoint : undefined,
  );
  const gatewayAuthority = access.read(input.gatewayName);
  const definition = previous
    ? fixedNativeProviderForAttachment(previous)
    : gatewayAuthority
      ? fixedNativeProviderForAttachment(gatewayAuthority)
      : fixed;
  return nativeProviderLifecycle(definition).resolveGatewayNativeProviderAuthority({
    gatewayName: input.gatewayName,
    gatewayAuthority:
      gatewayAuthority?.providerName === definition.providerName ? gatewayAuthority : undefined,
    recordedAttachment: previous,
  });
}

export function nativeSelectionRegistryFields(
  attachment: NativeProviderAttachment | undefined,
  previousDetached: boolean,
): Partial<SandboxEntry> {
  const departure = previousDetached
    ? { nativeNvidiaProviderAttachment: undefined, nativeHostedProviderAttachment: undefined }
    : {};
  if (!attachment) return departure;
  const nvidia = normalizeNativeNvidiaProviderAttachment(attachment);
  return {
    ...departure,
    ...(nvidia
      ? { nativeNvidiaProviderAttachment: nvidia }
      : {
          nativeHostedProviderAttachment: attachment,
          credentialEnv: fixedNativeProviderForAttachment(attachment).credentialEnv,
        }),
  };
}

export function assertNativeMigrationReady(input: {
  provider: string;
  previousProvider: string;
  previousAttachment?: NativeProviderAttachment;
  sandboxName: string;
}): void {
  if (
    isNativeNvidiaProvider(input.provider) &&
    input.provider === input.previousProvider &&
    !input.previousAttachment
  ) {
    throw new InferenceSetError(
      `Sandbox '${input.sandboxName}' predates native ${fixedNativeProvider(input.provider)?.label} provider attachments. Recreate this beta sandbox before changing its model.`,
      2,
    );
  }
}

export async function prepareNativeSelection(input: {
  selectingNative: boolean;
  provider: string;
  expectedAttachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  deps: InferenceSetDeps;
}): Promise<{
  attachment?: NativeProviderAttachment;
  attachmentChanged: boolean;
  endpointUrl?: string;
}> {
  if (!input.selectingNative) return { attachmentChanged: false };
  const definition = input.expectedAttachment
    ? fixedNativeProviderForAttachment(input.expectedAttachment)
    : fixedNativeProvider(input.provider);
  if (!definition) return { attachmentChanged: false };
  const lifecycle = nativeProviderLifecycle(definition);
  const authority = nativeAuthorityAccess(
    input.provider,
    input.deps,
    hostedNativeProvider(input.provider, definition.endpointUrl)?.endpoint,
  );
  const target = { kind: "named", gatewayName: input.gatewayName } as const;
  const ensured = await lifecycle.ensureNativeProvider({
    adapter: input.deps.providerAdapter,
    target,
    // Hosted model selection must not rotate a gateway-shared provider credential.
    // Hermes host credentials use NOUS_API_KEY; OPENAI_API_KEY is its injection slot.
    credentialValue:
      input.expectedAttachment && !isNativeNvidiaProvider(input.provider)
        ? null
        : input.deps.resolveCredentialValue(
            input.provider === "hermes-provider" ? "NOUS_API_KEY" : definition.credentialEnv,
          ) || null,
    ...(input.expectedAttachment ? { expected: input.expectedAttachment } : {}),
  });
  await lifecycle.persistNativeProviderAuthority({
    adapter: input.deps.providerAdapter,
    target,
    gatewayName: input.gatewayName,
    receipt: ensured,
    ...(input.expectedAttachment ? { existing: input.expectedAttachment } : {}),
    readAuthority: authority.read,
    writeAuthority: authority.write,
  });
  const attached = await lifecycle.ensureNativeProviderAttached({
    adapter: input.deps.providerAdapter,
    target,
    sandboxName: input.sandboxName,
    expected: ensured,
  });
  return {
    attachment: attached.receipt,
    attachmentChanged: attached.changed,
    endpointUrl: attached.receipt.endpointUrl,
  };
}

export async function rollbackNativeSelection(input: {
  attachmentChanged: boolean;
  registryCommitted: boolean;
  attachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  error: unknown;
  deps: InferenceSetDeps;
}): Promise<void> {
  if (!input.attachmentChanged || input.registryCommitted || !input.attachment) return;
  try {
    await nativeProviderLifecycle(
      fixedNativeProviderForAttachment(input.attachment),
    ).detachNativeProvider({
      adapter: input.deps.providerAdapter,
      target: { kind: "named", gatewayName: input.gatewayName },
      sandboxName: input.sandboxName,
      expected: input.attachment,
    });
  } catch (rollbackError) {
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const rollbackDetail =
      rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new InferenceSetError(`${detail}\n  ${rollbackDetail}`);
  }
}

export async function detachPreviousNativeBeforePublish(input: {
  selectingNative: boolean;
  selectedProvider: string;
  previousAttachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  deps: InferenceSetDeps;
}): Promise<boolean> {
  if (!input.previousAttachment) return false;
  const previous = fixedNativeProviderForAttachment(input.previousAttachment);
  if (input.selectingNative && input.selectedProvider === previous.logicalProvider) return false;
  await nativeProviderLifecycle(previous).detachNativeProvider({
    adapter: input.deps.providerAdapter,
    target: { kind: "named", gatewayName: input.gatewayName },
    sandboxName: input.sandboxName,
    expected: input.previousAttachment,
  });
  return true;
}

export async function restorePreviousNativeAfterFailedPublish(input: {
  detached: boolean;
  committed: boolean;
  previousAttachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  error: unknown;
  deps: InferenceSetDeps;
}): Promise<void> {
  if (!input.detached || input.committed || !input.previousAttachment) return;
  try {
    await nativeProviderLifecycle(
      fixedNativeProviderForAttachment(input.previousAttachment),
    ).ensureNativeProviderAttached({
      adapter: input.deps.providerAdapter,
      target: { kind: "named", gatewayName: input.gatewayName },
      sandboxName: input.sandboxName,
      expected: input.previousAttachment,
    });
  } catch (reattachError) {
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const recoveryDetail =
      reattachError instanceof Error ? reattachError.message : String(reattachError);
    throw new InferenceSetError(
      `${detail}\n  Native provider access was detached before the failed switch, but restoring the attachment failed: ${recoveryDetail}`,
      input.error instanceof InferenceSetError ? input.error.exitCode : 1,
    );
  }
}

export function nativeSelectionConfigCredentials(
  provider: string,
  baseUrl: string,
  existingApiKey: unknown,
  existingHeaders: ConfigObject,
) {
  const native = nativeHostedAgentConfig(provider, baseUrl);
  return {
    apiKey:
      native?.apiKey ??
      managedInferenceApiKey(
        baseUrl,
        typeof existingApiKey === "string" &&
          existingApiKey &&
          existingApiKey !== NVIDIA_INFERENCE_PLACEHOLDER
          ? existingApiKey
          : "unused",
      ),
    ...(native?.headers ? { headers: { ...existingHeaders, ...native.headers } } : {}),
  };
}

export function prepareNativeTransitionAuthority(input: {
  entry: SandboxEntry;
  provider: string;
  previousProvider: string;
  sandboxName: string;
  selectingNative: boolean;
  gatewayName: string;
  deps: InferenceSetDeps;
}) {
  const previousNativeAttachment = recordedNativeProviderAttachment(input.entry);
  assertNativeMigrationReady({ ...input, previousAttachment: previousNativeAttachment });
  const nativeProviderAuthority = resolveNativeSelectionAuthority({
    ...input,
    previousAttachment: previousNativeAttachment,
  });
  return { previousNativeAttachment, nativeProviderAuthority };
}

export function assertInferenceModelId(model: string): void {
  if (!isSafeModelId(model))
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
}
