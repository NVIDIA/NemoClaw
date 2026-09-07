// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
  OpenShellProviderResult,
} from "../../adapters/openshell/provider-adapter";
import {
  createCliOpenShellProviderAdapter,
  type RunProviderCommand,
} from "../../adapters/openshell/provider-adapter-cli";
import {
  selectedOpenShellGateway,
  type OpenShellGatewayTarget,
} from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { redactStandaloneSecretsFull } from "../../security/redact";
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import { filterEnabledPlanEntries } from "./plan-filter";
import type {
  MessagingCredentialApplyOptions,
  MessagingCredentialApplyResult,
  MessagingCredentialProviderEphemeralInput,
  MessagingProviderCleanupOptions,
  MessagingProviderCleanupResult,
  MessagingProviderRefreshEphemeralInput,
} from "./types";

type MessagingCredentialApplyEntry = MessagingCredentialApplyResult["upserted"][number];
type MessagingCredentialReuseEntry = MessagingCredentialApplyResult["reused"][number];
type MessagingMissingCredentialEntry = MessagingCredentialApplyResult["missing"][number];
type ProviderBindingState = "collision" | "exact" | "indeterminate" | "missing";

const MESSAGING_PROVIDER_BINDING_CONFLICT = "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT";
const MESSAGING_PROVIDER_MUTATION_FAILURE = "NEMOCLAW_MESSAGING_PROVIDER_MUTATION_FAILURE";
const REFRESH_POLL_ATTEMPTS = 50;
const REFRESH_POLL_INTERVAL_MS = 3_000;
const REFRESH_DEADLINE_MS = 300_000;
const REFRESH_STATUS_TIMEOUT_MS = 15_000;

export class MessagingProviderApplyError extends Error {
  readonly code: string;
  readonly mutatedProviderNames: readonly string[];
  readonly createdProviderNames: readonly string[];
  readonly replacedProviderNames: readonly string[];

