// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import {
  getHermesToolGatewayCloneBroker,
  type HermesToolGatewayCloneBroker,
} from "../../../hermes-tool-gateway-clone-broker";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
} from "../../../onboard/brave-provider-profile";
import { reportsExactProviderNotFound } from "../../../onboard/extra-provider-diagnostic-parser";
import {
  matchesGatewayCredentialOnlyProviderBinding,
  parseGatewayProviderMetadata,
} from "../../../onboard/gateway-provider-metadata";
import type { ManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import { deleteProviderWithRecovery } from "../../../onboard/sandbox-provider-cleanup";

type ManagedCloneProviderSource =
  | "hermes-inference"
  | "hermes-tool-gateway"
  | "messaging"
  | "web-search";

const HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";

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
  /** Destination identity whose host broker state must be rebound after provider creation. */
  readonly brokerSandboxName?: string;
  /**
   * Only a force-replaced destination authorizes replacement of an existing
   * destination-named provider. Provisioning must still prove that no other
   * sandbox is attached before it deletes and recreates the provider.
   */
  readonly replaceExistingCredential: boolean;
}

export interface StagedHermesCloneBinding {
  readonly activationToken: string;
  readonly brokerToken: string;
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
  if (inspection.status !== 0) {
    const output =
      `${commandStreamText(inspection.stdout)}\n${commandStreamText(inspection.stderr)}`.trim();
    if (
      inspection.status === 1 &&
      reportsExactProviderNotFound(output, provider.providerName, 64 * 1024)
    ) {
      return { kind: "missing" };
    }
    throw new Error(
      `could not prove whether managed clone provider '${provider.providerName}' exists; ` +
        "refusing destination mutation",
    );
  }

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

function addHermesToolGatewayProvider(
  providers: Map<string, Omit<PreparedManagedCloneProvider, "replaceExistingCredential">>,
  profile: ManagedStartupProfile,
  destinationSandboxName: string,
  broker: HermesToolGatewayCloneBroker,
): void {
  if (profile.agent !== "hermes" || profile.tools.enabledGateways.length === 0) return;
  const providerEnvKey = broker.HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV;
  if (providerEnvKey !== HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV) {
    throw new Error("Hermes managed-tool gateway credential contract changed");
  }
  broker.preflightHermesToolGatewayCloneBinding(destinationSandboxName);
  addProvider(providers, {
    providerName: broker.getHermesInferenceProviderName(destinationSandboxName),
    providerType: "openai",
    providerEnvKey: HERMES_INFERENCE_CREDENTIAL_ENV,
    source: "hermes-inference",
  });
  addProvider(providers, {
    providerName: broker.getHermesToolGatewayProviderName(destinationSandboxName),
    providerType: "generic",
    providerEnvKey,
    source: "hermes-tool-gateway",
    brokerSandboxName: destinationSandboxName,
  });
}

export async function resolveManagedCloneCredentialEnvironment(input: {
  readonly profile: ManagedStartupProfile;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nonInteractive?: boolean;
  readonly runDeviceCodeFlow?: () => Promise<{ readonly refresh_token: string }>;
}): Promise<NodeJS.ProcessEnv> {
  if (input.profile.agent !== "hermes" || input.profile.tools.enabledGateways.length === 0) {
    return {};
  }
  const environment = input.environment ?? process.env;
  const explicit = environment[HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]
    ?.replace(/\r/gu, "")
    .trim();
  const inferencePlaceholder = `nc_clone_${randomBytes(32).toString("base64url")}`;
  if (explicit) {
    return {
      [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: explicit,
      [HERMES_INFERENCE_CREDENTIAL_ENV]: inferencePlaceholder,
    };
  }
  if (input.nonInteractive ?? environment.NEMOCLAW_NON_INTERACTIVE === "1") {
    throw new Error(
      "managed Hermes tool-gateway clone requires a fresh Nous OAuth refresh credential; " +
        `export ${HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV} before retrying`,
    );
  }
  const runDeviceCodeFlow =
    input.runDeviceCodeFlow ??
    (async () => {
      const oauth = await import("../../../oauth-device-code");
      return oauth.runDeviceCodeFlow();
    });
  const tokens = await runDeviceCodeFlow();
  const refreshToken = tokens.refresh_token?.replace(/\r/gu, "").trim();
  if (!refreshToken) {
    throw new Error("Nous OAuth returned no refresh credential for the snapshot destination");
  }
  return {
    [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: refreshToken,
    [HERMES_INFERENCE_CREDENTIAL_ENV]: inferencePlaceholder,
  };
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
  readonly hermesToolGatewayBroker?: HermesToolGatewayCloneBroker;
}): readonly PreparedManagedCloneProvider[] {
  const pending = new Map<
    string,
    Omit<PreparedManagedCloneProvider, "replaceExistingCredential">
  >();
  addMessagingProviders(pending, input.messagingPlan);
  addWebSearchProvider(pending, input.profile, input.destinationSandboxName);
  addHermesToolGatewayProvider(
    pending,
    input.profile,
    input.destinationSandboxName,
    input.hermesToolGatewayBroker ?? getHermesToolGatewayCloneBroker(),
  );
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
  hermesToolGatewayBroker: HermesToolGatewayCloneBroker = getHermesToolGatewayCloneBroker(),
): void {
  const hermesProviderSuffixes = ["-hermes-inference", "-hermes-tool-gateway"] as const;
  const hermesBrokerSandboxes = new Set<string>();
  const hermesCleanupFailures = new Set<string>();
  for (const providerName of [...providerNames].reverse()) {
    const hermesSuffix = hermesProviderSuffixes.find((suffix) => providerName.endsWith(suffix));
    const hermesSandboxName = hermesSuffix
      ? providerName.slice(0, -hermesSuffix.length)
      : undefined;
    if (hermesSandboxName) hermesBrokerSandboxes.add(hermesSandboxName);
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
      if (hermesSandboxName) hermesCleanupFailures.add(hermesSandboxName);
      continue;
    }
  }
  for (const sandboxName of hermesBrokerSandboxes) {
    if (hermesCleanupFailures.has(sandboxName)) {
      console.warn(
        `  Warning: preserving Hermes tool-gateway broker state for '${sandboxName}' after provider cleanup failure.`,
      );
      continue;
    }
    if (!hermesToolGatewayBroker.removeHermesToolGatewayProviderState(sandboxName)) {
      console.warn(
        `  Warning: could not clean up Hermes tool-gateway broker state for '${sandboxName}'.`,
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
    readonly hermesToolGatewayBroker?: HermesToolGatewayCloneBroker;
    readonly stagedHermesBinding?: StagedHermesCloneBinding;
  },
): string[] {
  const environment = input.environment ?? process.env;
  const broker = input.hermesToolGatewayBroker ?? getHermesToolGatewayCloneBroker();
  // A force-replaced destination authorizes deletion and recreation, never a
  // gateway-wide credential update. The bounded delete helper proves that no
  // unrelated sandbox is attached before the new credential is introduced.
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
      if (current.kind === "exact") {
        const authorizedSandboxName = input.rollbackSandboxName;
        if (!authorizedSandboxName) {
          throw new Error(
            `managed clone provider '${provider.providerName}' cannot be replaced without ` +
              "an exact destination sandbox",
          );
        }
        const replacementDelete = deleteProviderWithRecovery(provider.providerName, {
          runOpenshell: input.runOpenshell,
          allowedSandboxes: [authorizedSandboxName],
        });
        if (!replacementDelete.ok) {
          throw new Error(
            `managed clone provider '${provider.providerName}' is still attached outside ` +
              `destination '${authorizedSandboxName}'`,
          );
        }
      }

      const credential = environment[provider.providerEnvKey]?.replace(/\r/gu, "").trim();
      if (!credential) {
        throw new Error(
          `managed clone credential ${provider.providerEnvKey} disappeared before provider creation`,
        );
      }
      const providerCredential =
        provider.source === "hermes-tool-gateway"
          ? input.stagedHermesBinding?.brokerToken
          : credential;
      if (!providerCredential) {
        throw new Error(
          `managed clone provider '${provider.providerName}' has no staged broker credential`,
        );
      }
      const result = input.runOpenshell(
        [
          "provider",
          "create",
          "--name",
          provider.providerName,
          "--type",
          provider.providerType,
          "--credential",
          provider.providerEnvKey,
        ],
        {
          ignoreError: true,
          env: { [provider.providerEnvKey]: providerCredential },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0) {
        throw new Error(`failed to create managed clone provider '${provider.providerName}'`);
      }
      mutated.push(provider.providerName);
      if (inspectProvider(provider, input.runOpenshell).kind !== "exact") {
        throw new Error(
          `managed clone provider '${provider.providerName}' did not retain its exact binding`,
        );
      }
      if (provider.source === "hermes-tool-gateway") {
        if (provider.brokerSandboxName === undefined) {
          throw new Error(
            `managed clone provider '${provider.providerName}' has no destination broker identity`,
          );
        }
        if (!input.stagedHermesBinding) {
          throw new Error(
            `managed clone provider '${provider.providerName}' has no staged destination binding`,
          );
        }
        broker.activateHermesToolGatewayCloneBinding(
          provider.brokerSandboxName,
          credential,
          input.stagedHermesBinding,
        );
      }
    }
    return mutated;
  } catch (error) {
    const stagedSandbox = prepared.find(
      (provider) => provider.source === "hermes-tool-gateway",
    )?.brokerSandboxName;
    if (stagedSandbox && input.stagedHermesBinding) {
      broker.discardHermesToolGatewayCloneBinding(stagedSandbox, input.stagedHermesBinding);
    }
    cleanupCreatedProviders(mutated, input.runOpenshell, input.rollbackSandboxName, broker);
    throw error;
  }
}

export function cleanupManagedCloneProviders(
  providerNames: readonly string[],
  runOpenshell: ManagedCloneProviderRunner,
  authorizedSandboxName?: string,
  hermesToolGatewayBroker: HermesToolGatewayCloneBroker = getHermesToolGatewayCloneBroker(),
): void {
  cleanupCreatedProviders(
    providerNames,
    runOpenshell,
    authorizedSandboxName,
    hermesToolGatewayBroker,
  );
}
