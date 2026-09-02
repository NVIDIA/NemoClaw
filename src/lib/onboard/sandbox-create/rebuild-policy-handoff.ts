// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
} from "../../adapters/openshell/policy-boundary";
import { isReviewedMessagingChannelPolicyUpgrade } from "../../messaging/channels/policy";
import { reconcileTeamsOutlookLoginCredentialBinding } from "../../policy/microsoft-login-credential-binding";
import { getCredentialBindingProviders, type InitialSandboxPolicy } from "../initial-policy";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "../temp-files";

const REBUILD_POLICY_HANDOFF_PREFIX = "nemoclaw-rebuild-policy-handoff";

type PolicyMapping = Record<string, unknown>;

export class RebuildPolicyCleanupError extends AggregateError {
  constructor(
    readonly retainedPolicyPaths: readonly string[],
    errors: readonly Error[],
  ) {
    super(errors, `Temporary sandbox create policy cleanup failed for: ${retainedPolicyPaths}.`);
    this.name = "RebuildPolicyCleanupError";
  }
}

function cleanupRebuildPolicySources(
  sources: readonly {
    readonly policyPath: string;
    readonly cleanup: () => boolean;
  }[],
): boolean {
  const retainedPolicyPaths: string[] = [];
  const errors: Error[] = [];
  for (const source of sources) {
    try {
      if (!source.cleanup()) {
        retainedPolicyPaths.push(source.policyPath);
        errors.push(new Error(`Policy cleanup returned false for '${source.policyPath}'.`));
      }
    } catch (cause) {
      retainedPolicyPaths.push(source.policyPath);
      errors.push(new Error(`Policy cleanup failed for '${source.policyPath}'.`, { cause }));
    }
  }
  if (errors.length > 0) throw new RebuildPolicyCleanupError(retainedPolicyPaths, errors);
  return true;
}

function createIdentifiedPolicyCleanup(
  policyPath: string,
  cleanup: (() => boolean) | undefined,
): (() => boolean) | undefined {
  return cleanup ? () => cleanupRebuildPolicySources([{ policyPath, cleanup }]) : undefined;
}

function createExactPolicyCleanup(
  requiredCleanups: readonly ((() => boolean) | undefined)[],
): (() => boolean) | undefined {
  if (requiredCleanups.length === 0 || requiredCleanups.some((cleanup) => !cleanup)) {
    return undefined;
  }
  const cleanups = requiredCleanups as readonly (() => boolean)[];
  return () => {
    let completed = true;
    for (const cleanup of [...cleanups].reverse()) {
      try {
        if (!cleanup()) completed = false;
      } catch {
        completed = false;
      }
    }
    return completed;
  };
}

function authorizedCredentialBindingProviders(
  source: string,
  replacementPolicy: InitialSandboxPolicy,
  additionalAuthorized: readonly string[],
): string[] {
  const observed = getCredentialBindingProviders(source);
  const authorized = new Set([
    ...(replacementPolicy.credentialBindingProviders ?? []),
    ...additionalAuthorized,
  ]);
  const unauthorized = observed.filter((provider) => !authorized.has(provider));
  if (unauthorized.length > 0) {
    throw new Error(
      "Cannot prepare rebuild policy handoff: live policy references a credential provider outside the verified replacement plan.",
    );
  }
  return observed;
}

function isPolicyMapping(value: unknown): value is PolicyMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyMapping(value: unknown, label: string): PolicyMapping {
  if (!isPolicyMapping(value)) {
    throw new Error(`Cannot prepare rebuild policy handoff: ${label} must be a mapping.`);
  }
  return value;
}

function policyPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Cannot prepare rebuild policy handoff: ${label} must be a string array.`);
  }
  return [...value];
}

function optionalPolicyPaths(mapping: PolicyMapping, field: string, label: string): string[] {
  return mapping[field] === undefined ? [] : policyPaths(mapping[field], `${label}.${field}`);
}

function mergeReplacementFilesystemAccess(
  live: PolicyMapping,
  replacement: PolicyMapping,
): boolean {
  const replacementFilesystemValue = replacement.filesystem_policy;
  if (replacementFilesystemValue === undefined) return false;
  const replacementFilesystem = policyMapping(
    replacementFilesystemValue,
    "replacement filesystem_policy",
  );
  const requiredReadOnly = optionalPolicyPaths(
    replacementFilesystem,
    "read_only",
    "replacement filesystem_policy",
  );
  const requiredReadWrite = optionalPolicyPaths(
    replacementFilesystem,
    "read_write",
    "replacement filesystem_policy",
  );
  if (requiredReadOnly.length === 0 && requiredReadWrite.length === 0) return false;

  const liveFilesystemValue = live.filesystem_policy;
  const liveFilesystem =
    liveFilesystemValue === undefined
      ? {}
      : structuredClone(policyMapping(liveFilesystemValue, "live filesystem_policy"));
  let readOnly = optionalPolicyPaths(liveFilesystem, "read_only", "live filesystem_policy");
  const readWrite = optionalPolicyPaths(liveFilesystem, "read_write", "live filesystem_policy");
  let changed = false;

  for (const requiredPath of requiredReadWrite) {
    if (readOnly.includes(requiredPath)) {
      readOnly = readOnly.filter((entry) => entry !== requiredPath);
      changed = true;
    }
    if (!readWrite.includes(requiredPath)) {
      readWrite.push(requiredPath);
      changed = true;
    }
  }
  for (const requiredPath of requiredReadOnly) {
    if (readOnly.includes(requiredPath) || readWrite.includes(requiredPath)) continue;
    readOnly.push(requiredPath);
    changed = true;
  }
  if (!changed) return false;

  liveFilesystem.read_only = readOnly;
  liveFilesystem.read_write = readWrite;
  live.filesystem_policy = liveFilesystem;
  return true;
}

function mergeMissingReplacementProcessIdentity(
  live: PolicyMapping,
  replacement: PolicyMapping,
): boolean {
  const replacementProcessValue = replacement.process;
  if (replacementProcessValue === undefined) return false;
  const replacementProcess = policyMapping(replacementProcessValue, "replacement process");
  const liveProcessValue = live.process;
  const liveProcess =
    liveProcessValue === undefined
      ? {}
      : structuredClone(policyMapping(liveProcessValue, "live process"));
  let changed = false;
  for (const field of ["run_as_user", "run_as_group"] as const) {
    if (liveProcess[field] !== undefined || typeof replacementProcess[field] !== "string") continue;
    liveProcess[field] = replacementProcess[field];
    changed = true;
  }
  if (changed) live.process = liveProcess;
  return changed;
}

function mergeRequestedReplacementNetworkPolicies(
  live: PolicyMapping,
  replacement: PolicyMapping,
  requiredKeys: readonly string[],
  removedKeys: readonly string[],
  requiredPolicySources: readonly string[],
): boolean {
  if (requiredKeys.length === 0 && removedKeys.length === 0) return false;

  const required = new Set(requiredKeys);
  const removed = new Set(removedKeys);
  for (const key of required) {
    if (removed.has(key)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: network policy '${key}' is both required and removed.`,
      );
    }
  }
  const replacementPolicies =
    replacement.network_policies === undefined
      ? {}
      : structuredClone(
          policyMapping(replacement.network_policies, "replacement network_policies"),
        );
  if (required.size > 0) {
    const requiredPolicies: PolicyMapping = {};
    for (const source of requiredPolicySources) {
      let parsed: unknown;
      try {
        parsed = YAML.parse(source);
      } catch {
        throw new Error(
          "Cannot prepare rebuild policy handoff: required network policy source is invalid YAML.",
        );
      }
      const policy = policyMapping(parsed, "required network policy source");
      const policies = policyMapping(
        policy.network_policies,
        "required network policy source network_policies",
      );
      for (const [key, value] of Object.entries(policies)) {
        if (!required.has(key)) continue;
        const existing = requiredPolicies[key];
        if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
          throw new Error(
            `Cannot prepare rebuild policy handoff: required network policy '${key}' has conflicting replacement sources.`,
          );
        }
        requiredPolicies[key] = structuredClone(value);
      }
    }
    Object.assign(replacementPolicies, requiredPolicies);
  }
  const livePolicies =
    live.network_policies === undefined
      ? {}
      : structuredClone(policyMapping(live.network_policies, "live network_policies"));
  let changed = false;

  for (const key of removed) {
    if (!Object.hasOwn(livePolicies, key)) continue;
    delete livePolicies[key];
    changed = true;
  }
  for (const key of required) {
    if (!Object.hasOwn(replacementPolicies, key)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: required network policy '${key}' is absent from the replacement policy.`,
      );
    }
    if (Object.hasOwn(livePolicies, key)) {
      if (!isDeepStrictEqual(livePolicies[key], replacementPolicies[key])) {
        if (
          isReviewedMessagingChannelPolicyUpgrade(key, livePolicies[key], replacementPolicies[key])
        ) {
          livePolicies[key] = structuredClone(replacementPolicies[key]);
          changed = true;
          continue;
        }
        throw new Error(
          `Cannot prepare rebuild policy handoff: live network policy '${key}' does not match the enabled channel requirement.`,
        );
      }
      continue;
    }
    livePolicies[key] = structuredClone(replacementPolicies[key]);
    changed = true;
  }

  if (changed) live.network_policies = livePolicies;
  return changed;
}

function removeCredentialBoundEndpointsForProviders(
  live: PolicyMapping,
  removedProviders: readonly string[],
): boolean {
  if (removedProviders.length === 0 || live.network_policies === undefined) return false;
  const removed = new Set(removedProviders);
  const policies = policyMapping(live.network_policies, "live network_policies");
  let changed = false;

  for (const [key, value] of Object.entries(policies)) {
    if (!isPolicyMapping(value) || !Array.isArray(value.endpoints)) continue;
    const endpoints = value.endpoints.filter((endpoint) => {
      if (!isPolicyMapping(endpoint) || !isPolicyMapping(endpoint.credential_binding)) return true;
      const provider = endpoint.credential_binding.provider;
      return typeof provider !== "string" || !removed.has(provider);
    });
    if (endpoints.length === value.endpoints.length) continue;
    changed = true;
    if (endpoints.length === 0) {
      delete policies[key];
      continue;
    }
    value.endpoints = endpoints;
  }

  return changed;
}

/**
 * Preserve the live OpenShell policy during a rebuild.
 * Add only missing process identity, filesystem access, and active messaging policy keys.
 * Apply those requirements only to the replacement create input.
 * Stop the rebuild if an enabled channel conflicts with the live policy.
 */
export function mergeReplacementPolicyAccess(
  livePolicySource: string,
  replacementPolicySource: string,
  requiredNetworkPolicyKeys: readonly string[] = [],
  removedNetworkPolicyKeys: readonly string[] = [],
  requiredNetworkPolicySources: readonly string[] = [],
  removedCredentialBindingProviders: readonly string[] = [],
  sandboxName?: string,
): { readonly changed: boolean; readonly source: string } {
  const providerNormalizedLivePolicySource = stripProviderComposedPolicies(livePolicySource);
  const teamsActive = requiredNetworkPolicyKeys.includes("teams")
    ? true
    : removedNetworkPolicyKeys.includes("teams")
      ? false
      : null;
  const normalizedLivePolicySource =
    teamsActive !== null
      ? reconcileTeamsOutlookLoginCredentialBinding(
          providerNormalizedLivePolicySource,
          sandboxName,
          teamsActive,
        )
      : providerNormalizedLivePolicySource;
  const live = structuredClone(
    parseOpenShellPolicy(normalizedLivePolicySource).policy,
  ) as PolicyMapping;
  const replacement = parseOpenShellPolicy(replacementPolicySource).policy as PolicyMapping;
  const processChanged = mergeMissingReplacementProcessIdentity(live, replacement);
  const filesystemChanged = mergeReplacementFilesystemAccess(live, replacement);
  const providerNetworkChanged = removeCredentialBoundEndpointsForProviders(
    live,
    removedCredentialBindingProviders,
  );
  const networkChanged = mergeRequestedReplacementNetworkPolicies(
    live,
    replacement,
    requiredNetworkPolicyKeys,
    removedNetworkPolicyKeys,
    requiredNetworkPolicySources,
  );
  const changed =
    normalizedLivePolicySource !== livePolicySource ||
    processChanged ||
    filesystemChanged ||
    providerNetworkChanged ||
    networkChanged;
  return changed
    ? { changed: true, source: YAML.stringify(live) }
    : { changed: false, source: normalizedLivePolicySource };
}

/** Select the live policy or materialize a temporary handoff policy for an explicit rebuild. */
export function materializeRebuildPolicyHandoff(input: {
  readonly sandboxName?: string;
  readonly livePolicyPath: string;
  readonly replacementPolicy: InitialSandboxPolicy;
  readonly requiredNetworkPolicyKeys?: readonly string[];
  readonly removedNetworkPolicyKeys?: readonly string[];
  readonly removedCredentialBindingProviders?: readonly string[];
  readonly requiredNetworkPolicySources?: readonly string[];
  readonly authorizedCredentialBindingProviders?: readonly string[];
}): InitialSandboxPolicy {
  const liveSource = fs.readFileSync(input.livePolicyPath, "utf8");
  const replacementSource =
    input.replacementPolicy.sourceBytes?.toString("utf8") ??
    fs.readFileSync(input.replacementPolicy.policyPath, "utf8");
  const merged = mergeReplacementPolicyAccess(
    liveSource,
    replacementSource,
    input.requiredNetworkPolicyKeys,
    input.removedNetworkPolicyKeys,
    input.requiredNetworkPolicySources,
    input.removedCredentialBindingProviders,
    input.sandboxName,
  );
  if (!merged.changed) {
    const replacementCleanupRequired = Boolean(
      input.replacementPolicy.cleanup || input.replacementPolicy.cleanupExact,
    );
    const cleanupExact = createExactPolicyCleanup(
      replacementCleanupRequired ? [input.replacementPolicy.cleanupExact] : [],
    );
    return {
      ...input.replacementPolicy,
      policyPath: input.livePolicyPath,
      appliedPresets: [],
      credentialBindingProviders: authorizedCredentialBindingProviders(
        liveSource,
        input.replacementPolicy,
        input.authorizedCredentialBindingProviders ?? [],
      ),
      sourceBytes: Buffer.from(liveSource),
      cleanup: createIdentifiedPolicyCleanup(
        input.replacementPolicy.policyPath,
        input.replacementPolicy.cleanup,
      ),
      ...(cleanupExact ? { cleanupExact } : {}),
    };
  }

  const policyPath = secureTempFile(REBUILD_POLICY_HANDOFF_PREFIX, ".yaml");
  try {
    fs.writeFileSync(policyPath, merged.source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const cleanupHandoff = createExactTempFileCleanup(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    const replacementCleanupRequired = Boolean(
      input.replacementPolicy.cleanup || input.replacementPolicy.cleanupExact,
    );
    const cleanup = (): boolean =>
      cleanupRebuildPolicySources([
        { policyPath, cleanup: cleanupHandoff },
        ...(input.replacementPolicy.cleanup
          ? [
              {
                policyPath: input.replacementPolicy.policyPath,
                cleanup: input.replacementPolicy.cleanup,
              },
            ]
          : []),
      ]);
    const cleanupExact = createExactPolicyCleanup([
      cleanupHandoff,
      ...(replacementCleanupRequired ? [input.replacementPolicy.cleanupExact] : []),
    ]);
    return {
      ...input.replacementPolicy,
      policyPath,
      appliedPresets: [],
      credentialBindingProviders: authorizedCredentialBindingProviders(
        merged.source,
        input.replacementPolicy,
        input.authorizedCredentialBindingProviders ?? [],
      ),
      sourceBytes: Buffer.from(merged.source),
      cleanup,
      ...(cleanupExact ? { cleanupExact } : {}),
    };
  } catch (error) {
    cleanupTempDir(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    throw error;
  }
}