  constructor(input: {
    readonly message: string;
    readonly bindingConflict?: boolean;
    readonly mutatedProviderNames?: readonly string[];
    readonly createdProviderNames?: readonly string[];
    readonly replacedProviderNames?: readonly string[];
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "MessagingProviderApplyError";
    this.code = input.bindingConflict
      ? MESSAGING_PROVIDER_BINDING_CONFLICT
      : MESSAGING_PROVIDER_MUTATION_FAILURE;
    this.mutatedProviderNames = uniqueStrings(input.mutatedProviderNames ?? []);
    this.createdProviderNames = uniqueStrings(input.createdProviderNames ?? []);
    this.replacedProviderNames = uniqueStrings(input.replacedProviderNames ?? []);
  }
}

export function isMessagingProviderBindingConflict(
  error: unknown,
): error is MessagingProviderApplyError {
  return (
    error instanceof Error && Reflect.get(error, "code") === MESSAGING_PROVIDER_BINDING_CONFLICT
  );
}

export function isMessagingProviderMutationFailure(
  error: unknown,
): error is MessagingProviderApplyError {
  return (
    error instanceof Error && Reflect.get(error, "code") === MESSAGING_PROVIDER_MUTATION_FAILURE
  );
}

export async function applyCredentialsAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingCredentialApplyOptions,
): Promise<MessagingCredentialApplyResult> {
  const target = options.target ?? selectedOpenShellGateway();
  const providerAdapter = resolveProviderAdapter(options);
  const definitions =
    options.definitions ??
    definitionsFromPlan(
      options.env ?? process.env,
      filterEnabledPlanEntries(plan, plan.credentialBindings),
    );
  const refreshes = options.refreshes ?? [];
  assertUniqueDefinitions(definitions);
  assertRefreshDefinitions(refreshes, definitions);
  assertAuthorizedAttachment(options);

  const states = new Map<string, ProviderBindingState>();
  for (const definition of definitions) {
    const observed = await providerAdapter.getProvider({
      target,
      providerName: definition.providerName,
    });
    const state = classifyProviderDefinition(observed, definition);
    const credentialAvailability = definition.credentials.map(({ value }) => Boolean(value));
    const hasAnyCredential = credentialAvailability.some(Boolean);
    const hasEveryCredential = credentialAvailability.every(Boolean);
    states.set(definition.providerName, state);
    if (state === "indeterminate") {
      throw new MessagingProviderApplyError({
        message: `Could not inspect messaging provider '${definition.providerName}': ${providerFailureMessage(observed)}`,
      });
    }
    if (state === "collision" && (!options.replaceExisting || !hasEveryCredential)) {
      throw bindingConflict(definition);
    }
    if (state === "missing" && hasAnyCredential && !hasEveryCredential) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' is missing required credential material for creation.`,
      });
    }
  }

  if (
    options.requireCompleteBindings &&
    definitions.some(
      (definition) =>
        states.get(definition.providerName) === "missing" &&
        definition.credentials.every(({ value }) => !value),
    )
  ) {
    throw new MessagingProviderApplyError({
      message: "A required messaging provider is missing and has no credential material.",
    });
  }

  await prepareProfiles(definitions, target, providerAdapter);

  const upserted: MessagingCredentialApplyEntry[] = [];
  const reused: MessagingCredentialReuseEntry[] = [];
  const missing: MessagingMissingCredentialEntry[] = [];
  const mutatedProviderNames: string[] = [];
  const createdProviderNames: string[] = [];
  const replacedProviderNames: string[] = [];

  for (const definition of definitions) {
    let state = states.get(definition.providerName) ?? "indeterminate";
    const credentials = definition.credentials.filter(
      (credential): credential is Readonly<{ name: string; value: string }> =>
        typeof credential.value === "string" && credential.value.length > 0,
    );
    if (credentials.length === 0) {
      if (state === "exact") reused.push(toReuseEntry(definition));
      else missing.push(toMissingEntry(definition));
      continue;
    }

    if (state === "collision") {
      try {
        await deleteProviderForReplacement(definition.providerName, options, providerAdapter);
      } catch (error) {
        throw withMutationEvidence(
          error,
          mutatedProviderNames,
          createdProviderNames,
          replacedProviderNames,
        );
      }
      mutatedProviderNames.push(definition.providerName);
      replacedProviderNames.push(definition.providerName);
      state = "missing";
    }

    const refreshCredentialKeys = new Set(
      state === "exact"
        ? refreshes
            .filter((refresh) => refresh.providerName === definition.providerName)
            .map((refresh) => refresh.credentialKey)
        : [],
    );
    const credentialsForMutation = credentials.filter(
      ({ name }) => !refreshCredentialKeys.has(name),
    );
    if (state === "exact" && credentialsForMutation.length === 0) {
      reused.push(toReuseEntry(definition));
      continue;
    }

    const action = state === "exact" ? "update" : "create";
    try {
      options.revalidateSandboxIdentity?.(
        `${action} messaging provider ${JSON.stringify(definition.providerName)}`,
      );
    } catch (error) {
      throw withMutationEvidence(
        error,
        mutatedProviderNames,
        createdProviderNames,
        replacedProviderNames,
      );
    }
    const result =
      action === "create"
        ? await providerAdapter.createProvider({
            target,
            name: definition.providerName,
            type: definition.providerType,
            credentials,
            config: [],
            fromExisting: false,
          })
        : await providerAdapter.updateProvider({
            target,
            providerName: definition.providerName,
            credentials: credentialsForMutation,
            config: [],
          });
    if (!result.ok) {
      const outcomeUncertain = mutationOutcomeUncertain(result.error);
      throw withMutationEvidence(
        `Failed to ${action} messaging provider '${definition.providerName}': ${providerErrorMessage(result.error)}`,
        outcomeUncertain
          ? [...mutatedProviderNames, definition.providerName]
          : mutatedProviderNames,
        outcomeUncertain && action === "create"
          ? [...createdProviderNames, definition.providerName]
          : createdProviderNames,
        replacedProviderNames,
      );
    }
    mutatedProviderNames.push(definition.providerName);
    if (action === "create") createdProviderNames.push(definition.providerName);

    const verification = await providerAdapter.getProvider({
      target,
      providerName: definition.providerName,
    });
    if (classifyProviderDefinition(verification, definition) !== "exact") {
      throw withMutationEvidence(
        `OpenShell did not confirm messaging provider '${definition.providerName}' after ${action}.`,
        mutatedProviderNames,
        createdProviderNames,
        replacedProviderNames,
      );
    }
    try {
      options.revalidateSandboxIdentity?.(
        `confirm messaging provider ${JSON.stringify(definition.providerName)} after ${action}`,
      );
    } catch (error) {
      throw withMutationEvidence(
        error,
        mutatedProviderNames,
        createdProviderNames,
        replacedProviderNames,
      );
    }
    upserted.push({
      channelId: definition.channelId,
      credentialId: definition.credentialId,
      providerName: definition.providerName,
      envKey: definition.credentials[0]?.name ?? "",
      action,
    });
  }

  try {
    await configureRefreshes(refreshes, options, providerAdapter);
  } catch (error) {
    throw withMutationEvidence(
      error,
      mutatedProviderNames,
      createdProviderNames,
      replacedProviderNames,
    );
  }

  const providerNames = uniqueStrings([
    ...upserted.map((entry) => entry.providerName),
    ...reused.map((entry) => entry.providerName),
  ]);
  if (options.attachToSandbox) {
    try {
      await attachProviders(providerNames, options.attachToSandbox, options, providerAdapter);
    } catch (error) {
      throw withMutationEvidence(
        error,
        mutatedProviderNames,
        createdProviderNames,
        replacedProviderNames,
      );
    }
  }

  return {
    upserted,
    reused,
    missing,
    replacedProviderNames,
    providerNames,
    sandboxCreateProviderArgs: providerNames.flatMap((providerName) => [
      "--provider",
      providerName,
    ]),
  };
}

