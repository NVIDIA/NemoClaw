// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { Session } from "../state/onboard-session";
import * as braveProviderProfile from "./brave-provider-profile";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import type { MessagingTokenDef } from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";

const providers = require("./providers");

export interface StageSandboxCredentialProvidersInput<Agent> {
  sandboxName: string;
  enabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
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

export function createCredentialProviderRegistration(deps: CredentialProviderRegistrationDeps) {
  const gatewayRunner = () =>
    createGatewayScopedOpenshellRunner(deps.runOpenshell, deps.getGatewayName());
  const ensureWebSearchProviderProfiles = (
    tokenDefs: readonly MessagingTokenDef[],
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = deps.runOpenshell,
  ) =>
    braveProviderProfile.ensureWebSearchProviderProfiles(tokenDefs, {
      root: deps.root,
      runOpenshell,
      redact: deps.redact,
    });

  function upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: { replaceExisting?: boolean } = {},
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

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
  ): boolean {
    const runOpenshell = gatewayRunner();
    return gatewayProviderMetadata.matchesGatewayCredentialOnlyProviderBinding(
      providers.readGatewayProviderMetadata(name, runOpenshell, deps.getGatewayName()),
      { name, type, credentialKey: credentialEnv },
    );
  }

  function canRegisterCredential(
    tokenDef: MessagingTokenDef,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
  ): boolean {
    if (!providers.providerExistsInGateway(tokenDef.name, runOpenshell)) return true;
    return gatewayProviderMetadata.matchesGatewayCredentialOnlyProviderBinding(
      providers.readGatewayProviderMetadata(tokenDef.name, runOpenshell, deps.getGatewayName()),
      {
        name: tokenDef.name,
        type: tokenDef.providerType || "generic",
        credentialKey: tokenDef.envKey,
      },
    );
  }

  async function stageSandboxCredentialProviders<Agent>(
    input: StageSandboxCredentialProvidersInput<Agent>,
    prepareCredentialProviders: PrepareCredentialProviders<Agent>,
  ): Promise<readonly string[]> {
    const messaging = await prepareCredentialProviders(input);
    const tokenDefs = messaging.messagingTokenDefs.filter((tokenDef) =>
      deps.normalizeCredentialValue(tokenDef.token),
    );
    setStagedCredentialProviderReceipts(
      tokenDefs.map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    const runOpenshell = gatewayRunner();
    const registered = upsertMessagingProviders(
      tokenDefs.filter((tokenDef) => canRegisterCredential(tokenDef, runOpenshell)),
      {},
      runOpenshell,
    );
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered;
  }

  return {
    providerMatchesGatewayCredential,
    stageSandboxCredentialProviders,
    upsertMessagingProviders,
  };
}
