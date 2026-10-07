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
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "./contract";

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

export function resolveGatewayNativeNvidiaProviderAuthority(input: {
  gatewayName: string;
  gatewayAuthority?: NativeNvidiaProviderAttachment | null;
  recordedAttachment?: NativeNvidiaProviderAttachment | null;
}): NativeNvidiaProviderAttachment | undefined {
  const authorities = new Map<string, NativeNvidiaProviderAttachment>();
  for (const receipt of [input.gatewayAuthority, input.recordedAttachment]) {
    if (receipt) authorities.set(receipt.providerId, receipt);
  }
  if (authorities.size > 1) {
    throw new NativeNvidiaProviderError(
      `Gateway '${input.gatewayName}' has conflicting native NVIDIA provider ownership receipts. No provider was changed.`,
    );
  }
  return authorities.values().next().value;
}

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return isNativeNvidiaProvider(normalized) ? NVIDIA_HOSTED_NATIVE_PROVIDER : normalized;
}

function providerErrorDetail(error: OpenShellProviderError): string {
  return error.message.trim() || "OpenShell did not provide a diagnostic.";
}

async function requireNativeNvidiaProviderProfileBoundary(
  adapter: OpenShellProviderAdapter,
  target: OpenShellGatewayTarget,
  profilePath = nativeNvidiaProviderProfilePath(),
): Promise<void> {
  const imported = await adapter.importProviderProfile({ target, profilePath });
  if (imported.ok) return;
  const collision =
    imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
  throw new NativeNvidiaProviderError(
    collision
      ? `OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
      : `Could not verify OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}': ${providerErrorDetail(imported.error)}`,
  );
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

function authorityPersistenceRecovery(gatewayName: string): string {
  return `Run 'nemoclaw credentials reset ${NVIDIA_HOSTED_LOGICAL_PROVIDER} --yes' against gateway '${gatewayName}', then retry.`;
}

async function removeNewNativeNvidiaProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  expected: NativeNvidiaProviderAttachment;
}): Promise<void> {
  const provider = await inspectNativeProvider(input.adapter, input.target);
  if (!provider) return;
  const current = attachmentFromMetadata(provider);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeNvidiaProviderError(
      `Refusing to remove OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' because its identity changed.`,
    );
  }
  const removed = await input.adapter.deleteProvider({
    target: input.target,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  });
  if (!removed.ok && !mutationOutcomeMayBeAmbiguous(removed.error)) {
    throw new NativeNvidiaProviderError(
      `Could not remove OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}': ${providerErrorDetail(removed.error)}`,
    );
  }
  const after = await inspectNativeProvider(input.adapter, input.target);
  if (after) {
    const observed = attachmentFromMetadata(after);
    const identity =
      observed.providerId === input.expected.providerId ? "still exists" : "changed identity";
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' ${identity} after cleanup.`,
    );
  }
}

/** Record provider authority or remove only the new, unreferenced provider. */
export async function persistNativeNvidiaProviderAuthority(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  gatewayName: string;
  receipt: NativeNvidiaProviderAttachment;
  existing?: NativeNvidiaProviderAttachment;
  readAuthority: (gatewayName: string) => NativeNvidiaProviderAttachment | undefined;
  writeAuthority: (gatewayName: string, receipt: NativeNvidiaProviderAttachment) => void;
}): Promise<void> {
  try {
    input.writeAuthority(input.gatewayName, input.receipt);
    return;
  } catch (writeError) {
    const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
    let observed: NativeNvidiaProviderAttachment | undefined;
    try {
      observed = input.readAuthority(input.gatewayName);
    } catch (readError) {
      const readDetail = readError instanceof Error ? readError.message : String(readError);
      throw new NativeNvidiaProviderError(
        `NemoClaw could not record or confirm ownership of OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' for gateway '${input.gatewayName}'. The provider was retained. ${authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Read failure: ${readDetail}`,
      );
    }
    if (observed?.providerId === input.receipt.providerId) return;
    if (input.existing || observed) {
      throw new NativeNvidiaProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' for gateway '${input.gatewayName}'. The provider was retained because this operation cannot prove that it is unreferenced. ${authorityPersistenceRecovery(input.gatewayName)}\n  ${writeDetail}`,
      );
    }
    try {
      await removeNewNativeNvidiaProvider({
        adapter: input.adapter,
        target: input.target,
        expected: input.receipt,
      });
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new NativeNvidiaProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' for gateway '${input.gatewayName}', and cleanup did not complete. ${authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Cleanup failure: ${cleanupDetail}`,
      );
    }
    throw new NativeNvidiaProviderError(
      `NemoClaw could not record ownership of OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' for gateway '${input.gatewayName}'. The newly created provider was removed. Retry the command.\n  ${writeDetail}`,
    );
  }
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
  await requireNativeNvidiaProviderProfileBoundary(
    adapter,
    target,
    input.profilePath ?? nativeNvidiaProviderProfilePath(),
  );

  const before = await inspectNativeProvider(adapter, target);
  if (before) {
    const receipt = attachmentFromMetadata(before);
    if (!input.expected) {
      throw new NativeNvidiaProviderError(
        `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' already exists without a matching NemoClaw ownership receipt. No provider was changed.`,
      );
    }
    if (input.expected.providerId !== receipt.providerId) {
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
    if (!updated.ok && mutationOutcomeMayBeAmbiguous(updated.error)) {
      throw new NativeNvidiaProviderError(
        `OpenShell did not confirm whether provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' accepted its credential update. No provider receipt was recorded.`,
      );
    }
    if (!updated.ok) {
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
    const observedReceipt = attachmentFromMetadata(observed);
    if (observedReceipt.providerId !== input.expected.providerId) {
      throw new NativeNvidiaProviderError(
        `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' changed identity during its credential update. No provider receipt was recorded.`,
      );
    }
    return observedReceipt;
  }

  if (input.expected) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' is missing. Recreate the sandbox before using native NVIDIA inference. No provider was changed.`,
    );
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
  await requireNativeNvidiaProviderProfileBoundary(input.adapter, input.target);
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
  await requireNativeNvidiaProviderProfileBoundary(input.adapter, input.target);
  const provider = await inspectNativeProvider(input.adapter, input.target);
  if (!provider) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' is missing. Recreate the sandbox to restore native NVIDIA inference.`,
    );
  }
  const receipt = attachmentFromMetadata(provider);
  if (receipt.providerId !== input.expected.providerId) {
    throw new NativeNvidiaProviderError(
      `OpenShell provider '${NVIDIA_HOSTED_NATIVE_PROVIDER}' changed identity. Recreate the sandbox before using native NVIDIA inference.`,
    );
  }
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
