// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, normalizeCredentialValue } from "../credentials/store";
import * as registry from "../state/registry";
import * as channelState from "./channel-state";
import * as extraPlaceholderKeys from "./extra-placeholder-keys";
import { readMessagingPlanFromEnv } from "./messaging-channel-setup";
import { getMessagingChannelForEnvKey } from "./messaging-credentials";
import { getValidatedMessagingTokenByEnvKey } from "./messaging-token";
import type { AuthoritativeMessagingReuse } from "./options";
import * as sandboxMessagingPreflight from "./sandbox-messaging-preflight";

export type AuthoritativeRebuildMessagingDeps = {
  gatewayName(): string;
  providerExistsInGateway(name: string): boolean;
  isNonInteractive(): boolean;
  promptYesNoOrDefault(
    question: string,
    envVar: string | null,
    defaultIsYes: boolean,
  ): Promise<boolean>;
  cliName(): string;
  getHermesToolGatewayBroker(): {
    ensureHermesToolGatewayBroker(): boolean;
    getHermesToolGatewayProviderName(sandboxName: string): string;
  };
};

type MessagingSnapshotOptions = {
  sandboxName: string;
  targetGatewayName: string;
  webSearchEnabled: boolean;
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function withTargetGateway<T>(targetGatewayName: string, action: () => T): T {
  const previousGateway = process.env.OPENSHELL_GATEWAY;
  process.env.OPENSHELL_GATEWAY = targetGatewayName;
  try {
    return action();
  } finally {
    if (previousGateway === undefined) delete process.env.OPENSHELL_GATEWAY;
    else process.env.OPENSHELL_GATEWAY = previousGateway;
  }
}

async function withTargetGatewayAsync<T>(
  targetGatewayName: string,
  action: () => Promise<T>,
): Promise<T> {
  const previousGateway = process.env.OPENSHELL_GATEWAY;
  process.env.OPENSHELL_GATEWAY = targetGatewayName;
  try {
    return await action();
  } finally {
    if (previousGateway === undefined) delete process.env.OPENSHELL_GATEWAY;
    else process.env.OPENSHELL_GATEWAY = previousGateway;
  }
}

export function createAuthoritativeRebuildMessagingHelpers(
  deps: AuthoritativeRebuildMessagingDeps,
) {
  function createSandboxMessagingPreflightDeps(
    options: {
      gatewayName?: string;
      forceNonInteractive?: boolean;
      exitProcess?: (code: number) => never;
    } = {},
  ): sandboxMessagingPreflight.SandboxMessagingPreflightDeps {
    return {
      readMessagingPlanFromEnv,
      resolveDisabledChannels: channelState.resolveDisabledChannels,
      gatewayName: options.gatewayName ?? deps.gatewayName(),
      registry,
      providerExistsInGateway: deps.providerExistsInGateway,
      isNonInteractive:
        options.forceNonInteractive === undefined
          ? deps.isNonInteractive
          : () => options.forceNonInteractive === true,
      promptYesNoOrDefault: deps.promptYesNoOrDefault,
      cliName: deps.cliName,
      log: (message) => console.log(message),
      error: (message) => console.error(message),
      exitProcess: options.exitProcess ?? ((code) => process.exit(code)),
      getValidatedMessagingTokenByEnvKey,
      getCredential,
      normalizeCredentialValue,
      registerExtraPlaceholderProviders: extraPlaceholderKeys.registerExtraPlaceholderProviders,
      getMessagingChannelForEnvKey,
    };
  }

  function snapshotAuthoritativeRebuildMessagingState(
    options: MessagingSnapshotOptions,
  ): AuthoritativeMessagingReuse {
    const storedDisabledChannels = channelState.resolveDisabledChannels(options.sandboxName);
    return withTargetGateway(options.targetGatewayName, () => {
      const plan = readMessagingPlanFromEnv();
      if (plan && plan.sandboxName !== options.sandboxName) {
        throw new Error(
          `Recorded messaging plan belongs to '${plan.sandboxName}', not '${options.sandboxName}'.`,
        );
      }
      const targetPlan = plan;
      const disabled = new Set([
        ...(targetPlan?.disabledChannels ?? []),
        ...storedDisabledChannels,
      ]);
      const channels = sortedUnique(
        targetPlan
          ? targetPlan.channels
              .filter((channel) => channel.active === true && !disabled.has(channel.channelId))
              .map((channel) => channel.channelId)
          : [],
      );
      const activeChannels = new Set(channels);
      const allMessagingProviders = sortedUnique(
        targetPlan ? targetPlan.credentialBindings.map((binding) => binding.providerName) : [],
      );
      const activeProviders = targetPlan
        ? targetPlan.credentialBindings
            .filter((binding) => activeChannels.has(binding.channelId))
            .map((binding) => binding.providerName)
        : [];
      if (options.webSearchEnabled) {
        activeProviders.push(`${options.sandboxName}-brave-search`);
      }

      const sandboxEntry = registry.getSandbox(options.sandboxName);
      const rawExtraPlaceholderKeys = sandboxEntry?.extraPlaceholderKeys ?? [];
      if (!Array.isArray(rawExtraPlaceholderKeys)) {
        throw new Error("Recorded extra placeholder keys are malformed.");
      }
      const parsedExtraPlaceholderKeys = extraPlaceholderKeys.parseExtraPlaceholderKeys(
        rawExtraPlaceholderKeys.join(","),
        extraPlaceholderKeys.canonicalPlaceholderKeys(),
      );
      const parsedKeys = sortedUnique(parsedExtraPlaceholderKeys.keys);
      const normalizedRawKeys = sortedUnique(rawExtraPlaceholderKeys);
      if (
        parsedExtraPlaceholderKeys.warnings.length > 0 ||
        parsedKeys.length !== normalizedRawKeys.length ||
        parsedKeys.some((key, index) => key !== normalizedRawKeys[index])
      ) {
        throw new Error("Recorded extra placeholder keys are invalid.");
      }
      const extraPlaceholderProviders = parsedKeys.map(
        (envKey) =>
          `${options.sandboxName}-extra-${extraPlaceholderKeys.extraPlaceholderProviderSlug(envKey)}`,
      );
      const providers = sortedUnique([...activeProviders, ...extraPlaceholderProviders]);
      const extraProviders = sortedUnique(registry.listExtraProviders());
      const requiredProviders = sortedUnique([...providers, ...extraProviders]);
      const providerExists = new Map(
        sortedUnique([...allMessagingProviders, ...requiredProviders]).map((providerName) => [
          providerName,
          deps.providerExistsInGateway(providerName),
        ]),
      );
      for (const providerName of requiredProviders) {
        if (!providerExists.get(providerName)) {
          throw new Error(`Recorded sandbox provider '${providerName}' is not registered.`);
        }
      }
      const detachProviders = sortedUnique([
        ...requiredProviders,
        ...allMessagingProviders.filter((providerName) => providerExists.get(providerName)),
      ]);
      return {
        providers,
        channels,
        disabledChannels: sortedUnique([...disabled]),
        detachProviders,
        extraProviders,
        extraPlaceholderKeys: parsedKeys,
      };
    });
  }

  async function preflightAuthoritativeRebuildMessagingConflicts(
    options: MessagingSnapshotOptions,
  ): Promise<AuthoritativeMessagingReuse> {
    const disabledChannels = channelState.resolveDisabledChannels(options.sandboxName);
    await withTargetGatewayAsync(options.targetGatewayName, () =>
      sandboxMessagingPreflight.checkMessagingPlanConflicts(
        options.sandboxName,
        disabledChannels,
        createSandboxMessagingPreflightDeps({
          gatewayName: options.targetGatewayName,
          forceNonInteractive: true,
          exitProcess: (code): never => {
            throw new Error(`messaging conflict preflight exited with code ${String(code)}`);
          },
        }),
      ),
    );
    return snapshotAuthoritativeRebuildMessagingState(options);
  }

  async function preflightAuthoritativeHermesToolGateways(options: {
    sandboxName: string;
    targetGatewayName: string;
    toolGateways: string[];
  }): Promise<string | null> {
    if (options.toolGateways.length === 0) return null;
    return withTargetGateway(options.targetGatewayName, () => {
      const broker = deps.getHermesToolGatewayBroker();
      if (!broker.ensureHermesToolGatewayBroker()) {
        throw new Error(
          "Hermes managed-tool broker is unavailable or its recorded runtime identity changed.",
        );
      }
      const providerName = broker.getHermesToolGatewayProviderName(options.sandboxName);
      if (!deps.providerExistsInGateway(providerName)) {
        throw new Error(`Hermes managed-tool provider '${providerName}' is not registered.`);
      }
      return providerName;
    });
  }

  async function preflightAuthoritativeProviderAttachments(options: {
    targetGatewayName: string;
    providerNames: string[];
  }): Promise<void> {
    withTargetGateway(options.targetGatewayName, () => {
      for (const providerName of [...new Set(options.providerNames)]) {
        if (!deps.providerExistsInGateway(providerName)) {
          throw new Error(`Recorded sandbox provider '${providerName}' is not registered.`);
        }
      }
    });
  }

  return {
    createSandboxMessagingPreflightDeps,
    preflightAuthoritativeHermesToolGateways,
    preflightAuthoritativeProviderAttachments,
    preflightAuthoritativeRebuildMessagingConflicts,
    snapshotAuthoritativeRebuildMessagingState,
  };
}
