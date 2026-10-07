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

import { NATIVE_HOSTED_PROFILES, nativeHostedProfile, type NativeHostedProfile } from "./profiles";

import { NativeHostedProviderError, type NativeHostedProviderAttachment } from "./contract";
export {
  NativeHostedProviderError,
  normalizeNativeHostedProviderAttachment,
  type NativeHostedProviderAttachment,
} from "./contract";
export {
  resolveGatewayNativeHostedProviderAuthority,
  retainNativeHostedProviderAuthority,
} from "./authority";

export function nativeHostedProviderProfilePath(
  profile: NativeHostedProfile,
  root = REPOSITORY_ROOT,
): string {
  return path.join(root, "managed-inference", "provider-profiles", `${profile.profileId}.yaml`);
}

export function isNativeHostedProvider(provider: string | null | undefined): boolean {
  return nativeHostedProfile(provider) !== undefined;
}

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return nativeHostedProfile(normalized)?.providerName ?? normalized;
}

function assertExpectedProfile(
  profile: NativeHostedProfile,
  expected?: NativeHostedProviderAttachment,
): void {
  if (
    expected &&
    (expected.profileId !== profile.profileId || expected.providerName !== profile.providerName)
  ) {
    throw new NativeHostedProviderError(
      "Recorded native provider identity does not match the selected profile. No provider was changed.",
    );
  }
}

function providerErrorDetail(error: OpenShellProviderError): string {
  return error.message.trim() || "OpenShell did not provide a diagnostic.";
}

function exactNativeProvider(
  metadata: OpenShellProviderMetadata,
  profile: NativeHostedProfile,
): boolean {
  return (
    metadata.name === profile.providerName &&
    metadata.type === profile.profileId &&
    metadata.configKeys.length === 0 &&
    metadata.credentialKeys.length === 1 &&
    metadata.credentialKeys[0] === profile.credentialEnv &&
    Boolean(metadata.revision?.id)
  );
}

function attachmentFromMetadata(
  metadata: OpenShellProviderMetadata,
  profile: NativeHostedProfile,
): NativeHostedProviderAttachment {
  if (!exactNativeProvider(metadata, profile) || !metadata.revision) {
    throw new NativeHostedProviderError(
      `OpenShell provider '${profile.providerName}' does not match the NemoClaw-owned ${profile.label} inference boundary. No provider was changed.`,
    );
  }
  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    providerName: profile.providerName,
    providerId: metadata.revision.id,
  };
}

async function inspectNativeProvider(
  adapter: OpenShellProviderAdapter,
  target: OpenShellGatewayTarget,
  profile: NativeHostedProfile,
): Promise<OpenShellProviderMetadata | null> {
  const observed = await adapter.getProvider({
    target,
    providerName: profile.providerName,
  });
  if (observed.ok) return observed.value;
  if (observed.error.kind === "command" && observed.error.reason === "not_found") return null;
  throw new NativeHostedProviderError(
    `Could not inspect OpenShell provider '${profile.providerName}': ${providerErrorDetail(observed.error)}`,
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

function authorityPersistenceRecovery(gatewayName: string, profile: NativeHostedProfile): string {
  return `Run 'nemoclaw credentials reset ${profile.logicalProvider} --yes' against gateway '${gatewayName}', then retry.`;
}

async function removeNewNativeHostedProvider(input: {
  profile: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  expected: NativeHostedProviderAttachment;
}): Promise<void> {
  const provider = await inspectNativeProvider(input.adapter, input.target, input.profile);
  if (!provider) return;
  const current = attachmentFromMetadata(provider, input.profile);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeHostedProviderError(
      `Refusing to remove OpenShell provider '${input.profile.providerName}' because its identity changed.`,
    );
  }
  const removed = await input.adapter.deleteProvider({
    target: input.target,
    providerName: input.profile.providerName,
  });
  if (!removed.ok && !mutationOutcomeMayBeAmbiguous(removed.error)) {
    throw new NativeHostedProviderError(
      `Could not remove OpenShell provider '${input.profile.providerName}': ${providerErrorDetail(removed.error)}`,
    );
  }
  const after = await inspectNativeProvider(input.adapter, input.target, input.profile);
  if (after) {
    const observed = attachmentFromMetadata(after, input.profile);
    const identity =
      observed.providerId === input.expected.providerId ? "still exists" : "changed identity";
    throw new NativeHostedProviderError(
      `OpenShell provider '${input.profile.providerName}' ${identity} after cleanup.`,
    );
  }
}

/** Record provider authority or remove only the new, unreferenced provider. */
export async function persistNativeHostedProviderAuthority(input: {
  profile: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  gatewayName: string;
  receipt: NativeHostedProviderAttachment;
  existing?: NativeHostedProviderAttachment;
  readAuthority: (gatewayName: string) => NativeHostedProviderAttachment | undefined;
  writeAuthority: (gatewayName: string, receipt: NativeHostedProviderAttachment) => void;
}): Promise<void> {
  try {
    input.writeAuthority(input.gatewayName, input.receipt);
    return;
  } catch (writeError) {
    const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
    let observed: NativeHostedProviderAttachment | undefined;
    try {
      observed = input.readAuthority(input.gatewayName);
    } catch (readError) {
      const readDetail = readError instanceof Error ? readError.message : String(readError);
      throw new NativeHostedProviderError(
        `NemoClaw could not record or confirm ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The provider was retained. ${authorityPersistenceRecovery(input.gatewayName, input.profile)}\n  Write failure: ${writeDetail}\n  Read failure: ${readDetail}`,
      );
    }
    if (observed?.providerId === input.receipt.providerId) return;
    if (input.existing || observed) {
      throw new NativeHostedProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The provider was retained because this operation cannot prove that it is unreferenced. ${authorityPersistenceRecovery(input.gatewayName, input.profile)}\n  ${writeDetail}`,
      );
    }
    try {
      await removeNewNativeHostedProvider({
        profile: input.profile,
        adapter: input.adapter,
        target: input.target,
        expected: input.receipt,
      });
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new NativeHostedProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}', and cleanup did not complete. ${authorityPersistenceRecovery(input.gatewayName, input.profile)}\n  Write failure: ${writeDetail}\n  Cleanup failure: ${cleanupDetail}`,
      );
    }
    throw new NativeHostedProviderError(
      `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The newly created provider was removed. Retry the command.\n  ${writeDetail}`,
    );
  }
}

