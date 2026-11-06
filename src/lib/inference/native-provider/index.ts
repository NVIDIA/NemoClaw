// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { withHermesNativeProfile } from "./hermes-profile";
import { withCustomNativeProfile } from "./custom";

import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  normalizeNativeProviderAttachment,
  type NativeProviderAttachment,
  type NativeProviderDefinition,
} from "./contract";

import * as lifecycle from "./lifecycle";
import { NativeProviderError } from "./lifecycle";
export { NativeProviderError } from "./lifecycle";

/** Bind hosted profile materialization and receipts to the shared provider lifecycle. */
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
      `${this.definition.custom ? (this.definition.custom.api === "anthropic-messages" ? "nemoclaw-anthropic-inference-v1" : "nemoclaw-openai-inference-v1") : this.definition.profileId}.yaml`,
    );
  }

  private profile(profilePath = this.nativeProviderProfilePath()): lifecycle.NativeProviderProfile {
    return { ...this.definition, profilePath };
  }

  private withProfile<T>(
    operation: (profile: lifecycle.NativeProviderProfile) => Promise<T>,
    profilePath = this.nativeProviderProfilePath(),
  ): Promise<T> {
    const run = (boundPath: string) => operation(this.profile(boundPath));
    if (this.definition.custom) return withCustomNativeProfile(this.definition, run, profilePath);
    if (this.definition.endpointUrl) return withHermesNativeProfile(this.definition, run);
    return run(profilePath);
  }

  private bindReceipt(
    receipt: lifecycle.NativeProviderAttachment,
  ): NativeProviderAttachment<ProfileId, ProviderName> {
    return {
      schemaVersion: 1,
      profileId: this.definition.profileId,
      providerName: this.definition.providerName,
      providerId: receipt.providerId,
      ...(this.definition.endpointUrl ? { endpointUrl: this.definition.endpointUrl } : {}),
      ...(this.definition.allowedIps ? { allowedIps: [...this.definition.allowedIps] } : {}),
      ...(this.definition.custom ? { custom: this.definition.custom } : {}),
    };
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

  async requireNativeProviderProfileBoundary(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
    profilePath = this.nativeProviderProfilePath(),
  ): Promise<void> {
    await this.withProfile(
      (profile) => lifecycle.requireNativeProviderProfileBoundary(adapter, target, profile),
      profilePath,
    );
  }

  nativeProviderAttachmentFromMetadata(
    metadata: OpenShellProviderMetadata,
  ): NativeProviderAttachment<ProfileId, ProviderName> {
    return this.bindReceipt(
      lifecycle.nativeProviderAttachmentFromMetadata(metadata, this.profile()),
    );
  }

  async inspectNativeProvider(
    adapter: OpenShellProviderAdapter,
    target: OpenShellGatewayTarget,
  ): Promise<OpenShellProviderMetadata | null> {
    return lifecycle.inspectNativeProvider(adapter, target, this.profile());
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
    await lifecycle.persistNativeProviderAuthority({
      ...input,
      profile: this.profile(),
      recoveryGuidance: `Run 'nemoclaw credentials reset ${this.definition.custom ? this.definition.providerName : this.definition.logicalProvider} --yes' against gateway '${input.gatewayName}', then retry.`,
      writeAuthority: (gatewayName) => input.writeAuthority(gatewayName, input.receipt),
    });
  }

  /** Ensure the restricted provider profile and provider without retrying an ambiguous mutation. */
  async ensureNativeProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    credentialValue: string | null;
    reuseExistingCredential?: boolean;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
    /** Registry sandbox whose receipt is the only ownership evidence for `expected`. */
    recordedSandboxName?: string;
    profilePath?: string;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    if (input.expected) this.requireExpectedReceipt(input.expected);
    return this.withProfile(
      async (profile) =>
        this.bindReceipt(
          await lifecycle.ensureNativeProvider({
            ...input,
            profile,
            profilePath: profile.profilePath,
            prepareProviderPolicy: async () => {
              const policy = await input.adapter.ensureProviderPolicyComposition({
                target: input.target,
              });
              if (!policy.ok)
                throw new NativeProviderError(
                  `Could not activate native ${this.definition.label} provider policy: ${lifecycle.providerErrorDetail(policy.error)}`,
                );
            },
          }),
        ),
      input.profilePath,
    );
  }

  /** Prove that the exact NemoClaw-owned provider is attached to one sandbox. */
  async verifyNativeProviderAttachment(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected?: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<NativeProviderAttachment<ProfileId, ProviderName>> {
    if (input.expected) this.requireExpectedReceipt(input.expected);
    return this.bindReceipt(
      await lifecycle.verifyNativeProviderAttachment({
        ...input,
        profile: this.profile(),
        verifyProfileBoundary: () =>
          this.requireNativeProviderProfileBoundary(input.adapter, input.target),
      }),
    );
  }

  /** Attach native provider access and reconcile an ambiguous command through observation. */
  async ensureNativeProviderAttached(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<{ receipt: NativeProviderAttachment<ProfileId, ProviderName>; changed: boolean }> {
    this.requireExpectedReceipt(input.expected);
    const result = await lifecycle.ensureNativeProviderAttached({
      ...input,
      profile: this.profile(),
      verifyProfileBoundary: () =>
        this.requireNativeProviderProfileBoundary(input.adapter, input.target),
    });
    return { ...result, receipt: this.bindReceipt(result.receipt) };
  }

  /** Detach only the recorded native provider identity and prove absence. */
  async detachNativeProvider(input: {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    sandboxName: string;
    expected: NativeProviderAttachment<ProfileId, ProviderName>;
  }): Promise<void> {
    this.requireExpectedReceipt(input.expected);
    await lifecycle.detachNativeProvider({ ...input, profile: this.profile() });
  }
}

export function nativeProviderLifecycle<ProfileId extends string, ProviderName extends string>(
  definition: NativeProviderDefinition<ProfileId, ProviderName>,
) {
  return new NativeProviderLifecycle(definition);
}
