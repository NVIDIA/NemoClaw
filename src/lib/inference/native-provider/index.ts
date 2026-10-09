// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { withHermesNativeProfile } from "./hermes-profile";

import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  normalizeNativeProviderAttachment,
  type NativeProviderAttachment,
  type NativeProviderDefinition,
} from "./contract";

export class NativeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProviderError";
  }
}

/** The shared lifecycle for NemoClaw's fixed hosted provider profiles. */
export class NativeProviderLifecycle<ProfileId extends string, ProviderName extends string> {
  constructor(readonly definition: NativeProviderDefinition<ProfileId, ProviderName>) {}
  private requireExpectedReceipt(receipt: NativeProviderAttachment<ProfileId, ProviderName>): void {
    if (!normalizeNativeProviderAttachment(receipt, this.definition)) {
      throw new NativeProviderError(
        `Invalid ownership receipt for OpenShell provider '${this.definition.providerName}'. No provider was changed.`,
      );
    }
  }

  nativeProviderProfilePath(root = REPOSITORY_ROOT): string {
    return path.join(
      root,
      "managed-inference",
      "provider-profiles",
      `${this.definition.profileId}.yaml`,
    );
  }

  isNativeProvider(provider: string | null | undefined): boolean {
    return provider?.trim() === this.definition.logicalProvider;
  }

  resolveGatewayNativeProviderAuthority(input: {
    gatewayName: string;
    gatewayAuthority?: NativeProviderAttachment<ProfileId, ProviderName> | null;
    recordedAttachment?: NativeProviderAttachment<ProfileId, ProviderName> | null;
  }): NativeProviderAttachment<ProfileId, ProviderName> | undefined {
    const authorities = new Map<string, NativeProviderAttachment<ProfileId, ProviderName>>();
    for (const receipt of [input.gatewayAuthority, input.recordedAttachment]) {
      if (receipt) {
        this.requireExpectedReceipt(receipt);
        authorities.set(receipt.providerId, receipt);
      }
    }
    if (authorities.size > 1) {
      throw new NativeProviderError(
        `Gateway '${input.gatewayName}' has conflicting native ${this.definition.label} provider ownership receipts. No provider was changed.`,
      );
    }
    return authorities.values().next().value;
  }

  nativeInferenceProviderForSandbox(provider: string | null | undefined): string | null {
    const normalized = provider?.trim() || null;
    return this.isNativeProvider(normalized) ? this.definition.providerName : normalized;
  }

  providerErrorDetail(error: OpenShellProviderError): string {
    return error.message.trim() || "OpenShell did not provide a diagnostic.";
  }

