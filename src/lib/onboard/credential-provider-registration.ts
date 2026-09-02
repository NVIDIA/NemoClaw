// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import {
  createCliOpenShellProviderAdapter,
  createCliOpenShellProviderInspectionAdapter,
} from "../adapters/openshell/provider-adapter-cli";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import {
  buildMessagingProviderApplication,
  resolveCheckedInMessagingProviderProfile,
} from "../messaging/applier/provider-application";
import { MessagingSetupApplier } from "../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { CheckpointProviderBinding } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import { hasConfiguredMessagingCredential, type MessagingTokenDef } from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";

const providers = require("./providers");

type CredentialProviderRegistrationUpsert = (
  tokenDefs: MessagingTokenDef[],
  runOpenshell: OpenshellCliHelpers["runOpenshell"],
  options: MessagingProviderRegistrationOptions,
) => string[];

type LiveE2eCredentialProviderOverride = {
  readonly expectedName: string;
  readonly expectedType: string;
  readonly upsert: CredentialProviderRegistrationUpsert;
};

const LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY =
  "__nemoclawLiveE2eCredentialProviderRegistrationOverride" as const;

function liveE2eCredentialProviderOverride(): LiveE2eCredentialProviderOverride | null {
  const state = globalThis as typeof globalThis & {
    [LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY]?: LiveE2eCredentialProviderOverride;
  };
  return state[LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY] ?? null;
}

/** Install the exact Google Chat fake-mint boundary used by the destructive live E2E. */
export function installLiveE2eCredentialProviderRegistrationOverride(input: {
  readonly expectedName: string;
  readonly expectedType: "google-chat-bridge" | "google-chat-hermes-bridge";
  readonly upsert: CredentialProviderRegistrationUpsert;
}): () => void {
  if (
    process.env.NEMOCLAW_RUN_LIVE_E2E !== "1" ||
    !/^e2e-(?:oc|hm)-ch-[a-z0-9-]+-googlechat-bridge$/u.test(input.expectedName)
  ) {
    throw new Error("Google Chat provider override is restricted to its destructive live E2E.");
  }
  const state = globalThis as typeof globalThis & {
    [LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY]?: LiveE2eCredentialProviderOverride;
  };
  if (state[LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY]) {
    throw new Error("A live E2E credential provider override is already installed.");
  }
  const installed = { ...input };
  state[LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY] = installed;
  let restored = false;
  return () => {
    if (restored) return;
    if (state[LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY] !== installed) {
      throw new Error("The live E2E credential provider override changed before cleanup.");
    }
    delete state[LIVE_E2E_CREDENTIAL_PROVIDER_OVERRIDE_KEY];
    restored = true;
  };
}

