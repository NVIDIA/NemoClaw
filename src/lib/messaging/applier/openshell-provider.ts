// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellProviderError,
  OpenShellProviderMetadata,
  OpenShellProviderResult,
} from "../../adapters/openshell/provider-adapter";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import type {
  MessagingCredentialApplyOptions,
  MessagingCredentialApplyResult,
  MessagingCredentialProviderDefinition,
  MessagingCredentialProviderProfile,
  MessagingProviderRefreshDefinition,
} from "./types";
import { filterEnabledPlanEntries } from "./plan-filter";

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
    error instanceof Error &&
    Reflect.get(error, "code") === MESSAGING_PROVIDER_BINDING_CONFLICT
  );
}

export function isMessagingProviderMutationFailure(
  error: unknown,
): error is MessagingProviderApplyError {
  return (
    error instanceof Error &&
    Reflect.get(error, "code") === MESSAGING_PROVIDER_MUTATION_FAILURE
  );
}

export async function applyCredentialsAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingCredentialApplyOptions,
): Promise<MessagingCredentialApplyResult> {
  const env = options.env ?? process.env;
  const target = options.target ?? selectedOpenShellGateway();
  const definitions =
    options.definitions ??
    definitionsFromPlan(
      env,
      filterEnabledPlanEntries(plan, plan.credentialBindings),
    );
  assertUniqueDefinitions(definitions);
  assertRefreshDefinitions(options.refreshes ?? [], definitions);

  const states = new Map<string, ProviderBindingState>();
  for (const definition of definitions) {
    const observed = await options.providerAdapter.getProvider({
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
        message: `Could not inspect messaging provider '${definition.providerName}'.`,
      });
    }
    if (
      state === "collision" &&
      (!options.replaceExisting || !hasEveryCredential)
    ) {
      throw new MessagingProviderApplyError({
        message:
          definition.providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE
            ? `Messaging provider '${definition.providerName}' does not match the required endpointless credential binding.`
            : `Messaging provider '${definition.providerName}' does not match the required '${definition.providerType}' credential binding.`,
        bindingConflict: true,
      });
    }
    if (state === "missing" && hasAnyCredential && !hasEveryCredential) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' is missing required credential material for creation.`,
      });
    }
  }
  await prepareProfiles(definitions, options);

  const upserted: MessagingCredentialApplyEntry[] = [];
  const reused: MessagingCredentialReuseEntry[] = [];
  const missing: MessagingMissingCredentialEntry[] = [];
  const mutatedProviderNames: string[] = [];
  const createdProviderNames: string[] = [];
  const failures: string[] = [];

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
        await deleteProviderForReplacement(definition.providerName, options);
      } catch (error) {
        throw withMutationEvidence(error, mutatedProviderNames, createdProviderNames);
      }
      mutatedProviderNames.push(definition.providerName);
      state = "missing";
    }

    const action = state === "exact" ? "update" : "create";
    const result =
      action === "create"
        ? await options.providerAdapter.createProvider({
            target,
            name: definition.providerName,
            type: definition.providerType,
            credentials,
            config: [],
            fromExisting: false,
          })
        : await options.providerAdapter.updateProvider({
            target,
            providerName: definition.providerName,
            credentials,
            config: [],
          });
    if (!result.ok) {
      const message = `Failed to ${action} messaging provider '${definition.providerName}': ${result.error.message}`;
      if (options.bestEffort) {
        failures.push(message);
        continue;
      }
      throw withMutationEvidence(message, mutatedProviderNames, createdProviderNames);
    }
    mutatedProviderNames.push(definition.providerName);
    if (action === "create" && state === "missing") {
      createdProviderNames.push(definition.providerName);
    }

    const verification = await options.providerAdapter.getProvider({
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

  if (failures.length > 0) {
    throw withMutationEvidence(
      failures.join("; "),
      mutatedProviderNames,
      createdProviderNames,
    );
  }
  try {
    await configureRefreshes(options.refreshes ?? [], options);
  } catch (error) {
    throw withMutationEvidence(error, mutatedProviderNames, createdProviderNames);
  }

  const providerNames = uniqueStrings([
    ...upserted.map((entry) => entry.providerName),
    ...reused.map((entry) => entry.providerName),
  ]);

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

function definitionsFromPlan(
  env: NodeJS.ProcessEnv,
  bindings: readonly SandboxMessagingCredentialBindingPlan[],
): MessagingCredentialProviderDefinition[] {
  const profile: MessagingCredentialProviderProfile = {
    kind: "endpointless",
    profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    profileType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    inferenceCapable: false,
  };
  return bindings.map((binding) => ({
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentials: [
      {
        name: binding.providerEnvKey,
        value: readCredentialEnv(env, binding.providerEnvKey),
      },
    ],
    profile,
  }));
}

function assertUniqueDefinitions(
  definitions: readonly MessagingCredentialProviderDefinition[],
): void {
  const names = new Set<string>();
  const profileContracts = new Map<string, string>();
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
      new Set(definition.credentials.map(({ name }) => name)).size !==
        definition.credentials.length
    ) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider '${definition.providerName}' has an invalid credential profile definition.`,
      });
    }
    const profileContract = profileContractKey(definition.profile);
    const existingProfileContract = profileContracts.get(definition.profile.profileType);
    if (existingProfileContract && existingProfileContract !== profileContract) {
      throw new MessagingProviderApplyError({
        message: `Messaging provider profile '${definition.profile.profileType}' has conflicting definitions.`,
      });
    }
    profileContracts.set(definition.profile.profileType, profileContract);
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

function profileContractKey(profile: MessagingCredentialProviderProfile): string {
  return profile.kind === "endpointless"
    ? JSON.stringify([
        profile.kind,
        profile.profilePath,
        profile.profileType,
        profile.inferenceCapable,
      ])
    : JSON.stringify([
        profile.kind,
        profile.profilePath,
        profile.profileType,
        profile.contractDigest,
      ]);
}

async function prepareProfiles(
  definitions: readonly MessagingCredentialProviderDefinition[],
  options: MessagingCredentialApplyOptions,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  const profiles = new Map<string, MessagingCredentialProviderProfile>();
  for (const definition of definitions) {
    profiles.set(definition.profile.profileType, definition.profile);
  }
  for (const profile of profiles.values()) {
    if (profile.kind === "endpointless") {
      const result = await options.providerAdapter.ensureEndpointlessProviderProfile({
        target,
        profilePath: profile.profilePath,
        profileType: profile.profileType,
        inferenceCapable: profile.inferenceCapable,
      });
      if (!result.ok) throw profileFailure(result.error, profile.profileType, profile.kind);
      continue;
    }
    const imported = await options.providerAdapter.importProviderProfile({
      target,
      profilePath: profile.profilePath,
    });
    if (!imported.ok) throw profileFailure(imported.error, profile.profileType, profile.kind);
    const inspected = await options.providerAdapter.inspectProviderProfile({
      target,
      profileType: profile.profileType,
    });
    if (!inspected.ok) throw profileFailure(inspected.error, profile.profileType, profile.kind);
    if (inspected.value.contractDigest !== profile.contractDigest) {
      throw new MessagingProviderApplyError({
        message: `OpenShell provider profile '${profile.profileType}' does not match NemoClaw's checked-in credential contract.`,
      });
    }
  }
}

