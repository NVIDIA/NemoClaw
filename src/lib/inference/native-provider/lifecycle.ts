// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/sandbox-observer";

export type NativeProviderAttachment<
  ProfileId extends string = string,
  ProviderName extends string = string,
> = Readonly<{
  schemaVersion: 1;
  profileId: ProfileId;
  providerName: ProviderName;
  providerId: string;
}>;

/** Shared Slice 1 lifecycle for the NVIDIA and endpoint-specific native consumers. */
export function createNativeProviderLifecycle<
  ProfileId extends string,
  ProviderName extends string,
>(
  contract: {
    profileId: ProfileId;
    providerName: ProviderName;
    credentialEnv: string;
    logicalProvider: string;
    profilePath: string;
    label: string;
  },
  ProviderError: new (message: string) => Error,
) {
  function providerErrorDetail(error: OpenShellProviderError): string {
    return error.message.trim() || "OpenShell did not provide a diagnostic.";
  }

  async function requireProviderProfileBoundary(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
    profilePath = contract.profilePath,
  ): Promise<void> {
    const imported = await adapter.importProviderProfile({ target, profilePath });
    if (imported.ok) return;
    const collision =
      imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
    throw new ProviderError(
      collision
        ? `OpenShell provider profile '${contract.profileId}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
        : `Could not verify OpenShell provider profile '${contract.profileId}': ${providerErrorDetail(imported.error)}`,
    );
  }

  function exactNativeProvider(metadata: OpenShellProviderMetadata): boolean {
    return (
      metadata.name === contract.providerName &&
      metadata.type === contract.profileId &&
      metadata.configKeys.length === 0 &&
      metadata.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === contract.credentialEnv &&
      Boolean(metadata.revision?.id)
    );
  }

  function attachmentFromMetadata(
    metadata: OpenShellProviderMetadata,
  ): NativeProviderAttachment<ProfileId, ProviderName> {
    if (!exactNativeProvider(metadata) || !metadata.revision) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' does not match the NemoClaw-owned ${contract.label} inference boundary. No provider was changed.`,
      );
    }
    return {
      schemaVersion: 1,
      profileId: contract.profileId,
      providerName: contract.providerName,
      providerId: metadata.revision.id,
    };
  }

  async function inspectNativeProvider(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
  ): Promise<OpenShellProviderMetadata | null> {
    const observed = await adapter.getProvider({
      target,
      providerName: contract.providerName,
    });
    if (observed.ok) return observed.value;
    if (observed.error.kind === "command" && observed.error.reason === "not_found") return null;
    throw new ProviderError(
      `Could not inspect OpenShell provider '${contract.providerName}': ${providerErrorDetail(observed.error)}`,
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
    return `Run 'nemoclaw credentials reset ${contract.logicalProvider} --yes' against gateway '${gatewayName}', then retry.`;
  }

  async function removeNewProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<void> {
    const provider = await inspectNativeProvider(input.adapter, input.target);
    if (!provider) return;
    const current = attachmentFromMetadata(provider);
    if (current.providerId !== input.expected.providerId) {
      throw new ProviderError(
        `Refusing to remove OpenShell provider '${contract.providerName}' because its identity changed.`,
      );
    }
    const removed = await input.adapter.deleteProvider({
      target: input.target,
      providerName: contract.providerName,
    });
    if (!removed.ok && !mutationOutcomeMayBeAmbiguous(removed.error)) {
      throw new ProviderError(
        `Could not remove OpenShell provider '${contract.providerName}': ${providerErrorDetail(removed.error)}`,
      );
    }
    const after = await inspectNativeProvider(input.adapter, input.target);
    if (after) {
      const observed = attachmentFromMetadata(after);
      const identity =
        observed.providerId === input.expected.providerId ? "still exists" : "changed identity";
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' ${identity} after cleanup.`,
      );
    }
  }

  /** Record provider authority or remove only the new, unreferenced provider. */
  async function persistProviderAuthority(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    gatewayName: string;
    receipt: NativeProviderAttachment<ProfileId, ProviderName>;
    existing?: NativeProviderAttachment<ProfileId, ProviderName>;
    readAuthority: (
      gatewayName: string,
    ) => NativeProviderAttachment<ProfileId, ProviderName> | undefined;
    writeAuthority: (
      gatewayName: string,
      receipt: NativeProviderAttachment<ProfileId, ProviderName>,
    ) => void;
  }): Promise<void> {
    try {
      input.writeAuthority(input.gatewayName, input.receipt);
      return;
    } catch (writeError) {
      const writeDetail = writeError instanceof Error ? writeError.message : String(writeError);
      let observed: NativeProviderAttachment<ProfileId, ProviderName> | undefined;
      try {
        observed = input.readAuthority(input.gatewayName);
      } catch (readError) {
        const readDetail = readError instanceof Error ? readError.message : String(readError);
        throw new ProviderError(
          `NemoClaw could not record or confirm ownership of OpenShell provider '${contract.providerName}' for gateway '${input.gatewayName}'. The provider was retained. ${authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Read failure: ${readDetail}`,
        );
      }
      if (observed?.providerId === input.receipt.providerId) return;
      if (input.existing || observed) {
        throw new ProviderError(
          `NemoClaw could not record ownership of OpenShell provider '${contract.providerName}' for gateway '${input.gatewayName}'. The provider was retained because this operation cannot prove that it is unreferenced. ${authorityPersistenceRecovery(input.gatewayName)}\n  ${writeDetail}`,
        );
      }
      try {
        await removeNewProvider({
          adapter: input.adapter,
          target: input.target,
          expected: input.receipt,
        });
      } catch (cleanupError) {
        const cleanupDetail =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new ProviderError(
          `NemoClaw could not record ownership of OpenShell provider '${contract.providerName}' for gateway '${input.gatewayName}', and cleanup did not complete. ${authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Cleanup failure: ${cleanupDetail}`,
        );
      }
      throw new ProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${contract.providerName}' for gateway '${input.gatewayName}'. The newly created provider was removed. Retry the command.\n  ${writeDetail}`,
      );
    }
  }

  /** Ensure the selected least-privilege profile and provider without retrying an ambiguous mutation. */
  async function ensureProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    credentialValue: string | null;
    reuseExistingCredential?: boolean;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
    profilePath?: string;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    const { adapter, target } = input;
    await requireProviderProfileBoundary(
      adapter,
      target,
      input.profilePath ?? contract.profilePath,
    );

    const activatePolicy = async () => {
      const policy = await adapter.ensureProviderPolicyComposition({ target });
      if (!policy.ok) {
        throw new ProviderError(
          `Could not activate native ${contract.label} provider policy: ${providerErrorDetail(policy.error)}`,
        );
      }
    };

    const before = await inspectNativeProvider(adapter, target);
    if (before) {
      const receipt = attachmentFromMetadata(before);
      if (!input.expected) {
        throw new ProviderError(
          `OpenShell provider '${contract.providerName}' already exists without a matching NemoClaw ownership receipt. No provider was changed.`,
        );
      }
      if (input.expected.providerId !== receipt.providerId) {
        throw new ProviderError(
          `OpenShell provider '${contract.providerName}' changed identity. Recreate the sandbox before using native ${contract.label} inference. No provider was changed.`,
        );
      }
      await activatePolicy();
      if (!input.credentialValue) return receipt;
      const updated = await adapter.updateProvider({
        target,
        providerName: contract.providerName,
        credentials: [{ name: contract.credentialEnv, value: input.credentialValue }],
        config: [],
      });
      if (!updated.ok && mutationOutcomeMayBeAmbiguous(updated.error)) {
        // Metadata can establish identity, but cannot prove which credential was stored.
        await inspectNativeProvider(adapter, target);
        throw new ProviderError(
          `OpenShell did not confirm whether provider '${contract.providerName}' accepted its credential update. No provider receipt was recorded.`,
        );
      }
      if (!updated.ok) {
        throw new ProviderError(
          `Could not update OpenShell provider '${contract.providerName}': ${providerErrorDetail(updated.error)}`,
        );
      }
      const observed = await inspectNativeProvider(adapter, target);
      if (!observed) {
        throw new ProviderError(
          `OpenShell did not confirm provider '${contract.providerName}' after its credential update.`,
        );
      }
      const observedReceipt = attachmentFromMetadata(observed);
      if (observedReceipt.providerId !== input.expected.providerId) {
        throw new ProviderError(
          `OpenShell provider '${contract.providerName}' changed identity during its credential update. No provider receipt was recorded.`,
        );
      }
      return observedReceipt;
    }

    if (input.expected) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' is missing. Recreate the sandbox before using native ${contract.label} inference. No provider was changed.`,
      );
    }

    if (!input.credentialValue && !input.reuseExistingCredential) {
      throw new ProviderError(
        `A host credential is required to create OpenShell provider '${contract.providerName}'.`,
      );
    }
    await activatePolicy();
    const created = await adapter.createProvider({
      target,
      name: contract.providerName,
      type: contract.profileId,
      credentials: input.credentialValue
        ? [{ name: contract.credentialEnv, value: input.credentialValue }]
        : [],
      config: [],
      fromExisting: !input.credentialValue,
    });
    if (!created.ok && !mutationOutcomeMayBeAmbiguous(created.error)) {
      throw new ProviderError(
        `Could not create OpenShell provider '${contract.providerName}': ${providerErrorDetail(created.error)}`,
      );
    }
    const observed = await inspectNativeProvider(adapter, target);
    if (!observed) {
      throw new ProviderError(
        `OpenShell did not confirm provider '${contract.providerName}' after creation.`,
      );
    }
    return attachmentFromMetadata(observed);
  }

  /** Prove that the NemoClaw-owned provider is attached to one sandbox. */
  async function verifyProviderAttachment(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    await requireProviderProfileBoundary(input.adapter, input.target);
    const provider = await inspectNativeProvider(input.adapter, input.target);
    if (!provider) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' is missing. Recreate the sandbox to restore native ${contract.label} inference.`,
      );
    }
    const receipt = attachmentFromMetadata(provider);
    if (input.expected && input.expected.providerId !== receipt.providerId) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' changed identity. Recreate the sandbox before using native ${contract.label} inference.`,
      );
    }
    const attachments = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!attachments.ok) {
      throw new ProviderError(
        `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(attachments.error)}`,
      );
    }
    if (!attachments.value.names.includes(contract.providerName)) {
      throw new ProviderError(
        `Sandbox '${input.sandboxName}' does not have its native ${contract.label} inference provider attached. Recreate the sandbox; NemoClaw does not migrate existing beta sandboxes automatically.`,
      );
    }
    return receipt;
  }

  /** Attach native access and reconcile an ambiguous command through observation. */
  async function ensureProviderAttached(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<{ receipt: NativeProviderAttachment<ProfileId, ProviderName>; changed: boolean }> {
    await requireProviderProfileBoundary(input.adapter, input.target);
    const provider = await inspectNativeProvider(input.adapter, input.target);
    if (!provider) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' is missing. Recreate the sandbox to restore native ${contract.label} inference.`,
      );
    }
    const receipt = attachmentFromMetadata(provider);
    if (receipt.providerId !== input.expected.providerId) {
      throw new ProviderError(
        `OpenShell provider '${contract.providerName}' changed identity. Recreate the sandbox before using native ${contract.label} inference.`,
      );
    }
    const before = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!before.ok) {
      throw new ProviderError(
        `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${providerErrorDetail(before.error)}`,
      );
    }
    if (before.value.names.includes(contract.providerName)) {
      return {
        receipt: await verifyProviderAttachment(input),
        changed: false,
      };
    }
    const attached = await input.adapter.attachProvider({
      target: input.target,
      sandboxName: input.sandboxName,
      providerName: contract.providerName,
    });
    if (!attached.ok && !mutationOutcomeMayBeAmbiguous(attached.error)) {
      throw new ProviderError(
        `Could not attach native ${contract.label} provider to sandbox '${input.sandboxName}': ${providerErrorDetail(attached.error)}`,
      );
    }
    try {
      return {
        receipt: await verifyProviderAttachment(input),
        changed: true,
      };
    } catch (error) {
      try {
        await detachProvider(input);
      } catch (detachError) {
        const detail = error instanceof Error ? error.message : String(error);
        const detachDetail =
          detachError instanceof Error ? detachError.message : String(detachError);
        throw new ProviderError(`${detail}\n  ${detachDetail}`);
      }
      throw error;
    }
  }

  /** Detach only the recorded native provider identity and prove absence. */
  async function detachProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<void> {
    const provider = await inspectNativeProvider(input.adapter, input.target);
    if (!provider) return;
    const current = attachmentFromMetadata(provider);
    if (current.providerId !== input.expected.providerId) {
      throw new ProviderError(
        `Refusing to detach OpenShell provider '${contract.providerName}' because its identity changed.`,
      );
    }
    const detached = await input.adapter.detachProvider({
      target: input.target,
      sandboxName: input.sandboxName,
      providerName: contract.providerName,
    });
    if (!detached.ok && !mutationOutcomeMayBeAmbiguous(detached.error)) {
      throw new ProviderError(
        `Could not detach native ${contract.label} provider from sandbox '${input.sandboxName}': ${providerErrorDetail(detached.error)}`,
      );
    }
    const after = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!after.ok || after.value.names.includes(contract.providerName)) {
      throw new ProviderError(
        `OpenShell did not confirm removal of native ${contract.label} access from sandbox '${input.sandboxName}'.`,
      );
    }
  }

  return {
    requireProviderProfileBoundary,
    inspectNativeProvider,
    attachmentFromMetadata,
    persistProviderAuthority,
    ensureProvider,
    verifyProviderAttachment,
    ensureProviderAttached,
    detachProvider,
    deleteOwnedProvider: removeNewProvider,
  };
}