/** Late-bound provider upsert seam used by live credential fixtures. */
export const credentialProviderRegistrationDependencies = {
  upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    options: MessagingProviderRegistrationOptions,
  ): string[] {
    const override = liveE2eCredentialProviderOverride();
    if (override) {
      const expected = tokenDefs.filter(
        ({ envKey, name, providerType }) =>
          envKey === "GOOGLE_CHAT_ACCESS_TOKEN" &&
          name === override.expectedName &&
          providerType === override.expectedType,
      );
      if (expected.length !== 1) {
        throw new Error("Google Chat live E2E provider override received an unexpected plan.");
      }
      return override.upsert(tokenDefs, runOpenshell, options);
    }
    return providers.upsertMessagingProviders(tokenDefs, runOpenshell, options) as string[];
  },
};

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

  function upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: MessagingProviderRegistrationOptions = {},
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ): string[] {
    const override = liveE2eCredentialProviderOverride();
    let upserted: string[];
    if (override) {
      upserted = credentialProviderRegistrationDependencies.upsertMessagingProviders(
        tokenDefs,
        runOpenshell,
        options,
      );
    } else {
      const plan = MessagingSetupApplier.readPlanFromEnv() ?? emptyMessagingPlan();
      const application = buildMessagingProviderApplication({
        tokenDefs,
        root: deps.root,
        agent: plan.agent,
        getCredential: deps.getCredential,
        env: process.env,
        channelIdForCredential: (envKey, providerName) =>
          channelIdForProvider(plan, envKey, providerName),
      });
      const otherProviderNames =
        application.otherTokenDefs.length > 0
          ? credentialProviderRegistrationDependencies.upsertMessagingProviders(
              [...application.otherTokenDefs],
              runOpenshell,
              options,
            )
          : [];
      for (const definition of application.definitions) {
        if (
          !credentialBindingMatchesGateway(
            {
              name: definition.providerName,
              type: definition.providerType,
              credentialEnv: definition.credentials[0]?.name ?? "",
            },
            runOpenshell,
          )
        ) {
          throw new Error(
            `Messaging provider '${definition.providerName}' was not staged through the typed provider applier.`,
          );
        }
      }
      upserted = [
        ...otherProviderNames,
        ...application.definitions.map(({ providerName }) => providerName),
      ];
    }
    recordMigratedLegacyMessagingCredentials(
      tokenDefs,
      upserted,
      deps,
      options.revalidateSandboxIdentity,
    );
    return upserted;
  }

  async function applyMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: MessagingProviderRegistrationOptions = {},
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ): Promise<string[]> {
    const override = liveE2eCredentialProviderOverride();
    const applied = override
      ? credentialProviderRegistrationDependencies.upsertMessagingProviders(
          tokenDefs,
          runOpenshell,
          options,
        )
      : await applyProviderDefinitions(tokenDefs, runOpenshell, options);
    recordMigratedLegacyMessagingCredentials(
      tokenDefs,
      applied,
      deps,
      options.revalidateSandboxIdentity,
    );
    return applied;
  }

  async function applyProviderDefinitions(
    tokenDefs: MessagingTokenDef[],
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    options: MessagingProviderRegistrationOptions,
  ): Promise<string[]> {
    const plan = MessagingSetupApplier.readPlanFromEnv() ?? emptyMessagingPlan();
    const application = buildMessagingProviderApplication({
      tokenDefs,
      root: deps.root,
      agent: plan.agent,
      getCredential: deps.getCredential,
      env: process.env,
      channelIdForCredential: (envKey, providerName) =>
        channelIdForProvider(plan, envKey, providerName),
    });
    const otherProviderNames =
      application.otherTokenDefs.length > 0
        ? providers.upsertMessagingProviders(
            application.otherTokenDefs,
            runOpenshell,
            options,
          )
        : [];
    if (application.definitions.length === 0) return otherProviderNames;
    const providerAdapter = createCliOpenShellProviderAdapter({ run: runOpenshell });
    const result = await MessagingSetupApplier.applyCredentialsAtOpenShell(plan, {
      providerAdapter,
      target: namedOpenShellGateway(deps.getGatewayName()),
      definitions: application.definitions,
      refreshes: application.refreshes,
      replaceExisting: options.replaceExisting,
      bestEffort: options.bestEffort,
      allowedSandboxes: options.allowedSandboxes,
      revalidateSandboxIdentity: options.revalidateSandboxIdentity,
      log: (message) => console.error(`  ${message}`),
    });
    return [...otherProviderNames, ...result.providerNames];
  }

  type CredentialBindingInspection = "collision" | "exact" | "indeterminate" | "missing";

  function inspectCredentialBinding(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): CredentialBindingInspection {
    const inspector = createCliOpenShellProviderInspectionAdapter({ run: runOpenshell });
    const target = namedOpenShellGateway(deps.getGatewayName());
    const provider = inspector.getProvider({ target, providerName: binding.name });
    if (!provider.ok) {
      return provider.error.kind === "command" && provider.error.reason === "not_found"
        ? "missing"
        : "indeterminate";
    }
    if (
      !gatewayProviderMetadata.matchesGatewayCredentialFamilyProviderBinding(provider.value, {
        name: binding.name,
        type: binding.type,
        credentialKey: binding.credentialEnv,
      })
    ) {
      return "collision";
    }
    const expectedProfile = resolveCheckedInMessagingProviderProfile({
      root: deps.root,
      profileType: binding.type,
    });
    if (!expectedProfile) return "exact";
    const profile = inspector.inspectProviderProfile({
      target,
      profileType: binding.type,
    });
    if (!profile.ok) {
      return profile.error.kind === "command" && profile.error.reason === "not_found"
        ? "collision"
        : "indeterminate";
    }
    return profile.value.contractDigest === expectedProfile.contractDigest
      ? "exact"
      : "collision";
  }

  function credentialBindingMatchesGateway(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): boolean {
    return inspectCredentialBinding(binding, runOpenshell) === "exact";
  }

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): boolean {
    return credentialBindingMatchesGateway(
      {
        name,
        type,
        credentialEnv,
      },
      gatewayRunner(),
    );
  }

  function preflightRequiredCredentialProviderBindings(
    requiredBindings: readonly CheckpointProviderBinding[],
    plannedTokenDefs: ReadonlyMap<string, MessagingTokenDef>,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    replaceExisting: boolean,
  ): void {
    for (const binding of requiredBindings) {
      const inspection = inspectCredentialBinding(binding, runOpenshell);
      if (inspection === "indeterminate") throw new Error(BINDING_INSPECTION_ERROR);
      if (inspection === "missing") {
        const tokenDef = plannedTokenDefs.get(binding.name);
        if (!tokenDef || !hasConfiguredMessagingCredential(tokenDef)) {
          throw new Error(MISSING_BINDING_ERROR);
        }
        continue;
      }
      if (inspection === "exact") continue;
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
    const tokenDefs = messaging.messagingTokenDefs.filter(hasConfiguredMessagingCredential);
    const runOpenshell = gatewayRunner();
    preflightRequiredCredentialProviderBindings(
      input.requiredBindings,
      plannedTokenDefs,
      runOpenshell,
      input.replaceExisting === true,
    );
    input.revalidateSandboxIdentity?.("clear staged credential provider receipts");
    setStagedCredentialProviderReceipts(
      tokenDefs.map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    const registered = await applyMessagingProviders(
      tokenDefs,
      {
        replaceExisting: input.replaceExisting === true,
        allowedSandboxes: input.replaceExisting === true ? [input.sandboxName] : undefined,
        revalidateSandboxIdentity: input.revalidateSandboxIdentity,
      },
      runOpenshell,
    );
    input.revalidateSandboxIdentity?.("record staged credential provider receipts");
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered.map((name) => {
      const binding = plannedBindings.get(name);
      if (!binding) throw new Error(BINDING_PLAN_ERROR);
      return binding;
    });
  }

  return {
    providerMatchesGatewayCredential,
    applyMessagingProviders,
    stageSandboxCredentialProviders,
    upsertProvider,
    upsertMessagingProviders,
  };
}

function emptyMessagingPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "provider-application",
    agent: "openclaw",
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

function channelIdForProvider(
  plan: SandboxMessagingPlan,
  envKey: string,
  providerName: string,
): string | null {
  return (
    plan.credentialBindings.find(
      (binding) =>
        binding.providerName === providerName || binding.providerEnvKey === envKey,
    )?.channelId ?? null
  );
}