  async requireNativeProviderProfileBoundary(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
    profilePath = this.nativeProviderProfilePath(),
  ): Promise<void> {
    const imported = this.definition.endpointUrl
      ? await withHermesNativeProfile(this.definition, (boundPath) =>
          adapter.importProviderProfile({ target, profilePath: boundPath }),
        )
      : await adapter.importProviderProfile({ target, profilePath });
    if (imported.ok) return;
    const collision =
      imported.error.kind === "command" && imported.error.reason === "profile_incompatible";
    throw new NativeProviderError(
      collision
        ? `OpenShell provider profile '${this.definition.profileId}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
        : `Could not verify OpenShell provider profile '${this.definition.profileId}': ${this.providerErrorDetail(imported.error)}`,
    );
  }

  exactNativeProvider(metadata: OpenShellProviderMetadata): boolean {
    return (
      metadata.name === this.definition.providerName &&
      metadata.type === this.definition.profileId &&
      metadata.configKeys.length === 0 &&
      metadata.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === this.definition.credentialEnv &&
      Boolean(metadata.revision?.id)
    );
  }

  nativeProviderAttachmentFromMetadata(
    metadata: OpenShellProviderMetadata,
  ): NativeProviderAttachment<ProfileId, ProviderName> {
    if (!this.exactNativeProvider(metadata) || !metadata.revision) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' does not match the NemoClaw-owned ${this.definition.label} inference boundary. No provider was changed.`,
      );
    }
    return {
      schemaVersion: 1,
      profileId: this.definition.profileId,
      providerName: this.definition.providerName,
      providerId: metadata.revision.id,
      ...(this.definition.endpointUrl ? { endpointUrl: this.definition.endpointUrl } : {}),
    };
  }

  async inspectNativeProvider(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
  ): Promise<OpenShellProviderMetadata | null> {
    const observed = await adapter.getProvider({
      target,
      providerName: this.definition.providerName,
    });
    if (observed.ok) return observed.value;
    if (observed.error.kind === "command" && observed.error.reason === "not_found") return null;
    throw new NativeProviderError(
      `Could not inspect OpenShell provider '${this.definition.providerName}': ${this.providerErrorDetail(observed.error)}`,
    );
  }

  mutationOutcomeMayBeAmbiguous(error: OpenShellProviderError): boolean {
    return (
      error.kind === "timeout" ||
      (error.kind === "transport" &&
        (error.reason === "connection_loss" || error.reason === "unreachable")) ||
      (error.kind === "command" && error.reason === "uncertain")
    );
  }

  authorityPersistenceRecovery(gatewayName: string): string {
    return `Run 'nemoclaw credentials reset ${this.definition.logicalProvider} --yes' against gateway '${gatewayName}', then retry.`;
  }

  async removeNewNativeProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<void> {
    this.requireExpectedReceipt(input.expected);
    const provider = await this.inspectNativeProvider(input.adapter, input.target);
    if (!provider) return;
    const current = this.nativeProviderAttachmentFromMetadata(provider);
    if (current.providerId !== input.expected.providerId) {
      throw new NativeProviderError(
        `Refusing to remove OpenShell provider '${this.definition.providerName}' because its identity changed.`,
      );
    }
    const removed = await input.adapter.deleteProvider({
      target: input.target,
      providerName: this.definition.providerName,
    });
    if (!removed.ok && !this.mutationOutcomeMayBeAmbiguous(removed.error)) {
      throw new NativeProviderError(
        `Could not remove OpenShell provider '${this.definition.providerName}': ${this.providerErrorDetail(removed.error)}`,
      );
    }
    const after = await this.inspectNativeProvider(input.adapter, input.target);
    if (after) {
      const observed = this.nativeProviderAttachmentFromMetadata(after);
      const identity =
        observed.providerId === input.expected.providerId ? "still exists" : "changed identity";
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' ${identity} after cleanup.`,
      );
    }
  }

  /** Record provider authority or remove only the new, unreferenced provider. */
  async persistNativeProviderAuthority(input: {
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
    this.requireExpectedReceipt(input.receipt);
    if (input.existing) this.requireExpectedReceipt(input.existing);
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
        throw new NativeProviderError(
          `NemoClaw could not record or confirm ownership of OpenShell provider '${this.definition.providerName}' for gateway '${input.gatewayName}'. The provider was retained. ${this.authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Read failure: ${readDetail}`,
        );
      }
      if (observed?.providerId === input.receipt.providerId) return;
      if (input.existing || observed) {
        throw new NativeProviderError(
          `NemoClaw could not record ownership of OpenShell provider '${this.definition.providerName}' for gateway '${input.gatewayName}'. The provider was retained because this operation cannot prove that it is unreferenced. ${this.authorityPersistenceRecovery(input.gatewayName)}\n  ${writeDetail}`,
        );
      }
      try {
        await this.removeNewNativeProvider({
          adapter: input.adapter,
          target: input.target,
          expected: input.receipt,
        });
      } catch (cleanupError) {
        const cleanupDetail =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new NativeProviderError(
          `NemoClaw could not record ownership of OpenShell provider '${this.definition.providerName}' for gateway '${input.gatewayName}', and cleanup did not complete. ${this.authorityPersistenceRecovery(input.gatewayName)}\n  Write failure: ${writeDetail}\n  Cleanup failure: ${cleanupDetail}`,
        );
      }
      throw new NativeProviderError(
        `NemoClaw could not record ownership of OpenShell provider '${this.definition.providerName}' for gateway '${input.gatewayName}'. The newly created provider was removed. Retry the command.\n  ${writeDetail}`,
      );
    }
  }

  /** Ensure the restricted provider profile and provider without retrying an ambiguous mutation. */
  async ensureNativeProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    credentialValue: string | null;
    reuseExistingCredential?: boolean;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
    profilePath?: string;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    if (input.expected) this.requireExpectedReceipt(input.expected);
    const { adapter, target } = input;
    await this.requireNativeProviderProfileBoundary(
      adapter,
      target,
      input.profilePath ?? this.nativeProviderProfilePath(),
    );

    const activatePolicy = async () => {
      const policy = await adapter.ensureProviderPolicyComposition({ target });
      if (!policy.ok) {
        throw new NativeProviderError(
          `Could not activate native ${this.definition.label} provider policy: ${this.providerErrorDetail(policy.error)}`,
        );
      }
    };

    const before = await this.inspectNativeProvider(adapter, target);
    if (before) {
      const receipt = this.nativeProviderAttachmentFromMetadata(before);
      if (!input.expected) {
        throw new NativeProviderError(
          `OpenShell provider '${this.definition.providerName}' already exists without a matching NemoClaw ownership receipt. No provider was changed.`,
        );
      }
      if (input.expected.providerId !== receipt.providerId) {
        throw new NativeProviderError(
          `OpenShell provider '${this.definition.providerName}' changed identity. Recreate the sandbox before using native ${this.definition.label} inference. No provider was changed.`,
        );
      }
      await activatePolicy();
      if (!input.credentialValue) return receipt;
      const updated = await adapter.updateProvider({
        target,
        providerName: this.definition.providerName,
        credentials: [{ name: this.definition.credentialEnv, value: input.credentialValue }],
        config: [],
      });
      if (!updated.ok && this.mutationOutcomeMayBeAmbiguous(updated.error)) {
        throw new NativeProviderError(
          `OpenShell did not confirm whether provider '${this.definition.providerName}' accepted its credential update. No provider receipt was recorded.`,
        );
      }
      if (!updated.ok) {
        throw new NativeProviderError(
          `Could not update OpenShell provider '${this.definition.providerName}': ${this.providerErrorDetail(updated.error)}`,
        );
      }
      const observed = await this.inspectNativeProvider(adapter, target);
      if (!observed) {
        throw new NativeProviderError(
          `OpenShell did not confirm provider '${this.definition.providerName}' after its credential update.`,
        );
      }
      const observedReceipt = this.nativeProviderAttachmentFromMetadata(observed);
      if (observedReceipt.providerId !== input.expected.providerId) {
        throw new NativeProviderError(
          `OpenShell provider '${this.definition.providerName}' changed identity during its credential update. No provider receipt was recorded.`,
        );
      }
      return observedReceipt;
    }

    if (input.expected) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' is missing. Recreate the sandbox before using native ${this.definition.label} inference. No provider was changed.`,
      );
    }

    if (!input.credentialValue && !input.reuseExistingCredential) {
      throw new NativeProviderError(
        `A host credential is required to create OpenShell provider '${this.definition.providerName}'.`,
      );
    }
    await activatePolicy();
    const created = await adapter.createProvider({
      target,
      name: this.definition.providerName,
      type: this.definition.profileId,
      credentials: input.credentialValue
        ? [{ name: this.definition.credentialEnv, value: input.credentialValue }]
        : [],
      config: [],
      fromExisting: !input.credentialValue,
    });
    if (!created.ok && !this.mutationOutcomeMayBeAmbiguous(created.error)) {
      throw new NativeProviderError(
        `Could not create OpenShell provider '${this.definition.providerName}': ${this.providerErrorDetail(created.error)}`,
      );
    }
    const observed = await this.inspectNativeProvider(adapter, target);
    if (!observed) {
      throw new NativeProviderError(
        `OpenShell did not confirm provider '${this.definition.providerName}' after creation.`,
      );
    }
    return this.nativeProviderAttachmentFromMetadata(observed);
  }

  /** Prove that the exact NemoClaw-owned provider is attached to one sandbox. */
  async verifyNativeProviderAttachment(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    if (input.expected) this.requireExpectedReceipt(input.expected);
    await this.requireNativeProviderProfileBoundary(input.adapter, input.target);
    const provider = await this.inspectNativeProvider(input.adapter, input.target);
    if (!provider) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' is missing. Recreate the sandbox to restore native ${this.definition.label} inference.`,
      );
    }
    const receipt = this.nativeProviderAttachmentFromMetadata(provider);
    if (input.expected && input.expected.providerId !== receipt.providerId) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' changed identity. Recreate the sandbox before using native ${this.definition.label} inference.`,
      );
    }
    const attachments = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!attachments.ok) {
      throw new NativeProviderError(
        `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${this.providerErrorDetail(attachments.error)}`,
      );
    }
    if (!attachments.value.names.includes(this.definition.providerName)) {
      throw new NativeProviderError(
        `Sandbox '${input.sandboxName}' does not have its native ${this.definition.label} inference provider attached. Recreate the sandbox; NemoClaw does not migrate existing beta sandboxes automatically.`,
      );
    }
    return receipt;
  }

  /** Attach native provider access and reconcile an ambiguous command through observation. */
  async ensureNativeProviderAttached(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<{ receipt: NativeProviderAttachment<ProfileId, ProviderName>; changed: boolean }> {
    if (input.expected) this.requireExpectedReceipt(input.expected);
    await this.requireNativeProviderProfileBoundary(input.adapter, input.target);
    const provider = await this.inspectNativeProvider(input.adapter, input.target);
    if (!provider) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' is missing. Recreate the sandbox to restore native ${this.definition.label} inference.`,
      );
    }
    const receipt = this.nativeProviderAttachmentFromMetadata(provider);
    if (receipt.providerId !== input.expected.providerId) {
      throw new NativeProviderError(
        `OpenShell provider '${this.definition.providerName}' changed identity. Recreate the sandbox before using native ${this.definition.label} inference.`,
      );
    }
    const before = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!before.ok) {
      throw new NativeProviderError(
        `Could not inspect provider attachments for sandbox '${input.sandboxName}': ${this.providerErrorDetail(before.error)}`,
      );
    }
    if (before.value.names.includes(this.definition.providerName)) {
      return {
        receipt: await this.verifyNativeProviderAttachment(input),
        changed: false,
      };
    }
    const attached = await input.adapter.attachProvider({
      target: input.target,
      sandboxName: input.sandboxName,
      providerName: this.definition.providerName,
    });
    if (!attached.ok && !this.mutationOutcomeMayBeAmbiguous(attached.error)) {
      throw new NativeProviderError(
        `Could not attach native ${this.definition.label} provider to sandbox '${input.sandboxName}': ${this.providerErrorDetail(attached.error)}`,
      );
    }
    try {
      return {
        receipt: await this.verifyNativeProviderAttachment(input),
        changed: true,
      };
    } catch (error) {
      try {
        await this.detachNativeProvider(input);
      } catch (detachError) {
        const detail = error instanceof Error ? error.message : String(error);
        const detachDetail =
          detachError instanceof Error ? detachError.message : String(detachError);
        throw new NativeProviderError(`${detail}\n  ${detachDetail}`);
      }
      throw error;
    }
  }

  /** Detach only the recorded native provider identity and prove absence. */
  async detachNativeProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<void> {
    this.requireExpectedReceipt(input.expected);
    const provider = await this.inspectNativeProvider(input.adapter, input.target);
    if (!provider) return;
    const current = this.nativeProviderAttachmentFromMetadata(provider);
    if (current.providerId !== input.expected.providerId) {
      throw new NativeProviderError(
        `Refusing to detach OpenShell provider '${this.definition.providerName}' because its identity changed.`,
      );
    }
    const detached = await input.adapter.detachProvider({
      target: input.target,
      sandboxName: input.sandboxName,
      providerName: this.definition.providerName,
    });
    if (!detached.ok && !this.mutationOutcomeMayBeAmbiguous(detached.error)) {
      throw new NativeProviderError(
        `Could not detach native ${this.definition.label} provider from sandbox '${input.sandboxName}': ${this.providerErrorDetail(detached.error)}`,
      );
    }
    const after = await input.adapter.listProviderAttachments({
      target: input.target,
      sandboxName: input.sandboxName,
    });
    if (!after.ok || after.value.names.includes(this.definition.providerName)) {
      throw new NativeProviderError(
        `OpenShell did not confirm removal of native provider access from sandbox '${input.sandboxName}'.`,
      );
    }
  }
}

export function nativeProviderLifecycle<ProfileId extends string, ProviderName extends string>(
  definition: NativeProviderDefinition<ProfileId, ProviderName>,
) {
  return new NativeProviderLifecycle(definition);
}
