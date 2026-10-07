// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/sandbox-observer";

export type NativeProviderAttachment = Readonly<{
  schemaVersion: 1;
  profileId: string;
  providerName: string;
  providerId: string;
}>;
export type NativeProviderProfile = Readonly<{
  profileId: string;
  providerName: string;
  credentialEnv: string;
  label: string;
  profilePath: string;
}>;
export class NativeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProviderError";
  }
}

function assertExpectedProfile(
  profile: NativeProviderProfile,
  expected?: NativeProviderAttachment,
): void {
  if (
    expected &&
    (expected.profileId !== profile.profileId || expected.providerName !== profile.providerName)
  ) {
    throw new NativeProviderError(
      "Recorded native provider identity does not match the selected profile. No provider was changed.",
    );
  }
}

function providerErrorDetail(error: OpenShellProviderError): string {
  return error.message.trim() || "OpenShell did not provide a diagnostic.";
}

function exactNativeProvider(
  metadata: OpenShellProviderMetadata,
  profile: Pick<NativeProviderProfile, "profileId" | "providerName" | "credentialEnv">,
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
  profile: NativeProviderProfile,
): NativeProviderAttachment {
  if (!exactNativeProvider(metadata, profile) || !metadata.revision) {
    throw new NativeProviderError(
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
  profile: NativeProviderProfile,
): Promise<OpenShellProviderMetadata | null> {
  const observed = await adapter.getProvider({
    target,
    providerName: profile.providerName,
  });
  if (observed.ok) return observed.value;
  if (observed.error.kind === "command" && observed.error.reason === "not_found") return null;
  throw new NativeProviderError(
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

async function removeNewNativeProvider(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  expected: NativeProviderAttachment;
}): Promise<void> {
  const provider = await inspectNativeProvider(input.adapter, input.target, input.profile);
  if (!provider) return;
  const current = attachmentFromMetadata(provider, input.profile);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeProviderError(
      `Refusing to remove OpenShell provider '${input.profile.providerName}' because its identity changed.`,
    );
  }
  const removed = await input.adapter.deleteProvider({
    target: input.target,
    providerName: input.profile.providerName,
  });
  if (!removed.ok && !mutationOutcomeMayBeAmbiguous(removed.error)) {
    throw new NativeProviderError(
      `Could not remove OpenShell provider '${input.profile.providerName}': ${providerErrorDetail(removed.error)}`,
    );
  }
  const after = await inspectNativeProvider(input.adapter, input.target, input.profile);
  if (after) {
    const observed = attachmentFromMetadata(after, input.profile);
    const identity =
      observed.providerId === input.expected.providerId ? "still exists" : "changed identity";
    throw new NativeProviderError(
      `OpenShell provider '${input.profile.providerName}' ${identity} after cleanup.`,
    );
  }
}

/** Record provider authority or remove only the new, unreferenced provider. */
export async function persistNativeProviderAuthority(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  gatewayName: string;
  recoveryGuidance: string;
  receipt: NativeProviderAttachment;
  existing?: NativeProviderAttachment;
  readAuthority: (gatewayName: string) => NativeProviderAttachment | undefined;
  writeAuthority: (gatewayName: string, receipt: NativeProviderAttachment) => void;
}): Promise<void> {
  assertExpectedProfile(input.profile, input.receipt);
  assertExpectedProfile(input.profile, input.existing);
  try {
    input.writeAuthority(input.gatewayName, input.receipt);
    return;
  } catch (writeError) {
    const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
    let observed: NativeProviderAttachment | undefined;
    try {
      observed = input.readAuthority(input.gatewayName);
    } catch (readError) {
      const readDetail = readError instanceof Error ? readError.message : String(readError);
      throw new NativeProviderError(
        `NemoClaw could not record or confirm ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The provider was retained. ${input.recoveryGuidance}\n  Write failure: ${writeDetail}\n  Read failure: ${readDetail}`,
      );
    }
    if (observed?.providerId === input.receipt.providerId) return;
    if (input.existing || observed) {
      throw new NativeProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The provider was retained because this operation cannot prove that it is unreferenced. ${input.recoveryGuidance}\n  ${writeDetail}`,
      );
    }
    try {
      await removeNewNativeProvider({
        adapter: input.adapter,
        target: input.target,
        expected: input.receipt,
        profile: input.profile,
      });
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new NativeProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}', and cleanup did not complete. ${input.recoveryGuidance}\n  Write failure: ${writeDetail}\n  Cleanup failure: ${cleanupDetail}`,
      );
    }
    throw new NativeProviderError(
      `NemoClaw could not record ownership of OpenShell provider '${input.profile.providerName}' for gateway '${input.gatewayName}'. The newly created provider was removed. Retry the command.\n  ${writeDetail}`,
    );
  }
}