export async function cleanupProvidersAtOpenShell(
  providerNames: readonly string[],
  options: MessagingProviderCleanupOptions,
): Promise<MessagingProviderCleanupResult> {
  const target = options.target ?? selectedOpenShellGateway();
  const allowed = new Set(options.allowedSandboxes ?? []);
  const removedProviderNames: string[] = [];
  const absentProviderNames: string[] = [];
  const detachedAttachments: Array<{ providerName: string; sandboxName: string }> = [];
  const residualProviders: Array<{ providerName: string; error: OpenShellProviderError }> = [];

  for (const providerName of uniqueStrings(providerNames)) {
    const providerDetachedAttachments: Array<{ providerName: string; sandboxName: string }> = [];
    const initialIdentityError = cleanupIdentityError(options, providerName, "delete");
    if (initialIdentityError) {
      residualProviders.push({ providerName, error: redactedProviderError(initialIdentityError) });
      continue;
    }
    const first = await options.providerAdapter.deleteProvider({ target, providerName });
    if (first.ok) {
      removedProviderNames.push(providerName);
      continue;
    }
    if (isNotFound(first)) {
      absentProviderNames.push(providerName);
      continue;
    }
    if (!isAttached(first) || !attachmentsAuthorized(first.error.attachedSandboxes, allowed)) {
      residualProviders.push({ providerName, error: redactedProviderError(first.error) });
      continue;
    }

    let detachFailed: OpenShellProviderError | null = null;
    for (const sandboxName of first.error.attachedSandboxes ?? []) {
      try {
        options.revalidateSandboxIdentity?.(
          `detach messaging provider ${JSON.stringify(providerName)} from sandbox ${JSON.stringify(sandboxName)} during cleanup`,
        );
        const detached = await options.providerAdapter.detachProvider({
          target,
          providerName,
          sandboxName,
        });
        if (!detached.ok) {
          detachFailed = detached.error;
          break;
        }
        providerDetachedAttachments.push({ providerName, sandboxName });
        options.revalidateSandboxIdentity?.(
          `confirm messaging provider ${JSON.stringify(providerName)} cleanup detach from sandbox ${JSON.stringify(sandboxName)}`,
        );
      } catch {
        detachFailed = {
          kind: "validation",
          message: "Sandbox identity changed during messaging provider cleanup.",
        };
        break;
      }
    }
    if (detachFailed) {
      detachedAttachments.push(...providerDetachedAttachments);
      residualProviders.push({
        providerName,
        error: await restoreCleanupAttachments(
          providerName,
          providerDetachedAttachments,
          detachFailed,
          options,
          options.providerAdapter,
          target,
        ),
      });
      continue;
    }
    const retryIdentityError = cleanupIdentityError(options, providerName, "retry deletion of");
    if (retryIdentityError) {
      detachedAttachments.push(...providerDetachedAttachments);
      residualProviders.push({
        providerName,
        error: await restoreCleanupAttachments(
          providerName,
          providerDetachedAttachments,
          retryIdentityError,
          options,
          options.providerAdapter,
          target,
        ),
      });
      continue;
    }
    const retried = await options.providerAdapter.deleteProvider({ target, providerName });
    detachedAttachments.push(...providerDetachedAttachments);
    if (retried.ok) removedProviderNames.push(providerName);
    else if (isNotFound(retried)) absentProviderNames.push(providerName);
    else {
      residualProviders.push({
        providerName,
        error: await restoreCleanupAttachments(
          providerName,
          providerDetachedAttachments,
          retried.error,
          options,
          options.providerAdapter,
          target,
        ),
      });
    }
  }

  return {
    removedProviderNames,
    absentProviderNames,
    detachedAttachments,
    residualProviders,
  };
}

