// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";

export const NVIDIA_HOSTED_LOGICAL_PROVIDER = "nvidia-prod";
export const NVIDIA_HOSTED_NATIVE_ENDPOINT = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_HOSTED_NATIVE_PROFILE_ID = "nemoclaw-nvidia-inference-v1";
export const NVIDIA_HOSTED_NATIVE_PROVIDER = "nemoclaw-nvidia-prod-v1";
export const NVIDIA_HOSTED_CREDENTIAL_ENV = "NVIDIA_INFERENCE_API_KEY";

export type NativeNvidiaProviderAttachment = Readonly<{
  schemaVersion: 1;
  profileId: typeof NVIDIA_HOSTED_NATIVE_PROFILE_ID;
  providerName: typeof NVIDIA_HOSTED_NATIVE_PROVIDER;
  providerId: string;
}>;

export class NativeNvidiaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeNvidiaProviderError";
  }
}

export function nativeNvidiaProviderProfilePath(root = REPOSITORY_ROOT): string {
  return path.join(
    root,
    "managed-inference",
    "provider-profiles",
    `${NVIDIA_HOSTED_NATIVE_PROFILE_ID}.yaml`,
  );
}

export function isNativeNvidiaProvider(provider: string | null | undefined): boolean {
  return provider?.trim() === NVIDIA_HOSTED_LOGICAL_PROVIDER;
}

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return isNativeNvidiaProvider(normalized) ? NVIDIA_HOSTED_NATIVE_PROVIDER : normalized;
}

export function normalizeNativeNvidiaProviderAttachment(
  value: unknown,
): NativeNvidiaProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profileId !== NVIDIA_HOSTED_NATIVE_PROFILE_ID ||
    receipt.providerName !== NVIDIA_HOSTED_NATIVE_PROVIDER ||
    typeof receipt.providerId !== "string" ||
    !receipt.providerId.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    providerId: receipt.providerId,
  };
}

function providerErrorDetail(error: OpenShellProviderError): string {
  return error.message.trim() || "OpenShell did not provide a diagnostic.";
}

function exactNativeProvider(metadata: OpenShellProviderMetadata): boolean {
  return (
    metadata.name === NVIDIA_HOSTED_NATIVE_PROVIDER &&
    metadata.type === NVIDIA_HOSTED_NATIVE_PROFILE_ID &&
    metadata.configKeys.length === 0 &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === NVIDIA_HOSTED_CREDENTIAL_ENV &&
    Boolean(metadata.revision?.id)
  );
}

function attachmentFromMetadata(
  metadata: OpenShellProviderMetadata,
): NativeNvidiaProviderAttachment {
  if (!exactNativeProvider(metadata) || !metadata.revision) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' does not match the NemoClaw-owned NVIDIA inference boundary. No provider was changed.`,
    );
  }
  return {
    schemaVersion: 1,
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    providerId: metadata.revision.id,
  };
}

async function inspectNativeProvider(
  adapter: OpenShellProviderAdapter,
  target: OpenShellGatewayTarget,
): Promise<OpenShellProviderMetadata | null> {
  const observed = await adapter.getProvider({
    target,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  });
  if (observed.ok) return observed.value;
  if (observed.error.kind === "command" && observed.error.reason === "not_found") return null;
  throw new NativeNvidiaProviderError(
    `Could not inspect OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}': ${providerErrorDetail(observed.error)}`,
  );
}

function mutationOutcomeMayBeAmbiguous(error: OpenShellProviderError): boolean {
  return (
    error.kind === "timeout" ||
    (error.kind === "transport" &&
      (error.reason === "connection_loss" || error.reason === "unreachable")) ||
    (error.kind === "command" && error.reason === "uncertain")
  );
}

