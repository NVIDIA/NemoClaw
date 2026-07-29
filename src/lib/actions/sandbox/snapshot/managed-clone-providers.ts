// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
} from "../../../onboard/brave-provider-profile";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  parseGatewayProviderMetadata,
} from "../../../onboard/gateway-provider-metadata";
import type { ManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import { deleteProviderWithRecovery } from "../../../onboard/sandbox-provider-cleanup";

type ManagedCloneProviderSource = "messaging" | "web-search";

type ManagedCloneProviderCommandResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
};

export type ManagedCloneProviderRunner = (
  args: string[],
  options?: {
    readonly [key: string]: unknown;
    readonly ignoreError?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio?: ["ignore", "ignore" | "pipe", "ignore" | "pipe"];
  },
) => ManagedCloneProviderCommandResult;

export interface PreparedManagedCloneProvider {
  readonly providerName: string;
  readonly providerType: string;
  readonly providerEnvKey: string;
  readonly source: ManagedCloneProviderSource;
  /**
   * Only a force-replaced destination authorizes rotation of an existing
   * destination-named provider. An absent destination cannot prove that an
   * orphan provider's secret belongs to the source being cloned.
   */
  readonly replaceExistingCredential: boolean;
}

type ProviderInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "exact" }
  | { readonly kind: "collision" };

function commandStreamText(value: string | Buffer | null | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");
}

function inspectProvider(
  provider: Pick<PreparedManagedCloneProvider, "providerName" | "providerType" | "providerEnvKey">,
  runOpenshell: ManagedCloneProviderRunner,
): ProviderInspection {
  const inspection = runOpenshell(["provider", "get", provider.providerName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspection.status !== 0) return { kind: "missing" };

  const metadata = parseGatewayProviderMetadata(
    `${commandStreamText(inspection.stdout)}\n${commandStreamText(inspection.stderr)}`,
  );
  return matchesGatewayCredentialOnlyProviderBinding(metadata, {
    name: provider.providerName,
    type: provider.providerType,
    credentialKey: provider.providerEnvKey,
  })
    ? { kind: "exact" }
    : { kind: "collision" };
}

function hasCredential(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name];
  return typeof value === "string" && value.replace(/\r/gu, "").trim().length > 0;
}

function activeMessagingCredentialBindings(
  plan: SandboxMessagingPlan,
): readonly SandboxMessagingPlan["credentialBindings"][number][] {
  const activeChannels = new Set(
    plan.channels
      .filter(
        (channel) =>
          channel.active && !channel.disabled && !plan.disabledChannels.includes(channel.channelId),
      )
      .map((channel) => channel.channelId),
  );
  return plan.credentialBindings.filter((binding) => activeChannels.has(binding.channelId));
}

function addProvider(
  providers: Map<string, Omit<PreparedManagedCloneProvider, "replaceExistingCredential">>,
  provider: Omit<PreparedManagedCloneProvider, "replaceExistingCredential">,
): void {
  const existing = providers.get(provider.providerName);
  if (
    existing &&
    (existing.providerType !== provider.providerType ||
      existing.providerEnvKey !== provider.providerEnvKey)
  ) {
    throw new Error(
      `managed clone provider '${provider.providerName}' has conflicting credential bindings`,
    );
  }
  if (!existing) providers.set(provider.providerName, provider);
}

function addMessagingProviders(
  providers: Map<string, Omit<PreparedManagedCloneProvider, "replaceExistingCredential">>,
  plan: SandboxMessagingPlan | null,
): void {
  if (!plan) return;
  for (const binding of activeMessagingCredentialBindings(plan)) {
    addProvider(providers, {
      providerName: binding.providerName,
      providerType: "generic",
      providerEnvKey: binding.providerEnvKey,
      source: "messaging",
    });
  }
}

function addWebSearchProvider(
  providers: Map<string, Omit<PreparedManagedCloneProvider, "replaceExistingCredential">>,
  profile: ManagedStartupProfile,
  destinationSandboxName: string,
): void {
  if (profile.agentConfig.agent === "langchain-deepagents-code") return;
  const webSearch = profile.agentConfig.webSearch;
  if (!webSearch.enabled) return;
  const providerType =
    profile.agent === "hermes" && webSearch.provider === "tavily"
      ? HERMES_TAVILY_PROVIDER_PROFILE_ID
      : webSearch.provider;
  addProvider(providers, {
    providerName: `${destinationSandboxName}-${webSearch.provider}-search`,
    providerType,
    providerEnvKey: webSearch.provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY",
    source: "web-search",
  });
}

function assertHermesToolGatewayCloneIsRecredentialable(profile: ManagedStartupProfile): void {
  if (profile.agent !== "hermes" || profile.tools.enabledGateways.length === 0) return;
  throw new Error(
    "managed Hermes tool gateways cannot yet be cloned without a fresh Nous OAuth refresh " +
      "credential and destination broker binding; disable the gateways or re-onboard the clone",
  );
}

function ensureRequiredWebSearchProfiles(
  providers: readonly Omit<PreparedManagedCloneProvider, "replaceExistingCredential">[],
  root: string,
  runOpenshell: ManagedCloneProviderRunner,
): void {
  const webSearchProviders = providers.filter((provider) => provider.source === "web-search");
  if (webSearchProviders.length === 0) return;
  ensureWebSearchProviderProfiles(
    webSearchProviders.map((provider) => ({
      providerType: provider.providerType,
      // Profile registration only needs the non-secret fact that this provider
      // will be attached; never pass the actual credential through this layer.
      token: "credential-binding-present",
    })),
    {
      root,
      runOpenshell,
      // Diagnostics are intentionally suppressed below. Do not introduce a
      // second secret-bearing logging path merely to satisfy the profile
      // helper's redaction dependency.
      redact: () => "",
      log: () => {},
      exit: (code = 1): never => {
        throw new Error(`failed to register managed web-search provider profile (exit ${code})`);
      },
    },
  );
}

