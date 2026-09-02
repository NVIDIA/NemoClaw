// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry";
import { matchesGatewayCredentialFamilyProviderBinding } from "../gateway-provider-metadata";
import { resolveRegisteredRuntimeProvider } from "../runtime-provider/selection";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";

type ProviderPreparationInput = {
  readonly openshellDriver: SandboxEntry["openshellDriver"];
  readonly inferenceProvider: string | null;
  readonly messagingProviders: readonly string[];
  readonly messagingProviderRequests: SandboxCreateIntent["messagingProviderRequests"];
  readonly extraProviders: readonly string[];
  readonly gatewayName: string;
};

type ProviderPreparationDeps = Pick<SandboxCreateOrchestrationRuntime, "runOpenshell"> & {
  readonly cleanupCreateSources: () => void;
  readonly providerAdapter?: OpenShellProviderAdapter;
};

type DeferredProviderAttachmentInput = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly providerNames: readonly string[];
};

function expectedMessagingBindings(input: ProviderPreparationInput) {
  return new Map(
    input.messagingProviderRequests
      .filter(({ providerType }) => providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE)
      .map(({ envKey, name }) => [
        name,
        {
          name,
          type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          credentialKey: envKey,
        },
      ]),
  );
}

function providerAdapter(deps: ProviderPreparationDeps): OpenShellProviderAdapter {
  return (
    deps.providerAdapter ??
    createCliOpenShellProviderAdapter({
      run: (args, options) => deps.runOpenshell(args, options),
    })
  );
}

async function inspectExpectedMessagingBinding(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
  providerName: string,
  expectedBindings: ReturnType<typeof expectedMessagingBindings>,
): Promise<boolean> {
  const expected = expectedBindings.get(providerName);
  if (!expected) return true;
  const result = await providerAdapter(deps).getProvider({
    target: namedOpenShellGateway(input.gatewayName),
    providerName,
  });
  return result.ok && matchesGatewayCredentialFamilyProviderBinding(result.value, expected);
}

export async function validateAttachedMessagingProvidersBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<void> {
  const expectedBindings = expectedMessagingBindings(input);
  const attachedMessagingProviders = [
    ...new Set(
      [input.inferenceProvider, ...input.messagingProviders, ...input.extraProviders].filter(
        (provider): provider is string => Boolean(provider),
      ),
    ),
  ].filter((name) => expectedBindings.has(name));
  if (attachedMessagingProviders.length === 0) return;

  try {
    ensureMessagingCredentialProviderProfile({
      root: REPOSITORY_ROOT,
      runOpenshell: (args, options) =>
        deps.runOpenshell(
          [...args.slice(0, 2), "-g", input.gatewayName, ...args.slice(2)],
          options,
        ),
    });
  } catch (error) {
    deps.cleanupCreateSources();
    throw error;
  }

  for (const providerName of attachedMessagingProviders) {
    if (await inspectExpectedMessagingBinding(input, deps, providerName, expectedBindings))
      continue;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );
  }
}

export async function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<void> {
  const runtimeProvider = resolveRegisteredRuntimeProvider(input.openshellDriver);
  if (
    !runtimeProvider ||
    runtimeProvider.gateway.launcher !== "nemoclaw" ||
    runtimeProvider.bootstrap.supported !== true
  )
    return;

  const expectedBindings = expectedMessagingBindings(input);
  const providersRequiringExistenceProbe = new Set(
    [
      input.inferenceProvider,
      ...input.messagingProviders.filter((name) => !expectedBindings.has(name)),
    ].filter((provider): provider is string => Boolean(provider)),
  );
  const attachedProviders = new Set([
    ...providersRequiringExistenceProbe,
    ...input.messagingProviders,
    ...input.extraProviders,
  ]);
  const adapter = providerAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  for (const attachedProvider of attachedProviders) {
    if (providersRequiringExistenceProbe.has(attachedProvider)) {
      const observed = await adapter.getProvider({ target, providerName: attachedProvider });
      // Preserve the existing pre-create behavior: this publication refresh is
      // optional when the provider cannot be confirmed. The later create owns
      // the authoritative attachment result.
      if (!observed.ok) continue;
    }
    const refreshed = await adapter.updateProvider({
      target,
      providerName: attachedProvider,
      credentials: [],
      config: [],
    });
    if (!refreshed.ok) {
      deps.cleanupCreateSources();
      throw new Error(
        `OpenShell did not publish attached provider '${attachedProvider}' before managed sandbox creation.`,
      );
    }
    if (await inspectExpectedMessagingBinding(input, deps, attachedProvider, expectedBindings)) {
      continue;
    }
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${attachedProvider}' after publication.`,
    );
  }
}

/** Attach the planned providers only after the created sandbox passed its exact identity gate. */
export function attachProvidersAfterSandboxCreation(input: DeferredProviderAttachmentInput): void {
  if (input.providerNames.length === 0) return;
  throw new Error(
    `OpenShell cannot attach providers to the immutable identity of sandbox '${input.sandboxName}'. ` +
      `The sandbox remains incomplete on gateway '${input.gatewayName}'; preserve its verified create checkpoint for administrator recovery.`,
  );
}