/** Ensure the least-privilege hosted profile and provider without retrying an ambiguous mutation. */
export async function ensureNativeProvider(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  credentialValue: string | null;
  reuseExistingCredential?: boolean;
  expected?: NativeProviderAttachment;
  profilePath?: string;
}): Promise<NativeProviderAttachment> {
  const { adapter, target, profile } = input;
  assertExpectedProfile(profile, input.expected);
  const imported = await adapter.importProviderProfile({
    target,
    profilePath: input.profilePath ?? profile.profilePath,
  });
  if (!imported.ok) {
    const collision =
      imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
    throw new NativeProviderError(
      collision
        ? `OpenShell provider profile '${profile.profileId}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
        : `Could not prepare OpenShell provider profile '${profile.profileId}': ${providerErrorDetail(imported.error)}`,
    );
  }

  const before = await inspectNativeProvider(adapter, target, profile);
  if (before) {
    const receipt = attachmentFromMetadata(before, profile);
    if (!input.expected) {
      throw new NativeProviderError(
        `OpenShell provider '${profile.providerName}' already exists without a matching NemoClaw ownership receipt. No provider was changed.`,
      );
    }
    if (input.expected && input.expected.providerId !== receipt.providerId) {
      throw new NativeProviderError(
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
      throw new NativeProviderError(
        `OpenShell did not confirm whether provider '${profile.providerName}' accepted its credential update. No provider receipt was recorded.`,
      );
    }
    if (!updated.ok) {
      throw new NativeProviderError(
        `Could not update OpenShell provider '${profile.providerName}': ${providerErrorDetail(updated.error)}`,
      );
    }
    const observed = await inspectNativeProvider(adapter, target, profile);
    if (!observed) {
      throw new NativeProviderError(
        `OpenShell did not confirm provider '${profile.providerName}' after its credential update.`,
      );
    }
    const confirmed = attachmentFromMetadata(observed, profile);
    if (confirmed.providerId !== receipt.providerId) {
      throw new NativeProviderError(
        `OpenShell provider '${profile.providerName}' changed identity during its credential update. No provider receipt was recorded.`,
      );
    }
    return confirmed;
  }

  if (input.expected) {
    throw new NativeProviderError(
      `OpenShell provider '${profile.providerName}' is missing. Recreate the sandbox before using native ${profile.label} inference. No provider was changed.`,
    );
  }

  if (!input.credentialValue && !input.reuseExistingCredential) {
    throw new NativeProviderError(
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
    throw new NativeProviderError(
      `Could not create OpenShell provider '${profile.providerName}': ${providerErrorDetail(created.error)}`,
    );
  }
  const observed = await inspectNativeProvider(adapter, target, profile);
  if (!observed) {
    throw new NativeProviderError(
      `OpenShell did not confirm provider '${profile.providerName}' after creation.`,
    );
  }
  return attachmentFromMetadata(observed, profile);
}

/** Prove that the exact NemoClaw-owned hosted provider is attached to one sandbox. */
export async function verifyNativeProviderAttachment(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected?: NativeProviderAttachment;
}): Promise<NativeProviderAttachment> {
  const profile = input.profile;
  if (!profile)
    throw new NativeProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (!provider) {
    throw new NativeProviderError(
      `OpenShell provider '${profile.providerName}' is missing. Recreate the sandbox to restore native ${profile.label} inference.`,
    );
  }
  const receipt = attachmentFromMetadata(provider, profile);
  if (input.expected && input.expected.providerId !== receipt.providerId) {
    throw new NativeProviderError(
      `OpenShell provider '${profile.providerName}' changed identity. Recreate the sandbox before using native ${profile.label} inference.`,
    );
  }
  const attachments = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!attachments.ok) {
    throw new NativeProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(attachments.error)}`,
    );
  }
  if (!attachments.value.names.includes(profile.providerName)) {
    throw new NativeProviderError(
      `Sandbox '${input.sandboxName}' does not have its native ${profile.label} inference provider attached. Recreate the sandbox; NemoClaw does not migrate existing beta sandboxes automatically.`,
    );
  }
  return receipt;
}

