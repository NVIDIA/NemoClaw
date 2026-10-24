// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeLocalCredentialReference } from "../../inference/native-local/model-router";
export {
  nativeModelRouterEndpoint,
  isModelRouterProvider,
} from "../../inference/native-local/model-router";
export { withRoutedInferencePortLock } from "../../onboard/routed-inference";
import { managedInferenceApiKey, NVIDIA_INFERENCE_PLACEHOLDER } from "../../inference-credential";
import type { InferenceSetDeps } from "../inference-set";
import type { ConfigObject } from "../../security/credential-filter";
import { nativeHostedAgentConfig } from "../../inference/native-provider/agent-config";
import {
  isLocalInferenceProvider,
  usesNativeLocalInference,
} from "../../inference/native-local/eligibility";
import { normalizeNativeLocalProviderAttachment } from "../../inference/native-local/profile";
export { isLocalInferenceProvider };
export {
  resolveOpenClawLocalSwitch,
  prepareOpenClawLocalSwitch,
  rollbackOpenClawLocalSwitch,
  detachPreviousOpenClawLocal,
  restorePreviousOpenClawLocal,
  retirePreviousOpenClawLocal,
  openClawLocalProbeFields,
  openClawLocalRegistryFields,
} from "./native-local";
export {
  getNativeLocalProviderAuthority,
  setNativeLocalProviderAuthority,
  clearNativeLocalProviderAuthority,
  listNativeLocalProviderAuthorities,
} from "../../state/registry/native-local-provider-authority";
export { reconcilePreviousOpenClawLocal } from "./native-local";
export {
  resolveLocalSwitchRuntime,
  verifyNimSwitchSelection,
  validateLocalProvider,
  type ValidationResult,
} from "./local-runtime";
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
  HOSTED_NATIVE_PROVIDERS,
  usesNativeHermesEndpoint,
  isCustomHostedProvider,
  customNativeCredentialEnv,
} from "../../inference/native-provider/hosted";
import { recordedNativeProviderAttachment } from "../../inference/native-provider/recorded-selection";
import type { SandboxEntry } from "../../state/registry";
import { prepareCustomNativeProvider } from "../../inference/native-provider/custom-setup";
import { isCustomNativeEndpoint } from "../../inference/native-provider/custom";
import { prepareHostedNativeProvider } from "../../inference/native-provider/setup";

/** Preserve shared-route config unless a custom native endpoint is explicit. */
export function usesNativeConfigByDefault(provider: string, nativeEndpointUrl?: string): boolean {
  return !isCustomHostedProvider(provider) || Boolean(nativeEndpointUrl);
}

