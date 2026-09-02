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
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import { filterEnabledPlanEntries } from "./plan-filter";
import type {
  MessagingCredentialApplyOptions,
  MessagingCredentialApplyResult,
  MessagingCredentialProviderDefinition,
  MessagingProviderCleanupOptions,
  MessagingProviderCleanupResult,
  MessagingProviderRefreshDefinition,
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

  constructor(input: {
    readonly message: string;
    readonly bindingConflict?: boolean;
    readonly mutatedProviderNames?: readonly string[];
    readonly createdProviderNames?: readonly string[];
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "MessagingProviderApplyError";
    this.code = input.bindingConflict
      ? MESSAGING_PROVIDER_BINDING_CONFLICT
      : MESSAGING_PROVIDER_MUTATION_FAILURE;
    this.mutatedProviderNames = uniqueStrings(input.mutatedProviderNames ?? []);
    this.createdProviderNames = uniqueStrings(input.createdProviderNames ?? []);
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

  await prepareProfiles(definitions, target, providerAdapter);

  const upserted: MessagingCredentialApplyEntry[] = [];
  const reused: MessagingCredentialReuseEntry[] = [];
  const missing: MessagingMissingCredentialEntry[] = [];
  const mutatedProviderNames: string[] = [];
  const createdProviderNames: string[] = [];

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
        throw withMutationEvidence(error, mutatedProviderNames, createdProviderNames);
      }
      mutatedProviderNames.push(definition.providerName);
      state = "missing";
    }

    const action = state === "exact" ? "update" : "create";
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
            credentials,
            config: [],
          });
    if (!result.ok) {
      throw withMutationEvidence(
        `Failed to ${action} messaging provider '${definition.providerName}': ${result.error.message}`,
        mutatedProviderNames,
        createdProviderNames,
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
    throw withMutationEvidence(error, mutatedProviderNames, createdProviderNames);
  }

  const providerNames = uniqueStrings([
    ...upserted.map((entry) => entry.providerName),
    ...reused.map((entry) => entry.providerName),
  ]);
  if (options.attachToSandbox) {
    try {
      await attachProviders(providerNames, options.attachToSandbox, options, providerAdapter);
    } catch (error) {
      throw withMutationEvidence(error, mutatedProviderNames, createdProviderNames);
    }
  }

  return {
    upserted,
    reused,
    missing,
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
      residualProviders.push({ providerName, error: first.error });
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
        detachedAttachments.push({ providerName, sandboxName });
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
      residualProviders.push({ providerName, error: detachFailed });
      continue;
    }
    const retried = await options.providerAdapter.deleteProvider({ target, providerName });
    if (retried.ok) removedProviderNames.push(providerName);
    else if (isNotFound(retried)) absentProviderNames.push(providerName);
    else residualProviders.push({ providerName, error: retried.error });
  }

  return {
    removedProviderNames,
    absentProviderNames,
    detachedAttachments,
    residualProviders,
  };
}

