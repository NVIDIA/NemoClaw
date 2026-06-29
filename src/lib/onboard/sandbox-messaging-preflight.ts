// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { SandboxMessagingPlan } from "../messaging/manifest/types";
import {
  enforceMessagingChannelConflicts as defaultEnforceMessagingChannelConflicts,
  type MessagingConflictGuardDeps,
} from "./messaging-conflict-guard";
import {
  prepareCreateSandboxMessaging as defaultPrepareCreateSandboxMessaging,
  type CreateSandboxMessagingPrepInput,
  type CreateSandboxMessagingPrepResult,
  type NamedMessagingChannel,
} from "./messaging-prep";

export interface SandboxMessagingPreflightInput {
  sandboxName: string;
  channels: readonly NamedMessagingChannel[];
  enabledChannels: readonly string[] | null;
  webSearchConfig: WebSearchConfig | null;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface SandboxMessagingPreflightDeps {
  readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
  resolveDisabledChannels(sandboxName: string): string[];
  gatewayName: string;
  registry: MessagingConflictGuardDeps["registry"];
  providerExistsInGateway(name: string): boolean;
  isNonInteractive(): boolean;
  promptYesNoOrDefault(
    message: string,
    defaultValue: string | null,
    fallback: boolean,
  ): Promise<boolean>;
  cliName(): string;
  log(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
  getValidatedMessagingTokenByEnvKey(
    channels: readonly NamedMessagingChannel[],
    envKey: string,
  ): string | null;
  getCredential(envKey: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  registerExtraPlaceholderProviders(
    sandboxName: string,
    messagingTokenDefs: CreateSandboxMessagingPrepResult["messagingTokenDefs"],
  ): string[];
  getMessagingChannelForEnvKey(envKey: string): string | null;
  prepareCreateSandboxMessaging?: (
    input: CreateSandboxMessagingPrepInput,
  ) => CreateSandboxMessagingPrepResult;
  enforceMessagingChannelConflicts?: (deps: MessagingConflictGuardDeps) => Promise<void>;
}

export interface SandboxMessagingPreflightResult extends CreateSandboxMessagingPrepResult {
  disabledChannels: string[];
}

export async function prepareSandboxMessagingPreflight(
  input: SandboxMessagingPreflightInput,
  deps: SandboxMessagingPreflightDeps,
): Promise<SandboxMessagingPreflightResult> {
  const disabledChannels = deps.resolveDisabledChannels(input.sandboxName);
  await checkMessagingPlanConflicts(input.sandboxName, disabledChannels, deps);

  const result = (deps.prepareCreateSandboxMessaging ?? defaultPrepareCreateSandboxMessaging)({
    sandboxName: input.sandboxName,
    channels: input.channels,
    enabledChannels: input.enabledChannels,
    disabledChannels,
    webSearchConfig: input.webSearchConfig,
    env: input.env,
    getValidatedMessagingTokenByEnvKey: deps.getValidatedMessagingTokenByEnvKey,
    getCredential: deps.getCredential,
    normalizeCredentialValue: deps.normalizeCredentialValue,
    registerExtraPlaceholderProviders: deps.registerExtraPlaceholderProviders,
    getMessagingChannelForEnvKey: deps.getMessagingChannelForEnvKey,
    providerExistsInGateway: deps.providerExistsInGateway,
  });

  if (result.missingBraveApiKey) {
    deps.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    deps.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    deps.exitProcess(1);
  }

  return { ...result, disabledChannels };
}

async function checkMessagingPlanConflicts(
  sandboxName: string,
  disabledChannels: readonly string[],
  deps: SandboxMessagingPreflightDeps,
): Promise<void> {
  const envPlan = deps.readMessagingPlanFromEnv();
  const currentPlan = envPlan?.sandboxName === sandboxName ? envPlan : null;
  if (!currentPlan) return;

  const enforceMessagingChannelConflicts =
    deps.enforceMessagingChannelConflicts ?? defaultEnforceMessagingChannelConflicts;
  await enforceMessagingChannelConflicts({
    sandboxName,
    gatewayName: deps.gatewayName,
    currentPlan,
    currentSandboxDisabledChannels: disabledChannels,
    registry: deps.registry,
    isNonInteractive: deps.isNonInteractive,
    promptContinue: () => deps.promptYesNoOrDefault("  Continue anyway?", null, false),
    cliName: deps.cliName,
    log: deps.log,
    error: deps.error,
    exit: deps.exitProcess,
  });
}