export function isNativeInferenceSelection(
  provider: string,
  entry: SandboxEntry,
  endpointUrl: string | null | undefined,
  gatewayName: string,
  deps: InferenceSetDeps,
): boolean {
  if (isCustomHostedProvider(provider)) {
    const endpoint = endpointUrl ?? (entry.provider === provider ? entry.endpointUrl : undefined);
    const local = normalizeNativeLocalProviderAttachment(entry.nativeLocalProviderAttachment);
    const nativeLocal =
      local &&
      local.gatewayName === gatewayName &&
      local.sandboxName === entry.name &&
      local.provider === entry.provider &&
      (local.agent ?? "langchain-deepagents-code") === entry.agent;
    if (!endpoint || (!recordedNativeProviderAttachment(entry) && !nativeLocal)) return false;
    return isCustomNativeEndpoint(provider, endpoint);
  }
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
  endpointUrl?: string | null;
  deps: InferenceSetDeps;
}): NativeProviderAttachment | undefined {
  if (!input.selectingNative) return undefined;
  if (isCustomHostedProvider(input.provider))
    return input.previousAttachment?.custom?.provider === input.provider
      ? input.previousAttachment
      : undefined;
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
    input.provider === "hermes-provider"
      ? hostedNativeProvider(input.provider, input.endpointUrl ?? previous?.endpointUrl)?.endpoint
      : undefined,
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
          credentialEnv:
            attachment.custom?.credentialEnv ??
            fixedNativeProviderForAttachment(attachment).credentialEnv,
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
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
  beforeAttach?: (receipt: NativeProviderAttachment) => Promise<void>;
  deps: InferenceSetDeps;
}): Promise<{
  attachment?: NativeProviderAttachment;
  attachmentChanged: boolean;
  endpointUrl?: string;
}> {
  if (!input.selectingNative) return { attachmentChanged: false };
  if (isCustomHostedProvider(input.provider)) {
    if (
      !input.deps.getNativeHostedProviderAuthority ||
      !input.deps.setNativeHostedProviderAuthority
    )
      throw new InferenceSetError("Native hosted provider ownership storage is unavailable");
    const credentialEnv = input.credentialEnv || customNativeCredentialEnv(input.provider);
    const receipt = await prepareCustomNativeProvider({
      gatewayName: input.gatewayName,
      provider: input.provider,
      endpointUrl: input.endpointUrl || "",
      api:
        input.inferenceApi ||
        (input.provider === "compatible-anthropic-endpoint"
          ? "anthropic-messages"
          : "openai-completions"),
      credentialEnv,
      credentialValue: input.deps.resolveCredentialValue(credentialEnv) || null,
      adapter: input.deps.providerAdapter,
      recordedAttachment: input.expectedAttachment,
      recordedSandboxName: input.sandboxName,
      readAuthority: input.deps.getNativeHostedProviderAuthority,
      writeAuthority: input.deps.setNativeHostedProviderAuthority,
    });
    await input.beforeAttach?.(receipt);
    const attached = await nativeProviderLifecycle(
      fixedNativeProviderForAttachment(receipt),
    ).ensureNativeProviderAttached({
      adapter: input.deps.providerAdapter,
      target: { kind: "named", gatewayName: input.gatewayName },
      sandboxName: input.sandboxName,
      expected: receipt,
    });
    return {
      attachment: attached.receipt,
      attachmentChanged: attached.changed,
      endpointUrl: receipt.endpointUrl,
    };
  }
  if (
    input.provider === "hermes-provider" &&
    (input.endpointUrl || input.expectedAttachment?.endpointUrl)
  ) {
    if (
      !input.deps.getNativeHostedProviderAuthority ||
      !input.deps.setNativeHostedProviderAuthority
    )
      throw new InferenceSetError("Native hosted provider ownership storage is unavailable");
    if (input.inferenceApi && input.inferenceApi !== "openai-completions")
      throw new InferenceSetError("Hermes Provider requires its recorded Chat Completions API");
    const receipt = await prepareHostedNativeProvider({
      provider: input.provider,
      gatewayName: input.gatewayName,
      endpointUrl: input.endpointUrl ?? input.expectedAttachment?.endpointUrl,
      retainedHermesEndpoint: true,
      adapter: input.deps.providerAdapter,
      credentialValue: input.expectedAttachment
        ? null
        : input.deps.resolveCredentialValue("NOUS_API_KEY") || null,
      reuseExistingCredential: Boolean(input.expectedAttachment),
      recordedSandbox: input.deps.getSandbox(input.sandboxName),
      readAuthority: input.deps.getNativeHostedProviderAuthority,
      writeAuthority: input.deps.setNativeHostedProviderAuthority,
    });
    await input.beforeAttach?.(receipt);
    const attached = await nativeProviderLifecycle(
      fixedNativeProviderForAttachment(receipt),
    ).ensureNativeProviderAttached({
      adapter: input.deps.providerAdapter,
      target: { kind: "named", gatewayName: input.gatewayName },
      sandboxName: input.sandboxName,
      expected: receipt,
    });
    return {
      attachment: attached.receipt,
      attachmentChanged: attached.changed,
      endpointUrl: receipt.endpointUrl,
    };
  }
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
    ...(input.expectedAttachment && !authority.read(input.gatewayName)
      ? { recordedSandboxName: input.sandboxName }
      : {}),
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
  selectedAttachment?: NativeProviderAttachment;
  previousAttachment?: NativeProviderAttachment;
  gatewayName: string;
  sandboxName: string;
  deps: InferenceSetDeps;
}): Promise<boolean> {
  if (!input.previousAttachment) return false;
  const previous = fixedNativeProviderForAttachment(input.previousAttachment);
  if (
    input.selectingNative &&
    (input.selectedAttachment
      ? input.selectedAttachment.providerName === input.previousAttachment.providerName
      : !input.previousAttachment.custom && input.selectedProvider === previous.logicalProvider)
  )
    return false;
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
  const local = usesNativeLocalInference(provider, baseUrl)
    ? nativeLocalCredentialReference(provider, baseUrl)
    : null;
  const native = local ? undefined : nativeHostedAgentConfig(provider, baseUrl);
  return {
    apiKey:
      local ??
      native?.apiKey ??
      managedInferenceApiKey(
        baseUrl,
        typeof existingApiKey === "string" &&
          existingApiKey &&
          existingApiKey !== NVIDIA_INFERENCE_PLACEHOLDER &&
          !/^openshell:resolve:env:(?:(?:v[0-9]{1,20}|s[a-f0-9]{64})_)?NEMOCLAW_LOCAL_INFERENCE_TOKEN$/u.test(
            existingApiKey,
          )
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
  endpointUrl?: string | null;
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

/** Keep owned resource names on their existing logical-provider lifecycle. */
export function canonicalOwnedInferenceProviderName(name: string): string {
  if (name === fixedNativeProvider("nvidia-prod")!.providerName) return "nvidia-prod";
  const fixed = HOSTED_NATIVE_PROVIDERS.find((definition) => definition.providerName === name);
  if (fixed) return fixed.logicalProvider;
  if (
    /^nemoclaw-(?:local-v1-[a-f0-9]{24}|custom-[a-f0-9]{32}-v1|hermes-[a-f0-9]{20}-v1)$/u.test(name)
  )
    throw new InferenceSetError(
      "Use the recorded logical provider name for this NemoClaw-owned attachment",
      2,
    );
  return name;
}

export {
  attachRegisteredInferenceProvider,
  detachRegisteredInferenceProvider,
  verifyRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
  recordedRegisteredInferenceProviderAttachment,
  type RegisteredInferenceProviderAttachment,
} from "./registered";
export {
  resolveRegisteredSelection,
  readRegisteredInferenceCredentialHandle,
  readVerifiedRegisteredCredentialHandle,
  detachPreviousRegisteredSelection,
  rollbackRegisteredSelection,
  restorePreviousRegisteredSelection,
} from "./registered";
