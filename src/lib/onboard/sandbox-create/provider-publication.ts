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

type DeferredProviderAttachmentInput = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly providerNames: readonly string[];
};

type DeferredProviderAttachmentDeps = Pick<SandboxCreateOrchestrationRuntime, "runOpenshell"> & {
  readonly revalidateSandboxIdentity: (operation: string) => void;
  readonly waitForSandboxReady: (
    sandboxName: string,
    attempts?: number,
    delaySeconds?: number,
  ) => boolean;
};

const PROVIDER_REFRESH_READY_ATTEMPTS = 30;
const PROVIDER_REFRESH_READY_DELAY_SECONDS = 2;

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
  const inspection = inspectGatewayCredentialOnlyProviderBinding(expected, (args, options) =>
    deps.runOpenshell([...args.slice(0, 2), "-g", input.gatewayName, ...args.slice(2)], options),
  );
  return inspection.kind === "exact";
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
  if (attachedMessagingProviders.length === 0) return;

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

/**
 * Attach the planned providers only after the created sandbox passed its exact policy gate.
 *
 * OpenShell resolves attached provider revisions when the sandbox starts. A provider attached to
 * an already-running sandbox is visible in control-plane metadata, but its credential placeholders
 * are not available to the running supervisor or a fresh exec until the sandbox starts again.
 */
export function attachProvidersAfterSandboxCreation(
  input: DeferredProviderAttachmentInput,
  deps: DeferredProviderAttachmentDeps,
): void {
  if (input.providerNames.length === 0) return;

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

  deps.revalidateSandboxIdentity(
    `refreshing attached providers on sandbox '${input.sandboxName}'`,
  );
  const stopped = deps.runOpenshell(
    ["sandbox", "stop", "-g", input.gatewayName, input.sandboxName],
    { ignoreError: true, suppressOutput: true },
  );
  if (stopped.status !== 0) {
    throw new Error(
      `OpenShell did not stop sandbox '${input.sandboxName}' to refresh its attached providers.`,
    );
  }

  const started = deps.runOpenshell(
    ["sandbox", "start", "-g", input.gatewayName, input.sandboxName],
    { ignoreError: true, suppressOutput: true },
  );
  if (started.status !== 0) {
    throw new Error(
      `OpenShell did not restart sandbox '${input.sandboxName}' after refreshing its attached providers.`,
    );
  }
  if (
    !deps.waitForSandboxReady(
      input.sandboxName,
      PROVIDER_REFRESH_READY_ATTEMPTS,
      PROVIDER_REFRESH_READY_DELAY_SECONDS,
    )
  ) {
    throw new Error(
      `OpenShell did not report sandbox '${input.sandboxName}' ready after refreshing its attached providers.`,
    );
  }
  deps.revalidateSandboxIdentity(
    `confirming refreshed providers on sandbox '${input.sandboxName}'`,
  );
}
