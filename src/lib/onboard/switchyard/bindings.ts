// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/provider-adapter";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import {
  type HermesSwitchyardProvider,
  type HermesSwitchyardRoutingIntent,
  validateHermesSwitchyardRoutingIntent,
  switchyardClientProfile,
  switchyardJudgeSelection,
  switchyardPhysicalProviders,
} from "../../hermes-switchyard-routing";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { fixedNativeProvider } from "../../inference/native-provider/fixed";
import {
  type SwitchyardPhysicalProviderBinding,
  type SwitchyardProviderBindings,
  SwitchyardProviderBindingError,
  isSwitchyardProviderIdentity,
  validateSwitchyardProviderBindings,
  validateSwitchyardBindingState,
} from "../../hermes-switchyard-routing";

function fail(message: string): never {
  throw new SwitchyardProviderBindingError(message);
}

/** Use the existing fixed profiles; Switchyard does not own another provider catalog. */
export function switchyardProviderDefinition(provider: HermesSwitchyardProvider) {
  const definition = fixedNativeProvider(provider);
  const endpoint = switchyardClientProfile(provider).baseUrl;
  if (!definition || !endpoint) return fail("the selected provider has no fixed profile.");
  return { ...definition, endpoint };
}

type ObserveBindingsInput = {
  readonly routing: HermesSwitchyardRoutingIntent;
  readonly providerNames: Readonly<Partial<Record<HermesSwitchyardProvider, string>>>;
  readonly adapter: OpenShellProviderAdapter;
  readonly target: OpenShellGatewayTarget;
};

function requireRevision(metadata: OpenShellProviderMetadata) {
  const revision = metadata.revision;
  if (
    !revision ||
    !isSwitchyardProviderIdentity(revision.id) ||
    !Number.isSafeInteger(revision.resourceVersion) ||
    revision.resourceVersion < 1
  )
    return fail("the provider has no attestable identity and resource version.");
  return revision;
}

async function observeProvider(
  input: ObserveBindingsInput,
  logicalProvider: HermesSwitchyardProvider,
  providerName: string,
): Promise<SwitchyardPhysicalProviderBinding> {
  const definition = { ...switchyardProviderDefinition(logicalProvider), providerName };
  const lifecycle = nativeProviderLifecycle(definition);
  let profile;
  try {
    profile = parseCheckedInProviderProfileContract(
      readFileSync(lifecycle.nativeProviderProfilePath(), "utf8"),
    );
  } catch {
    return fail("the checked-in provider profile cannot be read.");
  }
  if (!profile || profile.profileId !== definition.profileId)
    return fail("the checked-in provider profile cannot be verified.");
  const before = await input.adapter.getProvider({ target: input.target, providerName });
  if (!before.ok) return fail("a required provider is missing or cannot be inspected.");
  if (!lifecycle.exactNativeProvider(before.value))
    return fail("a provider does not match its selected profile and credential key.");
  const revision = requireRevision(before.value);
  const verified = await input.adapter.inspectProviderProfile({
    target: input.target,
    profileType: definition.profileId,
    expectedProfile: profile,
  });
  if (!verified.ok || !isDeepStrictEqual(verified.value.credentialKeys, [definition.credentialEnv]))
    return fail("the provider endpoint and credential profile cannot be attested.");
  const after = await input.adapter.getProvider({ target: input.target, providerName });
  if (
    !after.ok ||
    !lifecycle.exactNativeProvider(after.value) ||
    !isDeepStrictEqual(requireRevision(after.value), revision)
  )
    return fail("a provider changed while its profile was being verified.");
  return {
    logicalProvider,
    providerName,
    providerId: revision.id,
    resourceVersion: revision.resourceVersion,
    profileId: definition.profileId,
    profileSha256: createHash("sha256").update(JSON.stringify(profile.boundary)).digest("hex"),
    endpointUrl: definition.endpoint,
    credentialEnv: definition.credentialEnv,
  };
}