/** Attach native hosted access and reconcile an ambiguous command through observation. */
export async function ensureNativeProviderAttached(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeProviderAttachment;
}): Promise<{ receipt: NativeProviderAttachment; changed: boolean }> {
  const profile = input.profile;
  if (!profile)
    throw new NativeProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (
    !provider ||
    attachmentFromMetadata(provider, profile).providerId !== input.expected.providerId
  ) {
    throw new NativeProviderError(
      `OpenShell provider '${profile.providerName}' changed identity before attachment. Recreate the sandbox; no provider was attached.`,
    );
  }
  const before = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!before.ok) {
    throw new NativeProviderError(
      `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(before.error)}`,
    );
  }
  if (before.value.names.includes(profile.providerName)) {
    return {
      receipt: await verifyNativeProviderAttachment({ ...input, profile }),
      changed: false,
    };
  }
  const attached = await input.adapter.attachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: profile.providerName,
  });
  if (!attached.ok && !mutationOutcomeMayBeAmbiguous(attached.error)) {
    throw new NativeProviderError(
      `Could not attach native ${profile.label} provider to sandbox '${input.sandboxName}': ${providerErrorDetail(attached.error)}`,
    );
  }
  try {
    return {
      receipt: await verifyNativeProviderAttachment({ ...input, profile }),
      changed: true,
    };
  } catch (error) {
    try {
      await detachNativeProvider({ ...input, profile });
    } catch (detachError) {
      const detail = error instanceof Error ? error.message : String(error);
      const detachDetail = detachError instanceof Error ? detachError.message : String(detachError);
      throw new NativeProviderError(`${detail}\n  ${detachDetail}`);
    }
    throw error;
  }
}

/** Detach only the recorded native hosted provider identity and prove absence. */
export async function detachNativeProvider(input: {
  profile: NativeProviderProfile;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeProviderAttachment;
}): Promise<void> {
  const profile = input.profile;
  if (!profile)
    throw new NativeProviderError("Native inference requires a recorded provider identity.");
  assertExpectedProfile(profile, input.expected);
  const provider = await inspectNativeProvider(input.adapter, input.target, profile);
  if (!provider) return;
  const current = attachmentFromMetadata(provider, profile);
  if (current.providerId !== input.expected.providerId) {
    throw new NativeProviderError(
      `Refusing to detach OpenShell provider '${profile.providerName}' because its identity changed.`,
    );
  }
  const detached = await input.adapter.detachProvider({
    target: input.target,
    sandboxName: input.sandboxName,
    providerName: profile.providerName,
  });
  if (!detached.ok && !mutationOutcomeMayBeAmbiguous(detached.error)) {
    throw new NativeProviderError(
      `Could not detach native ${profile.label} provider from sandbox '${input.sandboxName}': ${providerErrorDetail(detached.error)}`,
    );
  }
  const after = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (!after.ok || after.value.names.includes(profile.providerName)) {
    throw new NativeProviderError(
      `OpenShell did not confirm removal of native ${profile.label} access from sandbox '${input.sandboxName}'.`,
    );
  }
}

export type NativeProviderRetirement = { status: "retired" | "attached" };

/** Observe exact provider absence before releasing its recovery authority. */
export async function retireNativeProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  expected: NativeProviderAttachment;
  credentialEnv: string;
  clearAuthority: () => void;
}): Promise<NativeProviderRetirement> {
  const { expected } = input;
  const request = { target: input.target, providerName: expected.providerName };
  const before = await input.adapter.getProvider(request);
  if (!before.ok) {
    if (before.error.kind === "command" && before.error.reason === "not_found") {
      input.clearAuthority();
      return { status: "retired" };
    }
    throw new NativeProviderError(
      `Provider '${expected.providerName}' retirement could not verify ownership; recovery authority retained.`,
    );
  }
  if (
    !exactNativeProvider(before.value, { ...expected, credentialEnv: input.credentialEnv }) ||
    before.value.revision?.id !== expected.providerId
  ) {
    throw new NativeProviderError(
      `Provider '${expected.providerName}' identity changed; no provider was removed.`,
    );
  }
  const removed = await input.adapter.deleteProvider(request);
  if (!removed.ok && removed.error.kind === "command" && removed.error.reason === "attached")
    return { status: "attached" };
  const after = await input.adapter.getProvider(request);
  if (!after.ok && after.error.kind === "command" && after.error.reason === "not_found") {
    input.clearAuthority();
    return { status: "retired" };
  }
  throw new NativeProviderError(
    `Provider '${expected.providerName}' removal was not confirmed; recovery authority retained.`,
  );
}
