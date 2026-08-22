// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { CheckpointProviderBinding } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import * as braveProviderProfile from "./brave-provider-profile";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import * as messagingBridgeProvider from "./messaging-bridge-provider";
import type { MessagingTokenDef } from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";

const providers = require("./providers");

export interface StageSandboxCredentialProvidersInput<Agent> {
  sandboxName: string;
  enabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  requiredBindings: readonly CheckpointProviderBinding[];
}

type PreparedCredentialProviders = {
  messagingTokenDefs: MessagingTokenDef[];
};

type PrepareCredentialProviders<Agent> = (
  input: StageSandboxCredentialProvidersInput<Agent>,
) => Promise<PreparedCredentialProviders>;

export interface CredentialProviderRegistrationDeps {
  root: string;
  runOpenshell: OpenshellCliHelpers["runOpenshell"];
  redact(input: string): string;
  getGatewayName(): string;
  getCredential(name: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  updateSession(mutator: (session: Session) => Session | void): Session;
  stagedLegacyValues: ReadonlyMap<string, string>;
  migratedLegacyKeys: Set<string>;
  persistMigratedLegacyKeys(): void;
}

function recordMigratedLegacyMessagingCredentials(
  tokenDefs: readonly MessagingTokenDef[],
  registeredProviderNames: readonly string[],
  deps: CredentialProviderRegistrationDeps,
): void {
  const registeredProviders = new Set(registeredProviderNames);
  let mutated = false;
  for (const def of tokenDefs) {
    if (!registeredProviders.has(def.name) || !def.token || !def.envKey) continue;
    const stagedValue = deps.stagedLegacyValues.get(def.envKey);
    if (stagedValue === undefined) continue;
    if (def.token === stagedValue) {
      deps.migratedLegacyKeys.add(def.envKey);
    } else {
      deps.migratedLegacyKeys.delete(def.envKey);
    }
    mutated = true;
  }
  if (mutated) deps.persistMigratedLegacyKeys();
}

function setStagedCredentialProviderReceipts(
  names: readonly string[],
  staged: boolean,
  deps: CredentialProviderRegistrationDeps,
): void {
  if (names.length === 0) return;
  deps.updateSession((current) => {
    const providerNames = new Set(current.stagedCredentialProviders);
    for (const name of names) {
      if (staged) providerNames.add(name);
      else providerNames.delete(name);
    }
    current.stagedCredentialProviders = [...providerNames];
    return current;
  });
}

const BINDING_PLAN_ERROR = "Credential provider plan does not match the required bindings.";
const EXISTING_BINDING_ERROR =
  "An existing credential provider does not match the required binding.";
const MISSING_BINDING_ERROR =
  "A required credential provider is missing and no credential is available to recreate it.";

function isCanonicalBinding(binding: CheckpointProviderBinding): boolean {
  return [binding.name, binding.type, binding.credentialEnv].every(
    (field) => typeof field === "string" && field.length > 0 && field.trim() === field,
  );
}

function validatePlannedCredentialProviderBindings(
  tokenDefs: readonly MessagingTokenDef[],
  requiredBindings: readonly CheckpointProviderBinding[],
  hasPreparedCredential: (tokenDef: MessagingTokenDef) => boolean,
): ReadonlyMap<string, CheckpointProviderBinding> {
  const requiredByName = new Map<string, CheckpointProviderBinding>();
  for (const binding of requiredBindings) {
    if (!isCanonicalBinding(binding) || requiredByName.has(binding.name)) {
      throw new Error(BINDING_PLAN_ERROR);
    }
    requiredByName.set(binding.name, binding);
  }

  const plannedByName = new Map<string, CheckpointProviderBinding>();
  for (const tokenDef of tokenDefs) {
    const binding = {
      name: tokenDef.name,
      type: tokenDef.providerType || "generic",
      credentialEnv: tokenDef.envKey,
    };
    const required = requiredByName.get(binding.name);
    if (!required && !hasPreparedCredential(tokenDef)) continue;
    if (
      !isCanonicalBinding(binding) ||
      plannedByName.has(binding.name) ||
      !required ||
      binding.type !== required.type ||
      binding.credentialEnv !== required.credentialEnv
    ) {
      throw new Error(BINDING_PLAN_ERROR);
    }
    plannedByName.set(binding.name, binding);
  }
  return plannedByName;
}

export function createCredentialProviderRegistration(deps: CredentialProviderRegistrationDeps) {
  const gatewayRunner = (gatewayName = deps.getGatewayName()) =>
    createGatewayScopedOpenshellRunner(deps.runOpenshell, gatewayName);
  const ensureWebSearchProviderProfiles = (
    tokenDefs: readonly MessagingTokenDef[],
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ) =>
    braveProviderProfile.ensureWebSearchProviderProfiles(tokenDefs, {
      root: deps.root,
      runOpenshell,
      redact: deps.redact,
    });

  function upsertProvider(
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv = {},
    gatewayName = deps.getGatewayName(),
  ) {
    const result = providers.upsertProvider(
      name,
      type,
      credentialEnv,
      baseUrl,
      env,
      gatewayRunner(gatewayName),
    );
    if (result.ok && credentialEnv) {
      const stagedValue = deps.stagedLegacyValues.get(credentialEnv);
      if (stagedValue !== undefined) {
        const upsertedValue = env[credentialEnv] ?? deps.getCredential(credentialEnv);
        if (upsertedValue === stagedValue) {
          deps.migratedLegacyKeys.add(credentialEnv);
        } else {
          deps.migratedLegacyKeys.delete(credentialEnv);
        }
        deps.persistMigratedLegacyKeys();
      }
    }
    return result;
  }

  function upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: { replaceExisting?: boolean; allowedSandboxes?: readonly string[] } = {},
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ): string[] {
    ensureWebSearchProviderProfiles(tokenDefs, runOpenshell);
    const upserted = providers.upsertMessagingProviders(
      tokenDefs,
      runOpenshell,
      options,
    ) as string[];
    recordMigratedLegacyMessagingCredentials(tokenDefs, upserted, deps);
    return upserted;
  }

