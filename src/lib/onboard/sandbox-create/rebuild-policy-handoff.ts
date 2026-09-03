// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import { parseOpenShellPolicy } from "../../policy/merge";
import { getCredentialBindingProviders, type InitialSandboxPolicy } from "../initial-policy";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "../temp-files";

const REBUILD_POLICY_HANDOFF_PREFIX = "nemoclaw-rebuild-policy-handoff";

type PolicyMapping = Record<string, unknown>;

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
        const existing = replacementPolicies[key];
        if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
          throw new Error(
            `Cannot prepare rebuild policy handoff: required network policy '${key}' has conflicting replacement sources.`,
          );
        }
        replacementPolicies[key] = structuredClone(value);
      }
    }
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

/**
 * Build one replacement-create input from OpenShell's live policy. Host edits
 * win completely outside missing non-root process identity, filesystem access,
 * and network keys required by an explicit active messaging command. A live
 * collision on an enabled channel key must already match the selected channel
 * policy or rebuild stops before deletion. Those bounded image/command
 * requirements are added only to the replacement create input; they are never
 * persisted as a NemoClaw-owned policy shadow.
 */
export function mergeReplacementPolicyAccess(
  livePolicySource: string,
  replacementPolicySource: string,
  requiredNetworkPolicyKeys: readonly string[] = [],
  removedNetworkPolicyKeys: readonly string[] = [],
  requiredNetworkPolicySources: readonly string[] = [],
): { readonly changed: boolean; readonly source: string } {
  const live = structuredClone(parseOpenShellPolicy(livePolicySource).policy) as PolicyMapping;
  const replacement = parseOpenShellPolicy(replacementPolicySource).policy as PolicyMapping;
  const processChanged = mergeMissingReplacementProcessIdentity(live, replacement);
  const filesystemChanged = mergeReplacementFilesystemAccess(live, replacement);
  const networkChanged = mergeRequestedReplacementNetworkPolicies(
    live,
    replacement,
    requiredNetworkPolicyKeys,
    removedNetworkPolicyKeys,
    requiredNetworkPolicySources,
  );
  const changed = processChanged || filesystemChanged || networkChanged;
  return changed
    ? { changed: true, source: YAML.stringify(live) }
    : { changed: false, source: livePolicySource };
}

/** Materialize the single ephemeral policy input consumed by an explicit rebuild. */
export function materializeRebuildPolicyHandoff(input: {
  readonly livePolicyPath: string;
  readonly replacementPolicy: InitialSandboxPolicy;
  readonly requiredNetworkPolicyKeys?: readonly string[];
  readonly removedNetworkPolicyKeys?: readonly string[];
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
  );
  if (!merged.changed) {
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
    const cleanup = (): boolean => {
      const handoffRemoved = cleanupHandoff();
      const replacementRemoved = input.replacementPolicy.cleanup?.() ?? true;
      return handoffRemoved && replacementRemoved;
    };
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
      cleanupExact: cleanup,
    };
  } catch (error) {
    cleanupTempDir(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    throw error;
  }
}
