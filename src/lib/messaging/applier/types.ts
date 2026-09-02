// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHookFailureMode,
  ChannelHookOutputSpec,
  ChannelHookPhase,
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingPlan,
} from "../manifest";
import type {
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRunResult,
} from "../hooks";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";

export const MESSAGING_SETUP_APPLIER_ENV_KEY = "NEMOCLAW_MESSAGING_PLAN_B64";

export interface MessagingSetupEnvOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly envKey?: string;
}

export interface MessagingHookApplyRequest {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly channelId: MessagingChannelId;
  readonly hookId: string;
  readonly phase: ChannelHookPhase;
  readonly handler: string;
  readonly inputKeys?: readonly string[];
  readonly inputs: MessagingHookInputMap;
  readonly outputs?: readonly ChannelHookOutputSpec[];
  readonly onFailure?: ChannelHookFailureMode;
}

export type MessagingHookApplyRunner = (
  request: MessagingHookApplyRequest,
) =>
  | void
  | MessagingHookRunResult
  | { readonly outputs?: MessagingHookOutputMap }
  | Promise<void | MessagingHookRunResult | { readonly outputs?: MessagingHookOutputMap }>;

export interface MessagingOpenShellRunOptions {
  readonly ignoreError?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly maxBuffer?: number;
  readonly suppressOutput?: boolean;
  readonly stdio?: readonly unknown[];
  readonly timeout?: number;
}

export interface MessagingOpenShellRunResult {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly signal?: unknown;
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export type MessagingOpenShellRunner = (
  args: readonly string[],
  options?: MessagingOpenShellRunOptions,
) => MessagingOpenShellRunResult;

export type MessagingCredentialProviderProfile = Readonly<{
  profilePath: string;
  profileType: string;
}>;

export type MessagingCredentialProviderDefinition = Readonly<{
  channelId: MessagingChannelId;
  credentialId: string;
  providerName: string;
  providerType: string;
  credentials: readonly Readonly<{ name: string; value: string | null }>[];
  profile: MessagingCredentialProviderProfile;
}>;

export type MessagingProviderRefreshDefinition = Readonly<{
  channelId: MessagingChannelId;
  providerName: string;
  credentialKey: string;
  strategy: string;
  material: readonly Readonly<{ key: string; value: string }>[];
  secretMaterial: readonly Readonly<{ key: string; value: string }>[];
}>;

type MessagingCredentialProviderBoundary =
  | Readonly<{ providerAdapter: OpenShellProviderAdapter; runOpenshell?: never }>
  | Readonly<{ providerAdapter?: never; runOpenshell: MessagingOpenShellRunner }>;

export type MessagingCredentialApplyOptions = MessagingSetupEnvOptions &
  MessagingCredentialProviderBoundary &
  Readonly<{
    target?: OpenShellGatewayTarget;
    definitions?: readonly MessagingCredentialProviderDefinition[];
    refreshes?: readonly MessagingProviderRefreshDefinition[];
    replaceExisting?: boolean;
    allowedSandboxes?: readonly string[];
    attachToSandbox?: string;
    revalidateSandboxIdentity?(operation: string): void;
    sleep?(milliseconds: number): Promise<void>;
    now?(): number;
    log?(message: string): void;
  }>;

export type MessagingProviderCleanupOptions = Readonly<{
  providerAdapter: OpenShellProviderAdapter;
  target?: OpenShellGatewayTarget;
  allowedSandboxes?: readonly string[];
  revalidateSandboxIdentity?(operation: string): void;
}>;

export type MessagingProviderCleanupResult = Readonly<{
  removedProviderNames: readonly string[];
  absentProviderNames: readonly string[];
  detachedAttachments: readonly Readonly<{ providerName: string; sandboxName: string }>[];
  residualProviders: readonly Readonly<{
    providerName: string;
    error: OpenShellProviderError;
  }>[];
}>;

export interface MessagingCredentialApplyResult {
  readonly upserted: readonly {
    readonly channelId: MessagingChannelId;
    readonly credentialId: string;
    readonly providerName: string;
    readonly envKey: string;
    readonly action: "create" | "update";
  }[];
  readonly reused: readonly {
    readonly channelId: MessagingChannelId;
    readonly credentialId: string;
    readonly providerName: string;
    readonly envKey: string;
  }[];
  readonly missing: readonly {
    readonly channelId: MessagingChannelId;
    readonly credentialId: string;
    readonly providerName: string;
    readonly envKey: string;
  }[];
  readonly providerNames: readonly string[];
  readonly sandboxCreateProviderArgs: readonly string[];
}

export interface MessagingPolicyApplyContext {
  readonly agent: MessagingAgentId;
  readonly entries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  readonly policyKeys: readonly string[];
}

export interface MessagingPolicyApplyOptions {
  readonly applyPresets: (
    sandboxName: string,
    presetNames: string[],
    context: MessagingPolicyApplyContext,
  ) => boolean;
}

export interface MessagingPolicyApplyResult {
  readonly appliedPresets: readonly string[];
  readonly appliedPolicyKeys: readonly string[];
}

export type MessagingSerializablePlan = SandboxMessagingPlan;
export type MessagingSerializableHook = SandboxMessagingHookReferencePlan;
