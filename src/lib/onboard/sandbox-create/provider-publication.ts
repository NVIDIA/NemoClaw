// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { ensureNativeLocalProviderAttached } from "../../inference/native-local/profile";
import { isNativeHostedProviderName } from "../../inference/native-provider/hosted-attachment";
import { hostedNativeProviderForAttachment } from "../../inference/native-provider/hosted-attachment";
import { nativeProviderLifecycle } from "../../inference/native-provider";

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../../adapters/openshell/provider-adapter";
import {
  createCliOpenShellProviderAdapter,
  type CliOpenShellProviderAdapter,
} from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellGatewayEndpointEnvironment } from "../../adapters/openshell/gateway-scope";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { messagingProviderProfileForType } from "../../messaging/applier/provider-application";
import {
  ensureNativeNvidiaProviderAttached,
  nativeNvidiaProviderProfilePath,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  requireNativeNvidiaProviderProfileBoundary,
} from "../../inference/native-nvidia";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import { listMessagingBridgeProfiles } from "../messaging-bridge-provider";
import type { SandboxEntry } from "../../state/registry";
import {
  matchesGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
} from "../gateway-provider-metadata";
import { resolveRegisteredRuntimeProvider } from "../runtime-provider/selection";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";

type ProviderPreparationInput = {
  readonly openshellDriver: SandboxEntry["openshellDriver"];
  readonly inferenceProvider: string | null;
  readonly transactionBoundInferenceProvider?: string | null;
  readonly messagingProviders: readonly string[];
  readonly messagingProviderRequests: SandboxCreateIntent["messagingProviderRequests"];
  readonly extraProviders: readonly string[];
  readonly gatewayName: string;
  readonly directCreateProviderNames?: readonly string[];
  readonly hermesToolGateway?: Readonly<{
    providerName: string;
    profileType: string;
    credentialEnv: string;
  }>;
};

type ProviderPreparationDeps = Pick<SandboxCreateOrchestrationRuntime, "runOpenshell"> & {
  readonly cleanupCreateSources: () => void;
  readonly environment?: OpenShellGatewayEndpointEnvironment;
  readonly providerAdapter?: OpenShellProviderAdapter &
    Partial<Pick<CliOpenShellProviderAdapter, "warnIfVerifiedProfilesChangedAfterSandboxCreate">>;
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

/** Recheck known owned profiles before binding previously registered providers. */
export async function validateAttachedOwnedProfilesBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<readonly string[]> {
  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  const expectedMessaging = expectedMessagingBindings(input);
  const candidates = new Set([...input.messagingProviders, ...input.extraProviders]);
  if (input.inferenceProvider && expectedMessaging.has(input.inferenceProvider)) {
    candidates.add(input.inferenceProvider);
  }
  const providerNames = (input.directCreateProviderNames ?? [...candidates]).filter((name) =>
    candidates.has(name),
  );
  if (providerNames.length === 0) return [];
  let bridgeProfiles: Map<string, ReturnType<typeof listMessagingBridgeProfiles>[number]> | null =
    null;
  const profileIds = new Set<string>();
  for (const providerName of new Set(providerNames)) {
    if (expectedMessaging.has(providerName)) {
      profileIds.add(MESSAGING_CREDENTIAL_PROVIDER_TYPE);
      continue;
    }
    const observed = await adapter.getProvider({ target, providerName });
    if (!observed.ok) {
      throwAfterCleanup(
        deps,
        `Could not inspect attached provider '${providerName}' before sandbox creation: ${observed.error.message}`,
      );
    }
    if (observed.value.type === "generic") continue;
    let directProfile = messagingProviderProfileForType(
      REPOSITORY_ROOT,
      observed.value.type,
      undefined,
    );
    if (observed.value.type === "langfuse-hermes-v1") {
      directProfile = {
        profileType: observed.value.type,
        profilePath: path.join(
          REPOSITORY_ROOT,
          "nemoclaw-blueprint",
          "provider-profiles",
          "langfuse-hermes-v1.yaml",
        ),
      };
    }
    if (observed.value.type === NVIDIA_HOSTED_NATIVE_PROFILE_ID) {
      directProfile = {
        profileType: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        profilePath: nativeNvidiaProviderProfilePath(),
      };
    }
    if (!directProfile) {
      bridgeProfiles ??= new Map(
        listMessagingBridgeProfiles({ root: REPOSITORY_ROOT }).map((entry) => [
          entry.profileId,
          entry,
        ]),
      );
    }
    const profile =
      directProfile ??
      messagingProviderProfileForType(
        REPOSITORY_ROOT,
        observed.value.type,
        bridgeProfiles?.get(observed.value.type),
      );
    if (!profile) continue;
    const imported = await adapter.importProviderProfile({
      target,
      profilePath: profile.profilePath,
    });
    if (!imported.ok) {
      throwAfterCleanup(
        deps,
        `Could not verify provider profile '${profile.profileType}' before sandbox creation.`,
      );
    }
    profileIds.add(profile.profileType);
  }
  return [...profileIds];
}

/** Legacy generic bindings remain eligible only for the broker's exact credential contract. */
export async function validateAttachedHermesToolGatewayProfileBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<string | null> {
  const expected = input.hermesToolGateway;
  if (!expected) return null;
  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  const observed = await adapter.getProvider({ target, providerName: expected.providerName });
  if (!observed.ok) {
    throwAfterCleanup(
      deps,
      `Could not inspect Hermes tool gateway provider before sandbox creation.`,
    );
  }
  if (
    ![expected.profileType, "generic"].includes(observed.value.type) ||
    !matchesGatewayCredentialOnlyProviderBinding(observed.value, {
      name: expected.providerName,
      type: observed.value.type,
      credentialKey: expected.credentialEnv,
    })
  ) {
    throwAfterCleanup(
      deps,
      `Hermes tool gateway provider binding changed before sandbox creation.`,
    );
  }
  if (observed.value.type === "generic") return null;
  const profile = await adapter.importProviderProfile({
    target,
    profilePath: path.join(
      REPOSITORY_ROOT,
      "agents",
      "hermes",
      "host",
      `${expected.profileType}.yaml`,
    ),
  });
  if (!profile.ok) {
    throwAfterCleanup(
      deps,
      `Could not verify Hermes tool gateway profile before sandbox creation.`,
    );
  }
  return expected.profileType;
}

export function resolveProviderAdapter(
  deps: ProviderPreparationDeps,
): OpenShellProviderAdapter &
  Partial<Pick<CliOpenShellProviderAdapter, "warnIfVerifiedProfilesChangedAfterSandboxCreate">> {
  return (
    deps.providerAdapter ??
    createCliOpenShellProviderAdapter({
      environment: deps.environment,
      run: (args, options) => deps.runOpenshell(args, options),
    })
  );
}

/** Verify native profiles before direct sandbox create binds their providers. */
export async function validateAttachedNativeProfileBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
  expectedNativeNvidiaProviderAttachment?: SandboxEntry["nativeNvidiaProviderAttachment"],
  expectedNativeHostedProviderAttachment?: SandboxEntry["nativeHostedProviderAttachment"],
): Promise<void> {
  const target = namedOpenShellGateway(input.gatewayName);
  const adapter = resolveProviderAdapter(deps);
  if (usesNativeNvidiaProvider(input.inferenceProvider) && expectedNativeNvidiaProviderAttachment) {
    await requireNativeNvidiaProviderProfileBoundary(adapter, target);
  }
  if (usesNativeHostedProvider(input.inferenceProvider) && expectedNativeHostedProviderAttachment) {
    const definition = hostedNativeProviderForAttachment(expectedNativeHostedProviderAttachment);
    if (definition?.providerName === input.inferenceProvider) {
      await nativeProviderLifecycle<string, string>(
        definition,
      ).requireNativeProviderProfileBoundary(adapter, target);
    }
  }
}

