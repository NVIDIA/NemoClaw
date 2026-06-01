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
import type { MessagingHookInputMap, MessagingHookOutputMap, MessagingHookRunResult } from "../hooks";

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
  readonly stdio?: readonly unknown[];
}

export interface MessagingOpenShellRunResult {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

export type MessagingOpenShellRunner = (
  args: readonly string[],
  options?: MessagingOpenShellRunOptions,
) => MessagingOpenShellRunResult;

export interface MessagingCredentialApplyOptions extends MessagingSetupEnvOptions {
  readonly runOpenshell: MessagingOpenShellRunner;
}

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