/** Ensure the least-privilege hosted profile and provider without retrying an ambiguous mutation. */
export async function ensureNativeHostedProvider(input: {
  profile: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  credentialValue: string | null;
  reuseExistingCredential?: boolean;
  expected?: NativeHostedProviderAttachment;
  profilePath?: string;
}): Promise<NativeHostedProviderAttachment> {
  const { adapter, target, profile } = input;
  assertExpectedProfile(profile, input.expected);
  const imported = await adapter.importProviderProfile({
    target,
    profilePath: input.profilePath ?? nativeHostedProviderProfilePath(profile),
  });
  if (!imported.ok) {
    const collision =
      imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
    throw new NativeHostedProviderError(
      collision
        ? `OpenShell provider profile '${profile.profileId}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
        : `Could not prepare OpenShell provider profile '${profile.profileId}': ${providerErrorDetail(imported.error)}`,
    );
  }

  const before = await inspectNativeProvider(adapter, target, profile);
  if (before) {
    const receipt = attachmentFromMetadata(before, profile);
    if (!input.expected) {
      throw new NativeHostedProviderError(
        `OpenShell provider '${profile.providerName}' already exists without a matching NemoClaw ownership receipt. No provider was changed.`,
      );
    }
    if (input.expected && input.expected.providerId !== receipt.providerId) {
      throw new NativeHostedProviderError(
        `OpenShell provider '${profile.providerName}' changed identity. Recreate the sandbox before using native ${profile.label} inference. No provider was changed.`,
      );
    }
    if (!input.credentialValue) return receipt;
    const updated = await adapter.updateProvider({
      target,
      providerName: profile.providerName,
      credentials: [{ name: profile.credentialEnv, value: input.credentialValue }],
      config: [],
    });
    if (!updated.ok && mutationOutcomeMayBeAmbiguous(updated.error)) {
      throw new NativeHostedProviderError(
        `OpenShell did not confirm whether provider '${profile.providerName}' accepted its credential update. No provider receipt was recorded.`,
      );
    }
    if (!updated.ok) {
      throw new NativeHostedProviderError(
        `Could not update OpenShell provider '${profile.providerName}': ${providerErrorDetail(updated.error)}`,
      );
    }
    const observed = await inspectNativeProvider(adapter, target, profile);
    if (!observed) {
      throw new NativeHostedProviderError(
        `OpenShell did not confirm provider '${profile.providerName}' after its credential update.`,
      );
    }
    const confirmed = attachmentFromMetadata(observed, profile);
    if (confirmed.providerId !== receipt.providerId) {
      throw new NativeHostedProviderError(
        `OpenShell provider '${profile.providerName}' changed identity during its credential update. No provider receipt was recorded.`,
      );
    }
    return confirmed;
  }

  if (input.expected) {
    throw new NativeHostedProviderError(
      `OpenShell provider '${profile.providerName}' is missing. Recreate the sandbox before using native ${profile.label} inference. No provider was changed.`,
    );
  }

  if (!input.credentialValue && !input.reuseExistingCredential) {
    throw new NativeHostedProviderError(
      `A host credential is required to create OpenShell provider '${profile.providerName}'.`,
    );
  }
  const created = await adapter.createProvider({
    target,
    name: profile.providerName,
    type: profile.profileId,
    credentials: input.credentialValue
      ? [{ name: profile.credentialEnv, value: input.credentialValue }]
      : [],
    config: [],
    fromExisting: !input.credentialValue,
  });
  if (!created.ok && !mutationOutcomeMayBeAmbiguous(created.error)) {
    throw new NativeHostedProviderError(
      `Could not create OpenShell provider '${profile.providerName}': ${providerErrorDetail(created.error)}`,
    );
  }
  const observed = await inspectNativeProvider(adapter, target, profile);
  if (!observed) {
    throw new NativeHostedProviderError(
      `OpenShell did not confirm provider '${profile.providerName}' after creation.`,
    );
  }
  return attachmentFromMetadata(observed, profile);
}

/** Prove that the exact NemoClaw-owned hosted provider is attached to one sandbox. */
export async function verifyNativeHostedProviderAttachment(input: {
  profile?: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected?: NativeHostedProviderAttachment;
}): Promise<NativeHostedProviderAttachment> {
  const profile =
    input.profile ??
    NATIVE_HOSTED_PROFILES.find(
      (candidate) =>
        candidate.profileId === input.expected?.profileId &&
        candidate.providerName === input.expected?.providerName,
    );
  if (!profile)
    throw new NativeHostedProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (!provider) {
    throw new NativeHostedProviderError(
      `OpenShell provider '${profile.providerName}' is missing. Recreate the sandbox to restore native ${profile.label} inference.`,
    );
  }
  const receipt = attachmentFromMetadata(provider, profile);
  if (input.expected && input.expected.providerId !== receipt.providerId) {
    throw new NativeHostedProviderError(
      `OpenShell provider '${profile.providerName}' changed identity. Recreate the sandbox before using native ${profile.label} inference.`,
    );
  }
  const attachments = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!attachments.ok) {
    throw new NativeHostedProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(attachments.error)}`,
    );
  }
  if (!attachments.value.names.includes(profile.providerName)) {
    throw new NativeHostedProviderError(
      `Sandbox '${input.sandboxName}' does not have its native ${profile.label} inference provider attached. Recreate the sandbox; NemoClaw does not migrate existing beta sandboxes automatically.`,
    );
  }
  return receipt;
}

