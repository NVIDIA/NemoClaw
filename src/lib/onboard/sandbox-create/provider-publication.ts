// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import type { SandboxEntry } from "../../state/registry";
import type { PendingSandboxProviderRefreshPhase } from "../../state/registry/types";
import { cliName } from "../branding";
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
  readonly inspectSandbox: () => {
    readonly state: "missing" | "not_ready" | "ready";
    readonly liveIdentityFingerprint: string | null;
  };
  readonly recordProviderRefresh: (
    phase: PendingSandboxProviderRefreshPhase,
    attachedProviders: readonly string[],
  ) => void;
  readonly waitForSandboxReady: (
    sandboxName: string,
    attempts?: number,
    delaySeconds?: number,
  ) => boolean;
};

const PROVIDER_REFRESH_READY_ATTEMPTS = 30;
const PROVIDER_REFRESH_READY_DELAY_SECONDS = 2;

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

function providerRefreshFailure(
  input: DeferredProviderAttachmentInput,
  deps: DeferredProviderAttachmentDeps,
  phase: PendingSandboxProviderRefreshPhase,
  detail: string,
): never {
  let identity = "could not be revalidated";
  try {
    deps.revalidateSandboxIdentity(
      `classifying deferred provider refresh failure for sandbox '${input.sandboxName}'`,
    );
    identity = "still matches the checkpointed exact identity";
  } catch {
    // The recovery command below reads the same durable checkpoint and refuses
    // a same-name replacement. Do not replace the original failure with the
    // identity error or expose command output.
  }
  let observedState = "unknown";
  try {
    observedState = deps.inspectSandbox().state;
  } catch {
    // Keep the recovery classification fail closed when status is unavailable.
  }
  throw new DeferredProviderRefreshError(
    `Deferred provider refresh for sandbox '${input.sandboxName}' failed during phase '${phase}': ${detail}. ` +
      `The live sandbox state is '${observedState}' and its identity ${identity}. ` +
      `NemoClaw preserved the secret-free provider-refresh checkpoint and did not publish the completed registry entry. ` +
      `Recovery attempts to wipe manifest-defined agent state, destroys the exact checkpointed sandbox, and removes its registry entry. ` +
      `Run \`${cliName()} ${input.sandboxName} destroy --force\` before retrying onboarding; --force suppresses confirmation, and the command refuses to destroy a same-name replacement.`,
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

  const attachedProviders: string[] = [];
  deps.recordProviderRefresh("attaching", attachedProviders);
  for (const providerName of input.providerNames) {
    deps.revalidateSandboxIdentity(
      `attaching provider '${providerName}' to sandbox '${input.sandboxName}'`,
    );
    const attached = deps.runOpenshell(
      ["sandbox", "provider", "attach", "-g", input.gatewayName, input.sandboxName, providerName],
      { ignoreError: true, suppressOutput: true },
    );
    if (attached.status !== 0) {
      providerRefreshFailure(
        input,
        deps,
        "attaching",
        `OpenShell did not attach provider '${providerName}' to the verified sandbox`,
      );
    }
    deps.revalidateSandboxIdentity(
      `confirming provider '${providerName}' on sandbox '${input.sandboxName}'`,
    );
    attachedProviders.push(providerName);
    deps.recordProviderRefresh("attaching", attachedProviders);
  }

  deps.revalidateSandboxIdentity(`refreshing attached providers on sandbox '${input.sandboxName}'`);
  deps.recordProviderRefresh("stopping", attachedProviders);
  const stopped = deps.runOpenshell(
    ["sandbox", "stop", "-g", input.gatewayName, input.sandboxName],
    { ignoreError: true, suppressOutput: true },
  );
  if (stopped.status !== 0) {
    providerRefreshFailure(
      input,
      deps,
      "stopping",
      `OpenShell did not stop the sandbox to refresh its attached providers`,
    );
  }
  try {
    deps.revalidateSandboxIdentity(
      `starting the exact stopped sandbox '${input.sandboxName}' after provider refresh`,
    );
  } catch {
    providerRefreshFailure(
      input,
      deps,
      "stopping",
      "the stopped sandbox identity changed before restart",
    );
  }
  deps.recordProviderRefresh("stopped", attachedProviders);

  const started = deps.runOpenshell(
    ["sandbox", "start", "-g", input.gatewayName, input.sandboxName],
    { ignoreError: true, suppressOutput: true },
  );
  if (started.status !== 0) {
    providerRefreshFailure(
      input,
      deps,
      "stopped",
      `OpenShell did not restart the sandbox after refreshing its attached providers`,
    );
  }
  try {
    deps.revalidateSandboxIdentity(
      `waiting for the exact restarted sandbox '${input.sandboxName}' after provider refresh`,
    );
  } catch {
    providerRefreshFailure(
      input,
      deps,
      "stopped",
      "the restarted sandbox identity changed before readiness verification",
    );
  }
  deps.recordProviderRefresh("started", attachedProviders);
  if (
    !deps.waitForSandboxReady(
      input.sandboxName,
      PROVIDER_REFRESH_READY_ATTEMPTS,
      PROVIDER_REFRESH_READY_DELAY_SECONDS,
    )
  ) {
    providerRefreshFailure(
      input,
      deps,
      "started",
      `OpenShell did not report the sandbox ready after refreshing its attached providers`,
    );
  }
  deps.revalidateSandboxIdentity(
    `confirming refreshed providers on sandbox '${input.sandboxName}'`,
  );
  deps.recordProviderRefresh("ready", attachedProviders);
}
