// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry";
import {
  matchesGatewayCredentialFamilyProviderBinding,
  readGatewayProviderMetadata,
} from "../gateway-provider-metadata";
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

type DeferredProviderAttachmentInput = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly providerNames: readonly string[];
};

type DeferredProviderAttachmentDeps = Pick<SandboxCreateOrchestrationRuntime, "runOpenshell"> & {
  readonly revalidateSandboxIdentity: (operation: string) => void;
};

export class DeferredProviderRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferredProviderRefreshError";
  }
}

export function isDeferredProviderRefreshError(
  error: unknown,
): error is DeferredProviderRefreshError {
  return error instanceof DeferredProviderRefreshError;
}

/** Preserve the identity-bound recovery action for any deferred provider failure. */
export function asDeferredProviderRefreshError(
  sandboxName: string,
  error: unknown,
): DeferredProviderRefreshError {
  if (isDeferredProviderRefreshError(error)) return error;
  const detail = error instanceof Error ? error.message : "Messaging provider refresh failed.";
  return new DeferredProviderRefreshError(
    `${detail} NemoClaw preserved the verified create checkpoint. To recover, run 'nemoclaw ${sandboxName} destroy --force'. This suppresses confirmation, attempts to wipe manifest-defined agent state, destroys the exact checkpointed sandbox, and removes its registry entry before onboarding can be retried.`,
  );
}

function expectedCredentialBindings(input: ProviderPreparationInput) {
  return new Map(
    input.messagingProviderRequests
      .filter((request): request is typeof request & { readonly providerType: string } =>
        Boolean(request.providerType),
      )
      .map(({ envKey, name, providerType }) => [
        name,
        {
          name,
          type: providerType,
          credentialKey: envKey,
        },
      ]),
  );
}

function inspectExpectedMessagingBinding(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
  providerName: string,
  expectedBindings: ReturnType<typeof expectedCredentialBindings>,
): boolean {
  const expected = expectedBindings.get(providerName);
  if (!expected) return true;
  const metadata = readGatewayProviderMetadata(providerName, (args, options) =>
    deps.runOpenshell([...args.slice(0, 2), "-g", input.gatewayName, ...args.slice(2)], options),
  );
  return matchesGatewayCredentialFamilyProviderBinding(metadata, {
    ...expected,
    allowExtendedCredentialKeys: true,
  });
}

export function validateAttachedMessagingProvidersBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): void {
  const expectedBindings = expectedCredentialBindings(input);
  const attachedMessagingProviders = [
    ...new Set(
      [input.inferenceProvider, ...input.messagingProviders, ...input.extraProviders].filter(
        (provider): provider is string => Boolean(provider),
      ),
    ),
  ].filter((name) => expectedBindings.has(name));

  if (
    attachedMessagingProviders.some(
      (providerName) =>
        expectedBindings.get(providerName)?.type === MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    )
  ) {
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
  }

  for (const providerName of attachedMessagingProviders) {
    if (inspectExpectedMessagingBinding(input, deps, providerName, expectedBindings)) continue;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );
  }

  for (const providerName of input.extraProviders) {
    if (expectedBindings.has(providerName) || deps.providerExistsInGateway(providerName)) continue;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm attached provider '${providerName}' before sandbox creation.`,
    );
  }
}

export function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): void {
  if (input.openshellDriver !== "docker") return;

  const expectedBindings = expectedCredentialBindings(input);
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

/** Attach the planned providers only after the created sandbox passed its exact policy gate. */
export function attachProvidersAfterSandboxCreation(
  input: DeferredProviderAttachmentInput,
  deps: DeferredProviderAttachmentDeps,
): void {
  for (const providerName of input.providerNames) {
    deps.revalidateSandboxIdentity(
      `attaching provider '${providerName}' to sandbox '${input.sandboxName}'`,
    );
    const attached = deps.runOpenshell(
      ["sandbox", "provider", "attach", "-g", input.gatewayName, input.sandboxName, providerName],
      { ignoreError: true, suppressOutput: true },
    );
    if (attached.status !== 0) {
      throw new Error(
        `OpenShell did not attach provider '${providerName}' to the verified sandbox.`,
      );
    }
    deps.revalidateSandboxIdentity(
      `confirming provider '${providerName}' on sandbox '${input.sandboxName}'`,
    );
  }
}