export function usesNativeNvidiaProvider(inferenceProvider: string | null): boolean {
  return inferenceProvider === NVIDIA_HOSTED_NATIVE_PROVIDER;
}

export async function verifyNativeNvidiaAttachmentAfterCreate(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly inferenceProvider: string | null;
  readonly expected: SandboxEntry["nativeNvidiaProviderAttachment"];
  readonly deps: ProviderPreparationDeps;
}): Promise<void> {
  if (!usesNativeNvidiaProvider(input.inferenceProvider)) return;
  if (!input.expected) {
    throw new Error(
      `Sandbox '${input.sandboxName}' is missing its native NVIDIA provider identity receipt.`,
    );
  }
  await ensureNativeNvidiaProviderAttached({
    adapter: resolveProviderAdapter(input.deps),
    target: namedOpenShellGateway(input.gatewayName),
    sandboxName: input.sandboxName,
    expected: input.expected,
  });
}

export async function verifyNativeLocalAttachmentAfterCreate(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly expected: NonNullable<SandboxEntry["nativeLocalProviderAttachment"]>;
  readonly deps: ProviderPreparationDeps;
}): Promise<void> {
  if (input.expected.gatewayName !== input.gatewayName)
    throw new Error("Native local provider gateway authority changed.");
  await ensureNativeLocalProviderAttached({
    adapter: resolveProviderAdapter(input.deps),
    sandboxName: input.sandboxName,
    expected: input.expected,
  });
}

export function usesNativeHostedProvider(inferenceProvider: string | null): boolean {
  return isNativeHostedProviderName(inferenceProvider);
}