/** Attach native hosted access and reconcile an ambiguous command through observation. */
export async function ensureNativeHostedProviderAttached(input: {
  profile?: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeHostedProviderAttachment;
}): Promise<{ receipt: NativeHostedProviderAttachment; changed: boolean }> {
  const profile =
    input.profile ??
    NATIVE_HOSTED_PROFILES.find(
      (candidate) =>
        candidate.profileId === input.expected?.profileId &&
        candidate.providerName === input.expected?.providerName,
    );
  if (!profile)
    throw new NativeHostedProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const before = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!before.ok) {
    throw new NativeHostedProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(before.error)}`,
    );
  }
  if (before.value.names.includes(profile.providerName)) {
    return {
      receipt: await verifyNativeHostedProviderAttachment({ ...input, profile }),
      changed: false,
    };
  }
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (
    !provider ||
    attachmentFromMetadata(provider, profile).providerId !== input.expected.providerId
  ) {
    throw new NativeHostedProviderError(
      `OpenShell provider '${profile.providerName}' changed identity before attachment. No provider was attached.`,
    );
  }
  const attached = await input.adapter.attachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: profile.providerName,
  });
  if (!attached.ok && !mutationOutcomeMayBeAmbiguous(attached.error)) {
    throw new NativeHostedProviderError(
      `Could not attach native ${profile.label} provider to sandbox '${input.sandboxName}': ${providerErrorDetail(attached.error)}`,
    );
  }
  try {
    return {
      receipt: await verifyNativeHostedProviderAttachment({ ...input, profile }),
      changed: true,
    };
  } catch (error) {
    try {
      await detachNativeHostedProvider({ ...input, profile });
    } catch (detachError) {
      const detail = error instanceof Error ? error.message : String(error);
      const detachDetail = detachError instanceof Error ? detachError.message : String(detachError);
      throw new NativeHostedProviderError(`${detail}\n  ${detachDetail}`);
    }
    throw error;
  }
}

/** Detach only the recorded native hosted provider identity and prove absence. */
export async function detachNativeHostedProvider(input: {
  profile?: NativeHostedProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeHostedProviderAttachment;
}): Promise<void> {
  const profile =
    input.profile ??
    NATIVE_HOSTED_PROFILES.find(
      (candidate) =>
        candidate.profileId === input.expected?.profileId &&
        candidate.providerName === input.expected?.providerName,
    );
  if (!profile)
    throw new NativeHostedProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (!provider) return;
  const current = attachmentFromMetadata(provider, profile);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeHostedProviderError(
      `Refusing to detach OpenShell provider '${profile.providerName}' because its identity changed.`,
    );
  }
  const detached = await input.adapter.detachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: profile.providerName,
  });
  if (!detached.ok && !mutationOutcomeMayBeAmbiguous(detached.error)) {
    throw new NativeHostedProviderError(
      `Could not detach native ${profile.label} provider from sandbox '${input.sandboxName}': ${providerErrorDetail(detached.error)}`,
    );
  }
  const after = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!after.ok || after.value.names.includes(profile.providerName)) {
    throw new NativeHostedProviderError(
      `OpenShell did not confirm removal of native ${profile.label} access from sandbox '${input.sandboxName}'.`,
    );
  }
}

export { nativeHostedProfile } from "./profiles";

export { normalizeNativeNvidiaProviderAttachment } from "../native-nvidia/contract";