async function restoreCleanupAttachments(
  providerName: string,
  attachments: readonly Readonly<{ providerName: string; sandboxName: string }>[],
  cleanupError: OpenShellProviderError,
  options: Pick<MessagingProviderCleanupOptions, "revalidateSandboxIdentity">,
  providerAdapter: OpenShellProviderAdapter,
  target: OpenShellGatewayTarget,
): Promise<OpenShellProviderError> {
  const failures: Array<{ sandboxName: string; error: OpenShellProviderError }> = [];
  for (const { sandboxName } of [...attachments].reverse()) {
    const before = cleanupIdentityError(options, providerName, "restore attachment for");
    if (before) {
      failures.push({ sandboxName, error: before });
      continue;
    }
    let restored: Awaited<ReturnType<OpenShellProviderAdapter["attachProvider"]>>;
    try {
      restored = await providerAdapter.attachProvider({
        target,
        providerName,
        sandboxName,
      });
    } catch (error) {
      failures.push({
        sandboxName,
        error: rejectedProviderOperationError(error),
      });
      continue;
    }
    if (!restored.ok) {
      failures.push({ sandboxName, error: restored.error });
      continue;
    }
    const after = cleanupIdentityError(options, providerName, "confirm restored attachment for");
    if (after) failures.push({ sandboxName, error: after });
  }

  const redactedCleanupError = redactedProviderError(cleanupError);
  if (failures.length === 0) return redactedCleanupError;
  const recovery = failures
    .map(
      ({ sandboxName, error }) =>
        `${JSON.stringify(sandboxName)}: ${redactedProviderError(error).message}`,
    )
    .join("; ");
  return {
    ...redactedCleanupError,
    message:
      `${redactedCleanupError.message} Automatic attachment recovery failed for provider ` +
      `${JSON.stringify(providerName)} on sandbox ${recovery}. Channel delivery may remain interrupted.`,
  };
}

function cleanupIdentityError(
  options: Pick<MessagingProviderCleanupOptions, "revalidateSandboxIdentity">,
  providerName: string,
  action: string,
): OpenShellProviderError | null {
  try {
    options.revalidateSandboxIdentity?.(
      `${action} messaging provider ${JSON.stringify(providerName)} during cleanup`,
    );
    return null;
  } catch {
    return {
      kind: "validation",
      message: "Sandbox identity changed during messaging provider cleanup.",
    };
  }
}

function definitionsFromPlan(
  env: NodeJS.ProcessEnv,
  bindings: readonly SandboxMessagingCredentialBindingPlan[],
): MessagingCredentialProviderEphemeralInput[] {
  const profile = {
    profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    profileType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  } as const;
  return bindings.map((binding) => ({
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentials: [
      { name: binding.providerEnvKey, value: readCredentialEnv(env, binding.providerEnvKey) },
    ],
    profile,
  }));
}

