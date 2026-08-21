// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry";
import { inspectGatewayCredentialOnlyProviderBinding } from "../gateway-provider-metadata";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";

export function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: {
    readonly openshellDriver: SandboxEntry["openshellDriver"];
    readonly inferenceProvider: string | null;
    readonly messagingProviders: readonly string[];
    readonly messagingProviderRequests: SandboxCreateIntent["messagingProviderRequests"];
    readonly extraProviders: readonly string[];
    readonly gatewayName: string;
  },
  deps: Pick<SandboxCreateOrchestrationRuntime, "providerExistsInGateway" | "runOpenshell"> & {
    readonly cleanupCreateSources: () => void;
  },
): void {
  if (input.openshellDriver !== "docker") return;

  const expectedMessagingBindings = new Map(
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
  const providersRequiringExistenceProbe = new Set(
    [
      input.inferenceProvider,
      ...input.messagingProviders.filter((name) => !expectedMessagingBindings.has(name)),
    ].filter((provider): provider is string => Boolean(provider)),
  );
  const attachedProviders = new Set([
    ...providersRequiringExistenceProbe,
    ...input.messagingProviders,
    ...input.extraProviders,
  ]);
  const requireExactMessagingBinding = (providerName: string): void => {
    const expected = expectedMessagingBindings.get(providerName);
    if (!expected) return;
    const inspection = inspectGatewayCredentialOnlyProviderBinding(expected, (args, options) =>
      deps.runOpenshell([...args.slice(0, 2), "-g", input.gatewayName, ...args.slice(2)], options),
    );
    if (inspection.kind === "exact") return;
    deps.cleanupCreateSources();
    throw new Error(
      `OpenShell did not confirm messaging provider '${providerName}' before Docker sandbox creation.`,
    );
  };

  for (const attachedProvider of attachedProviders) {
    requireExactMessagingBinding(attachedProvider);
  }
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
    requireExactMessagingBinding(attachedProvider);
  }
}