/** Ensure the least-privilege NVIDIA profile and provider without retrying an ambiguous mutation. */
export async function ensureNativeNvidiaProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  credentialValue: string | null;
  reuseExistingCredential?: boolean;
  expected?: NativeNvidiaProviderAttachment;
  profilePath?: string;
}): Promise<NativeNvidiaProviderAttachment> {
  const { adapter, target } = input;
  const imported = await adapter.importProviderProfile({
    target,
    profilePath: input.profilePath ?? nativeNvidiaProviderProfilePath(),
  });
  if (!imported.ok) {
    const collision =
      imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
    throw new NativeNvidiaProviderError(
      collision
        ? `OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
        : `Could not prepare OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}': ${providerErrorDetail(imported.error)}`,
    );
  }

  const before = await inspectNativeProvider(adapter, target);
  if (before) {
    const receipt = attachmentFromMetadata(before);
    if (input.expected && input.expected.providerId !== receipt.providerId) {
      throw new NativeNvidiaProviderError(
        `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' changed identity. Recreate the sandbox before using native NVIDIA inference. No provider was changed.`,
      );
    }
    if (!input.credentialValue) return receipt;
    const updated = await adapter.updateProvider({
      target,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      credentials: [{ name: NVIDIA_HOSTED_CREDENTIAL_ENV, value: input.credentialValue }],
      config: [],
    });
    if (!updated.ok && !mutationOutcomeMayBeAmbiguous(updated.error)) {
      throw new NativeNvidiaProviderError(
        `Could not update OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}': ${providerErrorDetail(updated.error)}`,
      );
    }
    const observed = await inspectNativeProvider(adapter, target);
    if (!observed) {
      throw new NativeNvidiaProviderError(
        `OpenShell did not confirm provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' after its credential update.`,
      );
    }
    return attachmentFromMetadata(observed);
  }

  if (!input.credentialValue && !input.reuseExistingCredential) {
    throw new NativeNvidiaProviderError(
      `A host credential is required to create OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}'.`,
    );
  }
  const created = await adapter.createProvider({
    target,
    name: NVIDIA_HOSTED_NATIVE_PROVIDER,
    type: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    credentials: input.credentialValue
      ? [{ name: NVIDIA_HOSTED_CREDENTIAL_ENV, value: input.credentialValue }]
      : [],
    config: [],
    fromExisting: !input.credentialValue,
  });
  if (!created.ok && !mutationOutcomeMayBeAmbiguous(created.error)) {
    throw new NativeNvidiaProviderError(
      `Could not create OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}': ${providerErrorDetail(created.error)}`,
    );
  }
  const observed = await inspectNativeProvider(adapter, target);
  if (!observed) {
    throw new NativeNvidiaProviderError(
      `OpenShell did not confirm provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' after creation.`,
    );
  }
  return attachmentFromMetadata(observed);
}

/** Prove that the exact NemoClaw-owned NVIDIA provider is attached to one sandbox. */
export async function verifyNativeNvidiaProviderAttachment(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected?: NativeNvidiaProviderAttachment;
}): Promise<NativeNvidiaProviderAttachment> {
  const provider = await inspectNativeProvider(input.adapter, input.target);
  if (!provider) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' is missing. Recreate the sandbox to restore native NVIDIA inference.`,
    );
  }
  const receipt = attachmentFromMetadata(provider);
  if (input.expected && input.expected.providerId !== receipt.providerId) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' changed identity. Recreate the sandbox before using native NVIDIA inference.`,
    );
  }
  const attachments = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!attachments.ok) {
    throw new NativeNvidiaProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(attachments.error)}`,
    );
  }
  if (!attachments.value.names.includes(NVIDIA_HOSTED_NATIVE_PROVIDER)) {
    throw new NativeNvidiaProviderError(
      `Sandbox '${input.sandboxName}' does not have its native NVIDIA inference provider attached. Recreate the sandbox; NemoClaw does not migrate existing beta sandboxes automatically.`,
    );
  }
  return receipt;
}

/** Attach native NVIDIA access and reconcile an ambiguous command through observation. */
export async function ensureNativeNvidiaProviderAttached(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeNvidiaProviderAttachment;
}): Promise<{ receipt: NativeNvidiaProviderAttachment; changed: boolean }> {
  const before = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!before.ok) {
    throw new NativeNvidiaProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(before.error)}`,
    );
  }
  if (before.value.names.includes(NVIDIA_HOSTED_NATIVE_PROVIDER)) {
    return {
      receipt: await verifyNativeNvidiaProviderAttachment(input),
      changed: false,
    };
  }
  const attached = await input.adapter.attachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  });
  if (!attached.ok && !mutationOutcomeMayBeAmbiguous(attached.error)) {
    throw new NativeNvidiaProviderError(
      `Could not attach native NVIDIA provider to sandbox '${input.sandboxName}': ${providerErrorDetail(attached.error)}`,
    );
  }
  try {
    return {
      receipt: await verifyNativeNvidiaProviderAttachment(input),
      changed: true,
    };
  } catch (error) {
    try {
      await detachNativeNvidiaProvider(input);
    } catch (detachError) {
      const detail = error instanceof Error ? error.message : String(error);
      const detachDetail = detachError instanceof Error ? detachError.message : String(detachError);
      throw new NativeNvidiaProviderError(`${detail}\n  ${detachDetail}`);
    }
    throw error;
  }
}

/** Detach only the recorded native NVIDIA provider identity and prove absence. */
export async function detachNativeNvidiaProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeNvidiaProviderAttachment;
}): Promise<void> {
  const provider = await inspectNativeProvider(input.adapter, input.target);
  if (!provider) return;
  const current = attachmentFromMetadata(provider);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeNvidiaProviderError(
      `Refusing to detach OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' because its identity changed.`,
    );
  }
  const detached = await input.adapter.detachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  });
  if (!detached.ok && !mutationOutcomeMayBeAmbiguous(detached.error)) {
    throw new NativeNvidiaProviderError(
      `Could not detach native NVIDIA provider from sandbox '${input.sandboxName}': ${providerErrorDetail(detached.error)}`,
    );
  }
  const after = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!after.ok || after.value.names.includes(NVIDIA_HOSTED_NATIVE_PROVIDER)) {
    throw new NativeNvidiaProviderError(
      `OpenShell did not confirm removal of native NVIDIA access from sandbox '${input.sandboxName}'.`,
    );
  }
}