function assertUniqueDefinitions(
  definitions: readonly MessagingCredentialProviderEphemeralInput[],
): void {
  const names = new Set<string>();
  const profilePaths = new Map<string, string>();
  for (const definition of definitions) {
    if (names.has(definition.providerName)) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' is defined more than once.`,
      });
    }
    names.add(definition.providerName);
    if (
      (definition.profile && definition.profile.profileType !== definition.providerType) ||
      definition.credentials.length === 0 ||
      new Set(definition.credentials.map(({ name }) => name)).size !== definition.credentials.length
    ) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' has an invalid credential profile definition.`,
      });
    }
    if (!definition.profile) continue;
    const existingPath = profilePaths.get(definition.profile.profileType);
    if (existingPath && existingPath !== definition.profile.profilePath) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider profile '${definition.profile.profileType}' has conflicting definitions.`,
      });
    }
    profilePaths.set(definition.profile.profileType, definition.profile.profilePath);
  }
}

function assertRefreshDefinitions(
  refreshes: readonly MessagingProviderRefreshEphemeralInput[],
  definitions: readonly MessagingCredentialProviderEphemeralInput[],
): void {
  const definitionsByName = new Map(
    definitions.map((definition) => [definition.providerName, definition]),
  );
  const refreshKeys = new Set<string>();
  for (const refresh of refreshes) {
    const definition = definitionsByName.get(refresh.providerName);
    const refreshKey = `${refresh.providerName}\u0000${refresh.credentialKey}`;
    const materialKeys = [
      ...refresh.material.map(({ key }) => key),
      ...refresh.secretMaterial.map(({ key }) => key),
    ];
    if (
      refreshKeys.has(refreshKey) ||
      !definition ||
      !definition.credentials.some(({ name }) => name === refresh.credentialKey) ||
      !refresh.strategy ||
      materialKeys.length === 0 ||
      materialKeys.some((key) => !key) ||
      new Set(materialKeys).size !== materialKeys.length
    ) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${refresh.providerName}' has an invalid refresh definition.`,
      });
    }
    refreshKeys.add(refreshKey);
  }
}

function assertAuthorizedAttachment(options: MessagingCredentialApplyOptions): void {
  if (
    options.attachToSandbox &&
    !(options.allowedSandboxes ?? []).includes(options.attachToSandbox)
  ) {
    throw new MessagingProviderApplyError({
      message: `Messaging provider attachment to sandbox '${options.attachToSandbox}' is not authorized for this operation.`,
    });
  }
}

async function prepareProfiles(
  definitions: readonly MessagingCredentialProviderEphemeralInput[],
  target: OpenShellGatewayTarget,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const profiles = new Map(
    definitions.flatMap(({ profile }) =>
      profile ? [[profile.profileType, profile.profilePath] as const] : [],
    ),
  );
  for (const [profileType, profilePath] of profiles) {
    const imported = await providerAdapter.importProviderProfile({ target, profilePath });
    if (!imported.ok) {
      throw new MessagingProviderApplyError({
        message: `Could not prepare messaging provider profile '${profileType}': ${providerErrorMessage(imported.error)}`,
      });
    }
  }
}

function readCredentialEnv(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const raw = env[envKey];
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\r/gu, "").trim();
  return normalized || null;
}

function toReuseEntry(
  definition: MessagingCredentialProviderEphemeralInput,
): MessagingCredentialReuseEntry {
  return {
    channelId: definition.channelId,
    credentialId: definition.credentialId,
    providerName: definition.providerName,
    envKey: definition.credentials[0]?.name ?? "",
  };
}

function toMissingEntry(
  definition: MessagingCredentialProviderEphemeralInput,
): MessagingMissingCredentialEntry {
  return {
    channelId: definition.channelId,
    credentialId: definition.credentialId,
    providerName: definition.providerName,
    envKey: definition.credentials[0]?.name ?? "",
  };
}

function classifyProviderDefinition(
  result: OpenShellProviderResult<OpenShellProviderMetadata>,
  definition: MessagingCredentialProviderEphemeralInput,
): ProviderBindingState {
  if (!result.ok) {
    return result.error.kind === "command" && result.error.reason === "not_found"
      ? "missing"
      : "indeterminate";
  }
  const expectedCredentialKeys = definition.credentials.map(({ name }) => name).sort();
  const actualCredentialKeys = [...result.value.credentialKeys].sort();
  return result.value.name === definition.providerName &&
    result.value.type === definition.providerType &&
    result.value.configKeys.length === 0 &&
    actualCredentialKeys.length === expectedCredentialKeys.length &&
    actualCredentialKeys.every((key, index) => key === expectedCredentialKeys[index])
    ? "exact"
    : "collision";
}