  function credentialBindingMatchesGateway(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): boolean {
    const staticProfileMatches = messagingBridgeProvider.matchesRegisteredStaticMessagingProfile(
      binding.type,
      { root: deps.root, runOpenshell },
    );
    if (staticProfileMatches === false) return false;
    return gatewayProviderMetadata.matchesGatewayCredentialOnlyProviderBinding(
      providers.readGatewayProviderMetadata(binding.name, runOpenshell, deps.getGatewayName()),
      {
        name: binding.name,
        type: binding.type,
        credentialKey: binding.credentialEnv,
      },
    );
  }

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): boolean {
    return credentialBindingMatchesGateway(
      { name, type, credentialEnv },
      gatewayRunner(),
    );
  }

  function preflightRequiredCredentialProviderBindings(
    requiredBindings: readonly CheckpointProviderBinding[],
    plannedTokenDefs: ReadonlyMap<string, MessagingTokenDef>,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): void {
    for (const binding of requiredBindings) {
      if (!providers.providerExistsInGateway(binding.name, runOpenshell)) {
        const tokenDef = plannedTokenDefs.get(binding.name);
        if (!tokenDef || !deps.normalizeCredentialValue(tokenDef.token)) {
          throw new Error(MISSING_BINDING_ERROR);
        }
        continue;
      }
      const matches = credentialBindingMatchesGateway(binding, runOpenshell);
      if (!matches) throw new Error(EXISTING_BINDING_ERROR);
    }
  }

  async function stageSandboxCredentialProviders<Agent>(
    input: StageSandboxCredentialProvidersInput<Agent>,
    prepareCredentialProviders: PrepareCredentialProviders<Agent>,
  ): Promise<readonly CheckpointProviderBinding[]> {
    const messaging = await prepareCredentialProviders(input);
    const plannedBindings = validatePlannedCredentialProviderBindings(
      messaging.messagingTokenDefs,
      input.requiredBindings,
      (tokenDef) => Boolean(deps.normalizeCredentialValue(tokenDef.token)),
    );
    const plannedTokenDefs = new Map(
      messaging.messagingTokenDefs.map((tokenDef) => [tokenDef.name, tokenDef]),
    );
    const tokenDefs = messaging.messagingTokenDefs.filter((tokenDef) =>
      deps.normalizeCredentialValue(tokenDef.token),
    );
    const runOpenshell = gatewayRunner();
    preflightRequiredCredentialProviderBindings(
      input.requiredBindings,
      plannedTokenDefs,
      runOpenshell,
    );
    setStagedCredentialProviderReceipts(
      tokenDefs.map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    const registered = upsertMessagingProviders(tokenDefs, {}, runOpenshell);
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered.map((name) => {
      const binding = plannedBindings.get(name);
      if (!binding) throw new Error(BINDING_PLAN_ERROR);
      return binding;
    });
  }

  return {
    providerMatchesGatewayCredential,
    stageSandboxCredentialProviders,
    upsertProvider,
    upsertMessagingProviders,
  };
}