/**
 * Build and validate every credential-provider binding the rebound profile
 * will attach. This runs before destination deletion so absent credentials,
 * colliding provider identities, unsupported broker state, and provider
 * profile import failures all leave a force-restore destination untouched.
 */
export function prepareManagedCloneProviders(input: {
  readonly profile: ManagedStartupProfile;
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly destinationSandboxName: string;
  readonly destinationWillBeReplaced: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly root: string;
  readonly runOpenshell: ManagedCloneProviderRunner;
}): readonly PreparedManagedCloneProvider[] {
  assertHermesToolGatewayCloneIsRecredentialable(input.profile);

  const pending = new Map<
    string,
    Omit<PreparedManagedCloneProvider, "replaceExistingCredential">
  >();
  addMessagingProviders(pending, input.messagingPlan);
  addWebSearchProvider(pending, input.profile, input.destinationSandboxName);
  const environment = input.environment ?? process.env;
  const prepared: PreparedManagedCloneProvider[] = [];

  for (const provider of pending.values()) {
    const inspection = inspectProvider(provider, input.runOpenshell);
    if (inspection.kind === "collision") {
      throw new Error(
        `managed clone provider '${provider.providerName}' exists with an incompatible ` +
          `type or credential binding`,
      );
    }
    if (inspection.kind === "exact" && !input.destinationWillBeReplaced) {
      throw new Error(
        `managed clone provider '${provider.providerName}' already exists without a ` +
          "replaceable destination; refusing unproven credential reuse",
      );
    }
    if (!hasCredential(environment, provider.providerEnvKey)) {
      throw new Error(
        `managed ${provider.source} provider '${provider.providerName}' requires an explicit ` +
          `clone credential; export ${provider.providerEnvKey} before retrying`,
      );
    }
    prepared.push({
      ...provider,
      replaceExistingCredential: input.destinationWillBeReplaced,
    });
  }

  // Import immutable custom profiles while the destination is still intact.
  // Provisioning below can then fail only on provider CRUD/races, not on a
  // missing Brave/Tavily/Hermes-Tavily profile artifact.
  ensureRequiredWebSearchProfiles([...pending.values()], input.root, input.runOpenshell);
  return prepared;
}

function cleanupCreatedProviders(
  providerNames: readonly string[],
  runOpenshell: ManagedCloneProviderRunner,
  authorizedSandboxName?: string,
): void {
  for (const providerName of [...providerNames].reverse()) {
    const result = authorizedSandboxName
      ? deleteProviderWithRecovery(providerName, {
          runOpenshell,
          allowedSandboxes: [authorizedSandboxName],
        })
      : runOpenshell(["provider", "delete", providerName], {
          ignoreError: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
    const deleted = "ok" in result ? result.ok : result.status === 0;
    if (!deleted) {
      console.warn(
        `  Warning: could not clean up managed clone provider '${providerName}' after failure.`,
      );
    }
  }
}

/**
 * Materialize any preflighted provider that is not already exact, then prove
 * the resulting metadata before its name is placed on sandbox-create argv.
 */
export function provisionManagedCloneProviders(
  prepared: readonly PreparedManagedCloneProvider[],
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly runOpenshell: ManagedCloneProviderRunner;
    readonly rollbackSandboxName?: string;
  },
): string[] {
  const environment = input.environment ?? process.env;
  // Updates are authorized only for a force-replaced destination that is
  // already gone. Track them exactly like creates so a later provider or
  // sandbox-create failure cannot leave a rotated credential-bearing orphan.
  const mutated: string[] = [];
  try {
    for (const provider of prepared) {
      const current = inspectProvider(provider, input.runOpenshell);
      if (current.kind === "collision") {
        throw new Error(
          `managed clone provider '${provider.providerName}' changed to an incompatible binding`,
        );
      }
      if (current.kind === "exact" && !provider.replaceExistingCredential) {
        throw new Error(
          `managed clone provider '${provider.providerName}' appeared before launch; ` +
            "refusing unproven credential reuse",
        );
      }

      const credential = environment[provider.providerEnvKey]?.replace(/\r/gu, "").trim();
      if (!credential) {
        throw new Error(
          `managed clone credential ${provider.providerEnvKey} disappeared before provider creation`,
        );
      }
      const action = current.kind === "exact" ? "update" : "create";
      const args =
        action === "update"
          ? ["provider", "update", provider.providerName, "--credential", provider.providerEnvKey]
          : [
              "provider",
              "create",
              "--name",
              provider.providerName,
              "--type",
              provider.providerType,
              "--credential",
              provider.providerEnvKey,
            ];
      const result = input.runOpenshell(args, {
        ignoreError: true,
        env: { [provider.providerEnvKey]: credential },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status !== 0) {
        throw new Error(`failed to ${action} managed clone provider '${provider.providerName}'`);
      }
      mutated.push(provider.providerName);
      if (inspectProvider(provider, input.runOpenshell).kind !== "exact") {
        throw new Error(
          `managed clone provider '${provider.providerName}' did not retain its exact binding`,
        );
      }
    }
    return mutated;
  } catch (error) {
    cleanupCreatedProviders(mutated, input.runOpenshell, input.rollbackSandboxName);
    throw error;
  }
}

export function cleanupManagedCloneProviders(
  providerNames: readonly string[],
  runOpenshell: ManagedCloneProviderRunner,
  authorizedSandboxName?: string,
): void {
  cleanupCreatedProviders(providerNames, runOpenshell, authorizedSandboxName);
}