function providerFailureMessage(
  result: OpenShellProviderResult<OpenShellProviderMetadata>,
): string {
  return result.ok ? "provider metadata did not match" : providerErrorMessage(result.error);
}

function providerErrorMessage(error: OpenShellProviderError): string {
  return redactStandaloneSecretsFull(error.message);
}

function redactedProviderError(error: OpenShellProviderError): OpenShellProviderError {
  return { ...error, message: providerErrorMessage(error) };
}

function bindingConflict(
  definition: MessagingCredentialProviderEphemeralInput,
): MessagingProviderApplyError {
  return new MessagingProviderApplyError({
    message:
      definition.providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE
        ? `Messaging provider '${definition.providerName}' does not match the required endpointless credential binding.`
        : `Messaging provider '${definition.providerName}' does not match the required '${definition.providerType}' credential binding.`,
    bindingConflict: true,
  });
}

async function deleteProviderForReplacement(
  providerName: string,
  options: MessagingCredentialApplyOptions,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  options.revalidateSandboxIdentity?.(`delete messaging provider ${JSON.stringify(providerName)}`);
  let result = await providerAdapter.deleteProvider({ target, providerName });
  if (result.ok) return;
  if (!isAttached(result)) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}': ${providerErrorMessage(result.error)}`,
      mutatedProviderNames: mutationOutcomeUncertain(result.error) ? [providerName] : [],
    });
  }
  const allowed = new Set(options.allowedSandboxes ?? []);
  if (!attachmentsAuthorized(result.error.attachedSandboxes, allowed)) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}' because its sandbox attachments are not authorized for this operation.`,
      bindingConflict: true,
    });
  }

  const detachedAttachments: Array<{ providerName: string; sandboxName: string }> = [];
  for (const sandboxName of result.error.attachedSandboxes ?? []) {
    try {
      options.revalidateSandboxIdentity?.(
        `detach messaging provider ${JSON.stringify(providerName)} from sandbox ${JSON.stringify(sandboxName)}`,
      );
      let detachResult: Awaited<ReturnType<OpenShellProviderAdapter["detachProvider"]>>;
      try {
        detachResult = await providerAdapter.detachProvider({
          target,
          providerName,
          sandboxName,
        });
      } catch (error) {
        const rejected = rejectedProviderOperationError(error);
        throw new MessagingProviderApplyError({
          message: `Could not detach messaging provider '${providerName}' from sandbox '${sandboxName}': ${rejected.message}`,
          mutatedProviderNames: [providerName],
        });
      }
      if (!detachResult.ok) {
        throw new MessagingProviderApplyError({
          message: `Could not detach messaging provider '${providerName}' from sandbox '${sandboxName}': ${providerErrorMessage(detachResult.error)}`,
          mutatedProviderNames:
            detachedAttachments.length > 0 || mutationOutcomeUncertain(detachResult.error)
              ? [providerName]
              : [],
        });
      }
      detachedAttachments.push({ providerName, sandboxName });
      options.revalidateSandboxIdentity?.(
        `confirm messaging provider ${JSON.stringify(providerName)} detach from sandbox ${JSON.stringify(sandboxName)}`,
      );
    } catch (error) {
      if (detachedAttachments.length > 0) {
        await throwReplacementFailureAfterAttachmentRecovery(
          providerName,
          detachedAttachments,
          error,
          options,
          providerAdapter,
          target,
        );
      }
      throw redactedMutationFailure(error);
    }
  }
  try {
    options.revalidateSandboxIdentity?.(
      `delete messaging provider ${JSON.stringify(providerName)}`,
    );
    result = await providerAdapter.deleteProvider({ target, providerName });
  } catch (error) {
    await throwReplacementFailureAfterAttachmentRecovery(
      providerName,
      detachedAttachments,
      error,
      options,
      providerAdapter,
      target,
    );
  }
  if (!result.ok) {
    const error = new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}': ${providerErrorMessage(result.error)}`,
      mutatedProviderNames:
        detachedAttachments.length > 0 || mutationOutcomeUncertain(result.error)
          ? [providerName]
          : [],
    });
    await throwReplacementFailureAfterAttachmentRecovery(
      providerName,
      detachedAttachments,
      error,
      options,
      providerAdapter,
      target,
    );
  }
}

