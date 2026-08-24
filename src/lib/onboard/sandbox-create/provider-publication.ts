// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry";
import { inspectGatewayCredentialOnlyProviderBinding } from "../gateway-provider-metadata";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";

type ProviderPreparationInput = {
  readonly openshellDriver: SandboxEntry["openshellDriver"];
  readonly inferenceProvider: string | null;
  readonly messagingProviders: readonly string[];
  readonly messagingProviderRequests: SandboxCreateIntent["messagingProviderRequests"];
  readonly extraProviders: readonly string[];
  readonly gatewayName: string;
};

type ProviderPreparationDeps = Pick<
  SandboxCreateOrchestrationRuntime,
  "providerExistsInGateway" | "runOpenshell"
> & {
  readonly cleanupCreateSources: () => void;
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

function inspectExpectedMessagingBinding(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
  providerName: string,
  expectedBindings: ReturnType<typeof expectedMessagingBindings>,
): boolean {
  const expected = expectedBindings.get(providerName);
  if (!expected) return true;
  const inspection = inspectGatewayCredentialOnlyProviderBinding(expected, (args, options) =>
    deps.runOpenshell([...args.slice(0, 2), "-g", input.gatewayName, ...args.slice(2)], options),
  );
  return inspection.kind === "exact";
}

export function validateAttachedMessagingProvidersBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): void {
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
    if (inspectExpectedMessagingBinding(input, deps, providerName, expectedBindings)) continue;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );
  }
}

export function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): void {
  if (input.openshellDriver !== "docker") return;

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
  for (const attachedProvider of attachedProviders) {
    if (
      providersRequiringExistenceProbe.has(attachedProvider) &&
      !deps.providerExistsInGateway(attachedProvider)
    )
      continue;
    const refreshed = deps.runOpenshell(
      ["provider", "update", "-g", input.gatewayName, attachedProvider],
      {
        ignoreError: true,
        suppressOutput: true,
      },
    );
    if (refreshed.status !== 0) {
      deps.cleanupCreateSources();
      throw new Error(
        `OpenShell did not publish attached provider '${attachedProvider}' before Docker sandbox creation.`,
      );
    }
    if (inspectExpectedMessagingBinding(input, deps, attachedProvider, expectedBindings)) continue;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${attachedProvider}' after publication.`,
    );
  }
}