function definitionsFromPlan(
  env: NodeJS.ProcessEnv,
  bindings: readonly SandboxMessagingCredentialBindingPlan[],
): MessagingCredentialProviderDefinition[] {
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
  definitions: readonly MessagingCredentialProviderDefinition[],
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
      definition.profile.profileType !== definition.providerType ||
      definition.credentials.length === 0 ||
      new Set(definition.credentials.map(({ name }) => name)).size !== definition.credentials.length
    ) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' has an invalid credential profile definition.`,
      });
    }
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
  refreshes: readonly MessagingProviderRefreshDefinition[],
  definitions: readonly MessagingCredentialProviderDefinition[],
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
  definitions: readonly MessagingCredentialProviderDefinition[],
  target: OpenShellGatewayTarget,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const profiles = new Map(
    definitions.map(({ profile }) => [profile.profileType, profile.profilePath]),
  );
  for (const [profileType, profilePath] of profiles) {
    const imported = await providerAdapter.importProviderProfile({ target, profilePath });
    if (!imported.ok) {
      throw new MessagingProviderApplyError({
        message: `Could not prepare messaging provider profile '${profileType}': ${imported.error.message}`,
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
  definition: MessagingCredentialProviderDefinition,
): MessagingCredentialReuseEntry {
  return {
    channelId: definition.channelId,
    credentialId: definition.credentialId,
    providerName: definition.providerName,
    envKey: definition.credentials[0]?.name ?? "",
  };
}

function toMissingEntry(
  definition: MessagingCredentialProviderDefinition,
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
  definition: MessagingCredentialProviderDefinition,
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
    actualCredentialKeys.length === expectedCredentialKeys.length &&
    actualCredentialKeys.every((key, index) => key === expectedCredentialKeys[index])
    ? "exact"
    : "collision";
}

function providerFailureMessage(
  result: OpenShellProviderResult<OpenShellProviderMetadata>,
): string {
  return result.ok ? "provider metadata did not match" : result.error.message;
}

function bindingConflict(
  definition: MessagingCredentialProviderDefinition,
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
      message: `Could not replace messaging provider '${providerName}': ${result.error.message}`,
    });
  }
  const allowed = new Set(options.allowedSandboxes ?? []);
  if (!attachmentsAuthorized(result.error.attachedSandboxes, allowed)) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}' because its sandbox attachments are not authorized for this operation.`,
      bindingConflict: true,
    });
  }

  let detached = false;
  for (const sandboxName of result.error.attachedSandboxes ?? []) {
    try {
      options.revalidateSandboxIdentity?.(
        `detach messaging provider ${JSON.stringify(providerName)} from sandbox ${JSON.stringify(sandboxName)}`,
      );
      const detachResult = await providerAdapter.detachProvider({
        target,
        providerName,
        sandboxName,
      });
      if (!detachResult.ok) {
        throw new MessagingProviderApplyError({
          message: `Could not detach messaging provider '${providerName}' from sandbox '${sandboxName}': ${detachResult.error.message}`,
          mutatedProviderNames: detached ? [providerName] : [],
        });
      }
      detached = true;
      options.revalidateSandboxIdentity?.(
        `confirm messaging provider ${JSON.stringify(providerName)} detach from sandbox ${JSON.stringify(sandboxName)}`,
      );
    } catch (error) {
      throw withMutationEvidence(error, detached ? [providerName] : [], []);
    }
  }
  options.revalidateSandboxIdentity?.(`delete messaging provider ${JSON.stringify(providerName)}`);
  result = await providerAdapter.deleteProvider({ target, providerName });
  if (!result.ok) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}': ${result.error.message}`,
      mutatedProviderNames: detached ? [providerName] : [],
    });
  }
}

async function configureRefreshes(
  refreshes: readonly MessagingProviderRefreshDefinition[],
  options: MessagingCredentialApplyOptions,
  providerAdapter: OpenShellProviderAdapter,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  for (const refresh of refreshes) {
    const configured = await providerAdapter.configureProviderRefresh({
      target,
      providerName: refresh.providerName,
      credentialKey: refresh.credentialKey,
      strategy: refresh.strategy,
      material: refresh.material,
      secretMaterial: refresh.secretMaterial,
    });
    if (!configured.ok) {
      throw new MessagingProviderApplyError({
        message: `Could not configure gateway token minting for messaging provider '${refresh.providerName}': ${configured.error.message}`,
        mutatedProviderNames: [refresh.providerName],
      });
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
        message: `Could not observe gateway token minting for messaging provider '${refresh.providerName}': ${observationError.message}`,
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
          message: `OpenShell did not attach messaging provider '${providerName}' to sandbox '${sandboxName}': ${attached.error.message}`,
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
): MessagingProviderApplyError {
  const message = error instanceof Error ? error.message : String(error);
  const existingMutated =
    error instanceof MessagingProviderApplyError ? error.mutatedProviderNames : [];
  const existingCreated =
    error instanceof MessagingProviderApplyError ? error.createdProviderNames : [];
  return new MessagingProviderApplyError({
    message,
    bindingConflict: isMessagingProviderBindingConflict(error),
    mutatedProviderNames: [...existingMutated, ...mutatedProviderNames],
    createdProviderNames: [...existingCreated, ...createdProviderNames],
    cause: error,
  });
}