async function throwReplacementFailureAfterAttachmentRecovery(
  providerName: string,
  attachments: readonly Readonly<{ providerName: string; sandboxName: string }>[],
  error: unknown,
  options: Pick<MessagingProviderCleanupOptions, "revalidateSandboxIdentity">,
  providerAdapter: OpenShellProviderAdapter,
  target: OpenShellGatewayTarget,
): Promise<never> {
  const failure = await restoreCleanupAttachments(
    providerName,
    attachments,
    rejectedProviderOperationError(error),
    options,
    providerAdapter,
    target,
  );
  throw new MessagingProviderApplyError({
    message: failure.message,
    mutatedProviderNames: [providerName],
  });
}

function rejectedProviderOperationError(error: unknown): OpenShellProviderError {
  return {
    kind: "command",
    reason: "uncertain",
    message: redactStandaloneSecretsFull(error instanceof Error ? error.message : String(error)),
  };
}

function redactedMutationFailure(error: unknown): MessagingProviderApplyError {
  const existing = error instanceof MessagingProviderApplyError ? error : undefined;
  return new MessagingProviderApplyError({
    message: redactStandaloneSecretsFull(error instanceof Error ? error.message : String(error)),
    bindingConflict: isMessagingProviderBindingConflict(error),
    mutatedProviderNames: existing?.mutatedProviderNames,
    createdProviderNames: existing?.createdProviderNames,
    replacedProviderNames: existing?.replacedProviderNames,
  });
}

function mutationOutcomeUncertain(error: OpenShellProviderError): boolean {
  return (
    error.kind === "timeout" ||
    (error.kind === "transport" && error.reason === "connection_loss") ||
    (error.kind === "command" && error.reason === "uncertain")
  );
}

async function configureRefreshes(
  refreshes: readonly MessagingProviderRefreshEphemeralInput[],
  options: MessagingCredentialApplyOptions,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  for (const refresh of refreshes) {
    options.revalidateSandboxIdentity?.(
      `configure gateway token minting for messaging provider ${JSON.stringify(refresh.providerName)}`,
    );
    let configured: Awaited<ReturnType<OpenShellProviderAdapter["configureProviderRefresh"]>>;
    try {
      configured = await providerAdapter.configureProviderRefresh({
        target,
        providerName: refresh.providerName,
        credentialKey: refresh.credentialKey,
        strategy: refresh.strategy,
        material: refresh.material,
        secretMaterial: refresh.secretMaterial,
      });
    } catch (error) {
      const message = redactStandaloneSecretsFull(
        error instanceof Error ? error.message : String(error),
      );
      throw new MessagingProviderApplyError({
        message: `Could not configure gateway token minting for messaging provider '${refresh.providerName}': ${message}`,
        mutatedProviderNames: [refresh.providerName],
      });
    }
    if (!configured.ok) {
      throw new MessagingProviderApplyError({
        message: `Could not configure gateway token minting for messaging provider '${refresh.providerName}': ${providerErrorMessage(configured.error)}`,
        mutatedProviderNames: [refresh.providerName],
      });
    }
    try {
      options.revalidateSandboxIdentity?.(
        `confirm gateway token minting configuration for messaging provider ${JSON.stringify(refresh.providerName)}`,
      );
    } catch (error) {
      throw withMutationEvidence(error, [refresh.providerName], []);
    }
    options.log?.(`Waiting for the gateway to mint ${refresh.credentialKey}.`);
    const deadline = now() + REFRESH_DEADLINE_MS;
    let status: string | null = null;
    let observationError: OpenShellProviderError | null = null;
    for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS && now() < deadline; attempt += 1) {
      const observed = await providerAdapter.getProviderRefreshStatus({
        target,
        providerName: refresh.providerName,
        credentialKey: refresh.credentialKey,
        timeoutMs: REFRESH_STATUS_TIMEOUT_MS,
      });
      if (observed.ok) {
        status = observed.value.status;
        observationError = null;
      } else {
        observationError = observed.error;
      }
      if (status === "refreshed") break;
      if (attempt + 1 < REFRESH_POLL_ATTEMPTS && now() < deadline) {
        await sleep(REFRESH_POLL_INTERVAL_MS);
      }
    }
    if (status === "refreshed") continue;
    if (observationError) {
      throw new MessagingProviderApplyError({
        message: `Could not observe gateway token minting for messaging provider '${refresh.providerName}': ${providerErrorMessage(observationError)}`,
        mutatedProviderNames: [refresh.providerName],
      });
    }
    throw new MessagingProviderApplyError({
      message: `Gateway token minting did not complete for messaging provider '${refresh.providerName}' (last status '${status ?? "unknown"}').`,
      mutatedProviderNames: [refresh.providerName],
    });
  }
}

