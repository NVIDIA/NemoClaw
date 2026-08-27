// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { SandboxMessagingPlan } from "../messaging";
import type { CheckpointProviderBinding } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import * as braveProviderProfile from "./brave-provider-profile";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import * as messagingBridgeProvider from "./messaging-bridge-provider";
import type { MessagingTokenDef } from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";
import { convergeManagedMessagingCredentials as convergeManagedMessagingCredentialsAtFinalPolicy } from "./machine/messaging-credential-convergence";

const providers = require("./providers");

export interface StageSandboxCredentialProvidersInput<Agent> {
  sandboxName: string;
  enabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  requiredBindings: readonly CheckpointProviderBinding[];
  revalidatePolicyRequirements?(operation: string): void;
}

export interface MessagingProviderRegistrationOptions {
  replaceExisting?: boolean;
  allowedSandboxes?: readonly string[];
  revalidatePolicyRequirements?(operation: string): void;
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
  revalidatePolicyRequirements?: (operation: string) => void,
): void {
  const registeredProviders = new Set(registeredProviderNames);
  const migrations: Array<{ envKey: string; migrated: boolean }> = [];
  for (const def of tokenDefs) {
    if (!registeredProviders.has(def.name) || !def.token || !def.envKey) continue;
    const stagedValue = deps.stagedLegacyValues.get(def.envKey);
    if (stagedValue === undefined) continue;
    migrations.push({ envKey: def.envKey, migrated: def.token === stagedValue });
  }
  if (migrations.length === 0) return;
  revalidatePolicyRequirements?.("record migrated messaging provider credentials");
  for (const migration of migrations) {
    if (migration.migrated) deps.migratedLegacyKeys.add(migration.envKey);
    else deps.migratedLegacyKeys.delete(migration.envKey);
  }
  deps.persistMigratedLegacyKeys();
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
  const messagingProviderIds = new Map<string, string>();
  const messagingProviderIdKey = (gatewayName: string, providerName: string) =>
    `${gatewayName}\0${providerName}`;
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
    options: MessagingProviderRegistrationOptions = {},
  ) {
    const result = providers.upsertProvider(
      name,
      type,
      credentialEnv,
      baseUrl,
      env,
      gatewayRunner(gatewayName),
      options,
    );
    if (result.ok && credentialEnv) {
      const stagedValue = deps.stagedLegacyValues.get(credentialEnv);
      if (stagedValue !== undefined) {
        options.revalidatePolicyRequirements?.(
          `record migrated credential for provider ${JSON.stringify(name)}`,
        );
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
    options: MessagingProviderRegistrationOptions = {},
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ): string[] {
    if (options.replaceExisting) {
      for (const tokenDef of tokenDefs) {
        messagingProviderIds.delete(messagingProviderIdKey(deps.getGatewayName(), tokenDef.name));
      }
    }
    const runWebSearchOpenshell = providers.policyAuthorityCheckedRunner(
      runOpenshell,
      options.revalidatePolicyRequirements,
      "import a web-search provider profile",
    );
    ensureWebSearchProviderProfiles(tokenDefs, runWebSearchOpenshell);
    const upserted = providers.upsertMessagingProviders(
      tokenDefs,
      runOpenshell,
      options,
    ) as string[];
    for (const tokenDef of tokenDefs) {
      if (!upserted.includes(tokenDef.name)) continue;
      captureMessagingProviderId(
        {
          name: tokenDef.name,
          type: tokenDef.providerType || "generic",
          credentialEnv: tokenDef.envKey,
        },
        runOpenshell,
      );
    }
    recordMigratedLegacyMessagingCredentials(
      tokenDefs,
      upserted,
      deps,
      options.revalidatePolicyRequirements,
    );
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
    const matches = gatewayProviderMetadata.matchesGatewayCredentialOnlyProviderBinding(
      providers.readGatewayProviderMetadata(binding.name, runOpenshell, deps.getGatewayName()),
      {
        name: binding.name,
        type: binding.type,
        credentialKey: binding.credentialEnv,
      },
    );
    if (matches) captureMessagingProviderId(binding, runOpenshell);
    return matches;
  }

  function captureMessagingProviderId(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): void {
    const inspection = gatewayProviderMetadata.inspectGatewayCredentialOnlyProviderAuthority(
      {
        name: binding.name,
        type: binding.type,
        credentialKey: binding.credentialEnv,
      },
      runOpenshell,
    );
    if (inspection.kind !== "exact") return;
    const key = messagingProviderIdKey(deps.getGatewayName(), binding.name);
    const current = messagingProviderIds.get(key);
    if (current && current !== inspection.id) {
      throw new Error(`Messaging provider '${binding.name}' changed immutable ownership.`);
    }
    messagingProviderIds.set(key, inspection.id);
  }

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): boolean {
    return credentialBindingMatchesGateway({ name, type, credentialEnv }, gatewayRunner());
  }

  async function convergeManagedMessagingCredentials(
    sandboxName: string,
    openshellDriver: string | null | undefined,
    gatewayName: string,
    plan: SandboxMessagingPlan,
    restartManagedGateway: (sandboxName: string) => {
      readonly ok: boolean;
      readonly detail?: string;
    },
  ) {
    if (!openshellDriver) {
      throw new Error(
        `Cannot converge messaging credentials for unregistered sandbox '${sandboxName}'.`,
      );
    }
    return await convergeManagedMessagingCredentialsAtFinalPolicy(
      {
        sandboxName,
        gatewayName,
        openshellDriver,
        plan,
        expectedProviderIds: new Map(
          plan.credentialBindings.flatMap((binding) => {
            const id = messagingProviderIds.get(
              messagingProviderIdKey(gatewayName, binding.providerName),
            );
            return id ? [[binding.providerName, id]] : [];
          }),
        ),
      },
      {
        runOpenshell: deps.runOpenshell,
        restartManagedGateway,
      },
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
    input.revalidatePolicyRequirements?.("stage sandbox credential providers after planning");
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
    input.revalidatePolicyRequirements?.("clear staged credential provider receipts");
    setStagedCredentialProviderReceipts(
      tokenDefs.map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    const registered = upsertMessagingProviders(
      tokenDefs,
      { revalidatePolicyRequirements: input.revalidatePolicyRequirements },
      runOpenshell,
    );
    input.revalidatePolicyRequirements?.("record staged credential provider receipts");
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered.map((name) => {
      const binding = plannedBindings.get(name);
      if (!binding) throw new Error(BINDING_PLAN_ERROR);
      return binding;
    });
  }

  return {
    convergeManagedMessagingCredentials,
    providerMatchesGatewayCredential,
    stageSandboxCredentialProviders,
    upsertProvider,
    upsertMessagingProviders,
  };
}