function readCredentialEnv(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const raw = env[envKey];
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\r/g, "").trim();
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function profileFailure(
  error: OpenShellProviderError,
  profileType: string,
  profileKind: MessagingCredentialProviderProfile["kind"],
): Error {
  if (error.kind === "command" && error.reason === "profile_import_failed") {
    return new Error("Could not import the OpenShell messaging credential profile.");
  }
  if (error.kind === "command" && error.reason === "profile_export_failed") {
    return new Error(
      `OpenShell provider profile '${profileType}' could not be exported for validation.`,
    );
  }
  if (error.kind === "command" && error.reason === "profile_incompatible") {
    return new Error(
      `OpenShell provider profile '${profileType}' already exists but does not match NemoClaw's ${profileKind === "endpointless" ? "endpointless " : ""}messaging credential contract.`,
    );
  }
  return new Error(`Could not prepare the OpenShell messaging credential profile: ${error.message}`);
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

async function deleteProviderForReplacement(
  providerName: string,
  options: MessagingCredentialApplyOptions,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  options.revalidateSandboxIdentity?.(`delete messaging provider ${JSON.stringify(providerName)}`);
  let result = await options.providerAdapter.deleteProvider({ target, providerName });
  if (result.ok) return;
  if (result.error.kind !== "command" || result.error.reason !== "attached") {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}': ${result.error.message}`,
    });
  }
  const attached = result.error.attachedSandboxes;
  const allowed = new Set(options.allowedSandboxes ?? []);
  if (!attached || attached.length === 0 || attached.some((name) => !allowed.has(name))) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}' because its sandbox attachments are not authorized for this operation.`,
    });
  }
  let detachedProvider = false;
  for (const sandboxName of attached) {
    options.revalidateSandboxIdentity?.(
      `detach messaging provider ${JSON.stringify(providerName)} from sandbox ${JSON.stringify(sandboxName)}`,
    );
    const detached = await options.providerAdapter.detachProvider({
      target,
      providerName,
      sandboxName,
    });
    if (!detached.ok) {
      throw new MessagingProviderApplyError({
        message: `Could not detach messaging provider '${providerName}' from sandbox '${sandboxName}': ${detached.error.message}`,
        mutatedProviderNames: detachedProvider ? [providerName] : [],
      });
    }
    detachedProvider ||= detached.value.state === "detached";
  }
  options.revalidateSandboxIdentity?.(`delete messaging provider ${JSON.stringify(providerName)}`);
  result = await options.providerAdapter.deleteProvider({ target, providerName });
  if (!result.ok) {
    throw new MessagingProviderApplyError({
      message: `Could not replace messaging provider '${providerName}': ${result.error.message}`,
      mutatedProviderNames: detachedProvider ? [providerName] : [],
    });
  }
}

async function configureRefreshes(
  refreshes: readonly MessagingProviderRefreshDefinition[],
  options: MessagingCredentialApplyOptions,
): Promise<void> {
  const target = options.target ?? selectedOpenShellGateway();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  for (const refresh of refreshes) {
    const configured = await options.providerAdapter.configureProviderRefresh({
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
      });
    }
    options.log?.(`Waiting for the gateway to mint ${refresh.credentialKey}.`);
    const deadline = now() + REFRESH_DEADLINE_MS;
    let status: string | null = null;
    let observationError: OpenShellProviderError | null = null;
    for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS && now() < deadline; attempt += 1) {
      const observed = await options.providerAdapter.getProviderRefreshStatus({
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
    if (status !== "refreshed") {
      if (observationError) {
        throw new MessagingProviderApplyError({
          message: `Could not observe gateway token minting for messaging provider '${refresh.providerName}': ${observationError.message}`,
        });
      }
      throw new MessagingProviderApplyError({
        message: `Gateway token minting did not complete for messaging provider '${refresh.providerName}' (last status '${status ?? "unknown"}').`,
      });
    }
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
    mutatedProviderNames: [...existingMutated, ...mutatedProviderNames],
    createdProviderNames: [...existingCreated, ...createdProviderNames],
    cause: error,
  });
}