async function attachProviders(
  providerNames: readonly string[],
  sandboxName: string,
  options: MessagingCredentialApplyOptions,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  const attachedProviderNames: string[] = [];
  for (const providerName of providerNames) {
    try {
      options.revalidateSandboxIdentity?.(
        `attach messaging provider ${JSON.stringify(providerName)} to sandbox ${JSON.stringify(sandboxName)}`,
      );
      const attached = await providerAdapter.attachProvider({
        target,
        providerName,
        sandboxName,
      });
      if (!attached.ok) {
        throw new MessagingProviderApplyError({
          message: `OpenShell did not attach messaging provider '${providerName}' to sandbox '${sandboxName}': ${providerErrorMessage(attached.error)}`,
          mutatedProviderNames: [providerName],
        });
      }
      attachedProviderNames.push(providerName);
      options.revalidateSandboxIdentity?.(
        `confirm messaging provider ${JSON.stringify(providerName)} attachment to sandbox ${JSON.stringify(sandboxName)}`,
      );
    } catch (error) {
      throw withMutationEvidence(error, [...attachedProviderNames, providerName], []);
    }
  }
}

function attachmentsAuthorized(
  attachedSandboxes: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    attachedSandboxes !== undefined &&
    attachedSandboxes.length > 0 &&
    attachedSandboxes.every((sandboxName) => allowed.has(sandboxName))
  );
}

function resolveProviderAdapter(
  options: MessagingCredentialApplyOptions,
): OpenShellProviderAdapter {
  if (options.providerAdapter) return options.providerAdapter;
  return createCliOpenShellProviderAdapter({
    run: options.runOpenshell as RunProviderCommand,
  });
}

function isAttached<T>(result: OpenShellProviderResult<T>): result is Extract<
  OpenShellProviderResult<T>,
  { ok: false }
> & {
  error: Extract<OpenShellProviderError, { kind: "command" }>;
} {
  return !result.ok && result.error.kind === "command" && result.error.reason === "attached";
}

function isNotFound<T>(result: OpenShellProviderResult<T>): boolean {
  return !result.ok && result.error.kind === "command" && result.error.reason === "not_found";
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function withMutationEvidence(
  error: unknown,
  mutatedProviderNames: readonly string[],
  createdProviderNames: readonly string[],
  replacedProviderNames: readonly string[] = [],
): MessagingProviderApplyError {
  const message = error instanceof Error ? error.message : String(error);
  const existingMutated =
    error instanceof MessagingProviderApplyError ? error.mutatedProviderNames : [];
  const existingCreated =
    error instanceof MessagingProviderApplyError ? error.createdProviderNames : [];
  const existingReplaced =
    error instanceof MessagingProviderApplyError ? error.replacedProviderNames : [];
  return new MessagingProviderApplyError({
    message,
    bindingConflict: isMessagingProviderBindingConflict(error),
    mutatedProviderNames: [...existingMutated, ...mutatedProviderNames],
    createdProviderNames: [...existingCreated, ...createdProviderNames],
    replacedProviderNames: [...existingReplaced, ...replacedProviderNames],
    cause:
      error instanceof MessagingProviderApplyError && error.cause === undefined ? undefined : error,
  });
}