export async function verifyNativeHostedAttachmentAfterCreate(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly inferenceProvider: string | null;
  readonly expected: SandboxEntry["nativeHostedProviderAttachment"];
  readonly deps: ProviderPreparationDeps;
}): Promise<void> {
  if (!usesNativeHostedProvider(input.inferenceProvider)) return;
  const definition = hostedNativeProviderForAttachment(input.expected);
  if (!input.expected || !definition || definition.providerName !== input.inferenceProvider)
    throw new Error(
      `Sandbox '${input.sandboxName}' is missing its native hosted provider identity receipt.`,
    );
  await nativeProviderLifecycle<string, string>(definition).ensureNativeProviderAttached({
    adapter: resolveProviderAdapter(input.deps),
    target: namedOpenShellGateway(input.gatewayName),
    sandboxName: input.sandboxName,
    expected: input.expected,
  });
}

type ExpectedMessagingBindingInspection =
  | Readonly<{ kind: "exact" | "mismatch" }>
  | Readonly<{ kind: "failed"; error: OpenShellProviderError }>;

async function inspectExpectedMessagingBinding(
  input: ProviderPreparationInput,
  adapter: OpenShellProviderAdapter,
  providerName: string,
  expectedBindings: ReturnType<typeof expectedMessagingBindings>,
): Promise<ExpectedMessagingBindingInspection> {
  const expected = expectedBindings.get(providerName);
  if (!expected) return { kind: "exact" };
  const result = await adapter.getProvider({
    target: namedOpenShellGateway(input.gatewayName),
    providerName,
  });
  if (!result.ok) return { kind: "failed", error: result.error };
  return {
    kind: matchesGatewayCredentialFamilyProviderBinding(result.value, expected)
      ? "exact"
      : "mismatch",
  };
}

function throwAfterCleanup(deps: ProviderPreparationDeps, message: string): never {
  const providerFailure = new Error(message);
  try {
    deps.cleanupCreateSources();
  } catch (error) {
    const cleanupFailure =
      error instanceof Error ? error : new Error("Temporary sandbox create-source cleanup failed.");
    throw new AggregateError(
      [providerFailure, cleanupFailure],
      `${message} Temporary sandbox create-source cleanup also failed.`,
    );
  }
  throw providerFailure;
}

function requireExactMessagingBinding(
  providerName: string,
  inspection: ExpectedMessagingBindingInspection,
  phase: "before sandbox creation" | "after publication",
  deps: ProviderPreparationDeps,
): void {
  if (inspection.kind === "exact") return;
  if (inspection.kind === "failed") {
    throwAfterCleanup(
      deps,
      `Could not inspect messaging provider '${providerName}' ${phase}: ${inspection.error.message}`,
    );
  }
  throwAfterCleanup(
    deps,
    `OpenShell did not confirm messaging provider '${providerName}' ${phase}.`,
  );
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

  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  const profile = await adapter.importProviderProfile({
    target,
    profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
  });
  if (!profile.ok) {
    throwAfterCleanup(
      deps,
      `Could not prepare the OpenShell messaging credential profile: ${profile.error.message}`,
    );
  }

  for (const providerName of attachedMessagingProviders) {
    requireExactMessagingBinding(
      providerName,
      await inspectExpectedMessagingBinding(input, adapter, providerName, expectedBindings),
      "before sandbox creation",
      deps,
    );
  }
}

export async function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<void> {
  const runtimeProvider = resolveRegisteredRuntimeProvider(input.openshellDriver);
  if (!runtimeProvider || runtimeProvider.gateway.launcher !== "nemoclaw") return;

  const expectedBindings = expectedMessagingBindings(input);
  const inferenceProvider =
    input.inferenceProvider === input.transactionBoundInferenceProvider
      ? null
      : input.inferenceProvider;
  const providersRequiringExistenceProbe = new Set(
    [
      inferenceProvider,
      ...input.messagingProviders.filter((name) => !expectedBindings.has(name)),
    ].filter((provider): provider is string => Boolean(provider)),
  );
  const attachedProviders = new Set(
    [
      ...providersRequiringExistenceProbe,
      ...input.messagingProviders,
      ...input.extraProviders,
    ].filter((provider) => provider !== input.transactionBoundInferenceProvider),
  );
  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  for (const attachedProvider of attachedProviders) {
    if (providersRequiringExistenceProbe.has(attachedProvider)) {
      const observed = await adapter.getProvider({ target, providerName: attachedProvider });
      if (!observed.ok) {
        if (observed.error.kind === "command" && observed.error.reason === "not_found") continue;
        throwAfterCleanup(
          deps,
          `Could not inspect attached provider '${attachedProvider}' before publication: ${observed.error.message}`,
        );
      }
    }
    const refreshed = await adapter.updateProvider({
      target,
      providerName: attachedProvider,
      credentials: [],
      config: [],
    });
    if (!refreshed.ok) {
      throwAfterCleanup(
        deps,
        `Could not publish attached provider '${attachedProvider}' before managed sandbox creation: ${refreshed.error.message}`,
      );
    }
    requireExactMessagingBinding(
      attachedProvider,
      await inspectExpectedMessagingBinding(input, adapter, attachedProvider, expectedBindings),
      "after publication",
      deps,
    );
  }
}