/** Capture both target roles and the explicit judge from observed OpenShell state. */
export async function observeSwitchyardProviderBindings(
  input: ObserveBindingsInput,
): Promise<SwitchyardProviderBindings> {
  const routing = validateHermesSwitchyardRoutingIntent(input.routing);
  const logicalProviders = switchyardPhysicalProviders(routing);
  const names = logicalProviders.map((provider) => input.providerNames[provider]);
  if (
    Object.keys(input.providerNames).length !== logicalProviders.length ||
    names.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) ||
    new Set(names).size !== names.length
  )
    return fail("the physical provider names are missing, duplicate, or ambiguous.");
  const providers: SwitchyardPhysicalProviderBinding[] = [];
  for (const logicalProvider of logicalProviders) {
    providers.push(
      await observeProvider(input, logicalProvider, input.providerNames[logicalProvider]!),
    );
  }
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length)
    return fail("different physical providers returned the same identity.");
  const role = (selection: HermesSwitchyardRoutingIntent["efficient"]) => ({
    providerId: providers.find((provider) => provider.logicalProvider === selection.provider)!
      .providerId,
    model: selection.model,
  });
  const capable = role(routing.capable);
  return validateSwitchyardProviderBindings(
    {
      schemaVersion: 1,
      providers,
      efficient: role(routing.efficient),
      capable,
      judge: {
        ...role(switchyardJudgeSelection(routing)),
        mode: routing.judge.mode,
        target: routing.judge.target,
      },
    },
    routing,
  );
}

/** Removal or revision drift invalidates the recorded route; never adopt a replacement. */
export async function verifySwitchyardProviderBindings(
  input: ObserveBindingsInput & {
    readonly expected: SwitchyardProviderBindings;
    readonly sandboxName: string;
  },
): Promise<SwitchyardProviderBindings> {
  const observed = await observeSwitchyardProviderBindings(input);
  if (
    !isDeepStrictEqual(observed, validateSwitchyardProviderBindings(input.expected, input.routing))
  )
    return fail("the recorded provider or role state is stale; recreate the sandbox.");
  const attached = await input.adapter.listProviderAttachments({
    target: input.target,
    sandboxName: input.sandboxName,
  });
  if (
    !attached.ok ||
    new Set(attached.value.names).size !== attached.value.names.length ||
    observed.providers.some((provider) => !attached.value.names.includes(provider.providerName))
  )
    return fail("a required provider is no longer attached to the sandbox.");
  const requiredNames = new Set(observed.providers.map((p) => p.providerName));
  const credentialKeys = new Set(observed.providers.map((p) => p.credentialEnv));
  for (const providerName of attached.value.names) {
    if (requiredNames.has(providerName)) continue;
    const extra = await input.adapter.getProvider({ target: input.target, providerName });
    if (!extra.ok || extra.value.credentialKeys.some((key) => credentialKeys.has(key)))
      return fail("an attached provider has an ambiguous credential binding.");
  }
  return observed;
}

/** Remove owned revisions after sandbox deletion or a confirmed failed fresh reservation. */
export async function removeSwitchyardProviders(input: {
  state: import("../../hermes-switchyard-routing").SwitchyardBindingState;
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
}): Promise<void> {
  const state = validateSwitchyardBindingState(input.state);
  for (const provider of state.bindings.providers) {
    const lifecycle = nativeProviderLifecycle({
      ...switchyardProviderDefinition(provider.logicalProvider),
      providerName: provider.providerName,
    });
    const current = await lifecycle.inspectNativeProvider(input.adapter, input.target);
    if (!current) continue;
    if (
      !lifecycle.exactNativeProvider(current) ||
      current.revision?.id !== provider.providerId ||
      current.revision.resourceVersion !== provider.resourceVersion
    )
      return fail("refusing to remove a provider whose recorded identity or revision changed.");
    await lifecycle.removeNewNativeProvider({
      adapter: input.adapter,
      target: input.target,
      expected: {
        schemaVersion: 1,
        providerName: provider.providerName,
        profileId: provider.profileId,
        providerId: provider.providerId,
      },
    });
  }
}
