// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import {
  isMessagingProviderMutationFailure,
  MessagingProviderApplyError,
} from "../messaging/applier/openshell-provider";
import { buildMessagingProviderApplication } from "../messaging/applier/provider-application";
import { MessagingSetupApplier } from "../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { CheckpointProviderBinding } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import * as messagingBridgeProvider from "./messaging-bridge-provider";
import { hasConfiguredMessagingCredential, type MessagingTokenDef } from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";

const providers = require("./providers");

export interface StageSandboxCredentialProvidersInput<Agent> {
  sandboxName: string;
  enabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  requiredBindings: readonly CheckpointProviderBinding[];
  replaceExisting?: boolean;
  revalidateSandboxIdentity?(operation: string): void;
}

export interface MessagingProviderRegistrationOptions {
  replaceExisting?: boolean;
  bestEffort?: boolean;
  allowedSandboxes?: readonly string[];
  revalidateSandboxIdentity?(operation: string): void;
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
  getGatewayName(): string;
  getCredential(name: string): string | null;
  updateSession(mutator: (session: Session) => Session | void): Session;
  stagedLegacyValues: ReadonlyMap<string, string>;
  migratedLegacyKeys: Set<string>;
  persistMigratedLegacyKeys(): void;
}

function recordMigratedLegacyMessagingCredentials(
  tokenDefs: readonly MessagingTokenDef[],
  registeredProviderNames: readonly string[],
  deps: CredentialProviderRegistrationDeps,
  revalidateSandboxIdentity?: (operation: string) => void,
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
  revalidateSandboxIdentity?.("record migrated messaging provider credentials");
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
const BINDING_INSPECTION_ERROR =
  "The required credential provider could not be inspected through the selected gateway.";

async function rethrowAfterCreatedProviderCleanup(
  error: unknown,
  input: {
    readonly providerAdapter: ReturnType<typeof createCliOpenShellProviderAdapter>;
    readonly gatewayName: string;
    readonly allowedSandboxes?: readonly string[];
    readonly revalidateSandboxIdentity?: (operation: string) => void;
    readonly createdProviderNames?: readonly string[];
    readonly replacedProviderNames?: readonly string[];
  },
): Promise<never> {
  const existingCreatedProviderNames = providerMutationNames(error, "createdProviderNames");
  const existingMutatedProviderNames = providerMutationNames(error, "mutatedProviderNames");
  const existingReplacedProviderNames = providerMutationNames(error, "replacedProviderNames");
  const cleanupAttemptedProviderNames = new Set(
    providerMutationNames(error, "cleanupAttemptedProviderNames"),
  );
  const createdProviderNames = uniqueProviderNames([
    ...existingCreatedProviderNames,
    ...(input.createdProviderNames ?? []),
  ]);
  if (createdProviderNames.length === 0) throw error;
  const replacedProviderNames = uniqueProviderNames([
    ...existingReplacedProviderNames,
    ...(input.replacedProviderNames ?? []),
  ]);
  const mutationError = new MessagingProviderApplyError({
    message: error instanceof Error ? error.message : "Provider registration failed.",
    mutatedProviderNames: uniqueProviderNames([
      ...existingMutatedProviderNames,
      ...createdProviderNames,
    ]),
    createdProviderNames,
    replacedProviderNames,
    cause: error,
  });
  const cleanupCandidates = createdProviderNames.filter(
    (providerName) => !cleanupAttemptedProviderNames.has(providerName),
  );
  const cleanup =
    cleanupCandidates.length > 0
      ? await MessagingSetupApplier.cleanupProvidersAtOpenShell(cleanupCandidates, {
          providerAdapter: input.providerAdapter,
          target: namedOpenShellGateway(input.gatewayName),
          allowedSandboxes: input.allowedSandboxes,
          revalidateSandboxIdentity: input.revalidateSandboxIdentity,
        })
      : {
          removedProviderNames: [],
          absentProviderNames: [],
          detachedAttachments: [],
          residualProviders: [],
        };
  const createdProviders = new Set(createdProviderNames);
  const replacedProviders = new Set(replacedProviderNames);
  const residualProviderNames = uniqueProviderNames([
    ...existingCreatedProviderNames.filter((providerName) =>
      cleanupAttemptedProviderNames.has(providerName),
    ),
    ...cleanup.residualProviders.map(({ providerName }) => providerName),
  ]);
  const residualMessage = cleanup.residualProviders
    .map(
      ({ providerName, error: cleanupError }) =>
        `Automatic cleanup could not remove ${JSON.stringify(providerName)}: ${cleanupError.message}. ` +
        `Run \`openshell provider delete -g ${JSON.stringify(input.gatewayName)} ${JSON.stringify(providerName)}\`, then retry onboarding.`,
    )
    .join(" ");
  throw new MessagingProviderApplyError({
    message: [mutationError.message, residualMessage].filter(Boolean).join(" "),
    mutatedProviderNames: [
      ...mutationError.mutatedProviderNames.filter(
        (providerName) =>
          !createdProviders.has(providerName) || replacedProviders.has(providerName),
      ),
      ...residualProviderNames,
    ],
    createdProviderNames: residualProviderNames,
    replacedProviderNames,
    cause: error,
  });
}

function providerMutationNames(
  error: unknown,
  field:
    | "cleanupAttemptedProviderNames"
    | "createdProviderNames"
    | "mutatedProviderNames"
    | "replacedProviderNames",
): string[] {
  if (
    !(error instanceof Error) ||
    (field !== "cleanupAttemptedProviderNames" && !isMessagingProviderMutationFailure(error))
  ) {
    return [];
  }
  const value = Reflect.get(error, field);
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
}

function uniqueProviderNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

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
        options.revalidateSandboxIdentity?.(
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

  async function applyMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: MessagingProviderRegistrationOptions = {},
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
    applicationPlan: SandboxMessagingPlan = MessagingSetupApplier.readPlanFromEnv() ??
      emptyMessagingPlan(),
  ): Promise<string[]> {
    const application = buildMessagingProviderApplication({
      tokenDefs,
      root: deps.root,
      agent: applicationPlan.agent,
      getCredential: deps.getCredential,
      env: process.env,
      channelIdForCredential: (envKey, providerName) =>
        channelIdForProvider(applicationPlan, envKey, providerName),
    });
    const gatewayName = deps.getGatewayName();
    const providerAdapter = createCliOpenShellProviderAdapter({ run: runOpenshell });
    const typedResult = await MessagingSetupApplier.applyCredentialsAtOpenShell(applicationPlan, {
      providerAdapter,
      target: namedOpenShellGateway(gatewayName),
      definitions: application.definitions,
      refreshes: application.refreshes,
      requireCompleteBindings: true,
      replaceExisting: options.replaceExisting,
      allowedSandboxes: options.allowedSandboxes,
      revalidateSandboxIdentity: options.revalidateSandboxIdentity,
      log: (message) => console.error(`  ${message}`),
    }).catch((error: unknown) =>
      rethrowAfterCreatedProviderCleanup(error, {
        providerAdapter,
        gatewayName,
        allowedSandboxes: options.allowedSandboxes,
        revalidateSandboxIdentity: options.revalidateSandboxIdentity,
      }),
    );
    const typedCreatedProviderNames = typedResult.upserted
      .filter(({ action }) => action === "create")
      .map(({ providerName }) => providerName);
    try {
      if (typedResult.missing.length > 0) throw new Error(MISSING_BINDING_ERROR);
      const appliedNames = new Set(typedResult.providerNames);
      const applied = tokenDefs.map(({ name }) => name).filter((name) => appliedNames.has(name));
      recordMigratedLegacyMessagingCredentials(
        tokenDefs,
        applied,
        deps,
        options.revalidateSandboxIdentity,
      );
      return applied;
    } catch (error) {
      return rethrowAfterCreatedProviderCleanup(error, {
        providerAdapter,
        gatewayName,
        allowedSandboxes: options.allowedSandboxes,
        revalidateSandboxIdentity: options.revalidateSandboxIdentity,
        createdProviderNames: typedCreatedProviderNames,
        replacedProviderNames: typedResult.replacedProviderNames,
      });
    }
  }

  function credentialBindingMatchesGateway(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): boolean {
    return inspectGatewayCredentialBinding(binding, runOpenshell).kind === "exact";
  }

  function inspectGatewayCredentialBinding(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): gatewayProviderMetadata.GatewayCredentialOnlyProviderInspection {
    const profileMatches = messagingBridgeProvider.matchesRegisteredMessagingBridgeProfile(
      binding.type,
      { root: deps.root, runOpenshell },
    );
    if (profileMatches === false) return { kind: "indeterminate" };
    return gatewayProviderMetadata.inspectGatewayCredentialFamilyProviderBinding(
      {
        name: binding.name,
        type: binding.type,
        credentialKey: binding.credentialEnv,
      },
      runOpenshell,
    );
  }

  function inspectGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): gatewayProviderMetadata.GatewayCredentialOnlyProviderInspection {
    return inspectGatewayCredentialBinding({ name, type, credentialEnv }, gatewayRunner());
  }

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): boolean {
    return credentialBindingMatchesGateway({ name, type, credentialEnv }, gatewayRunner());
  }

  async function preflightRequiredCredentialProviderBindings(
    requiredBindings: readonly CheckpointProviderBinding[],
    plannedTokenDefs: ReadonlyMap<string, MessagingTokenDef>,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    replaceExisting: boolean,
  ): Promise<void> {
    const adapter = createCliOpenShellProviderAdapter({ run: runOpenshell });
    const target = namedOpenShellGateway(deps.getGatewayName());
    for (const binding of requiredBindings) {
      const observed = await adapter.getProvider({ target, providerName: binding.name });
      if (
        !observed.ok &&
        observed.error.kind === "command" &&
        observed.error.reason === "not_found"
      ) {
        const tokenDef = plannedTokenDefs.get(binding.name);
        if (!tokenDef || !hasConfiguredMessagingCredential(tokenDef)) {
          throw new Error(MISSING_BINDING_ERROR);
        }
        continue;
      }
      if (!observed.ok) throw new Error(BINDING_INSPECTION_ERROR);
      const matches = gatewayProviderMetadata.matchesGatewayCredentialFamilyProviderBinding(
        observed.value,
        {
          name: binding.name,
          type: binding.type,
          credentialKey: binding.credentialEnv,
        },
      );
      if (matches) continue;
      const tokenDef = plannedTokenDefs.get(binding.name);
      if (!replaceExisting || !tokenDef || !hasConfiguredMessagingCredential(tokenDef)) {
        throw new Error(EXISTING_BINDING_ERROR);
      }
    }
  }

  async function stageSandboxCredentialProviders<Agent>(
    input: StageSandboxCredentialProvidersInput<Agent>,
    prepareCredentialProviders: PrepareCredentialProviders<Agent>,
  ): Promise<readonly CheckpointProviderBinding[]> {
    const messaging = await prepareCredentialProviders(input);
    input.revalidateSandboxIdentity?.("stage sandbox credential providers after planning");
    const plannedBindings = validatePlannedCredentialProviderBindings(
      messaging.messagingTokenDefs,
      input.requiredBindings,
      hasConfiguredMessagingCredential,
    );
    const plannedTokenDefs = new Map(
      messaging.messagingTokenDefs.map((tokenDef) => [tokenDef.name, tokenDef]),
    );
    const tokenDefs = messaging.messagingTokenDefs.filter(({ name }) => plannedBindings.has(name));
    const configuredProviderNames = new Set(
      tokenDefs.filter(hasConfiguredMessagingCredential).map((tokenDef) => tokenDef.name),
    );
    const runOpenshell = deps.runOpenshell;
    const applicationPlan =
      MessagingSetupApplier.readPlanFromEnv() ??
      emptyMessagingPlan(input.sandboxName, agentNameForMessagingPlan(input.agent));
    await preflightRequiredCredentialProviderBindings(
      input.requiredBindings,
      plannedTokenDefs,
      runOpenshell,
      input.replaceExisting === true,
    );
    input.revalidateSandboxIdentity?.("clear staged credential provider receipts");
    setStagedCredentialProviderReceipts(
      tokenDefs.filter(hasConfiguredMessagingCredential).map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    const applied = await applyMessagingProviders(
      tokenDefs,
      {
        replaceExisting: input.replaceExisting === true,
        allowedSandboxes: input.replaceExisting === true ? [input.sandboxName] : undefined,
        revalidateSandboxIdentity: input.revalidateSandboxIdentity,
      },
      runOpenshell,
      applicationPlan,
    );
    const registered = applied.filter((name) => configuredProviderNames.has(name));
    input.revalidateSandboxIdentity?.("record staged credential provider receipts");
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered.map((name) => {
      const binding = plannedBindings.get(name);
      if (!binding) throw new Error(BINDING_PLAN_ERROR);
      return binding;
    });
  }

  return {
    inspectGatewayCredential,
    providerMatchesGatewayCredential,
    applyMessagingProviders,
    stageSandboxCredentialProviders,
    upsertProvider,
  };
}

function emptyMessagingPlan(
  sandboxName = "provider-application",
  agent: SandboxMessagingPlan["agent"] = "openclaw",
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function agentNameForMessagingPlan(value: unknown): SandboxMessagingPlan["agent"] {
  if (!value || typeof value !== "object") return "openclaw";
  const name = Reflect.get(value, "name");
  return name === "hermes" ? "hermes" : "openclaw";
}

function channelIdForProvider(
  plan: SandboxMessagingPlan,
  envKey: string,
  providerName: string,
): string | null {
  return (
    plan.credentialBindings.find(
      (binding) => binding.providerName === providerName || binding.providerEnvKey === envKey,
    )?.channelId ?? null
  );
}
