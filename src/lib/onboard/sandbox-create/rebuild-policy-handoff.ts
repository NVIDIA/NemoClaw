// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";

import { parseOpenShellPolicy } from "../../policy/merge";
import { getCredentialBindingProviders, type InitialSandboxPolicy } from "../initial-policy";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "../temp-files";

const REBUILD_POLICY_HANDOFF_PREFIX = "nemoclaw-rebuild-policy-handoff";

type PolicyMapping = Record<string, unknown>;

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

function mergeRequiredReplacementNetworkPolicies(
  live: PolicyMapping,
  replacement: PolicyMapping,
  requiredKeys: readonly string[],
): boolean {
  if (requiredKeys.length === 0) return false;

  const replacementPolicies = policyMapping(
    replacement.network_policies,
    "replacement network_policies",
  );
  const livePolicies =
    live.network_policies === undefined
      ? {}
      : structuredClone(policyMapping(live.network_policies, "live network_policies"));
  let changed = false;

  for (const key of new Set(requiredKeys)) {
    if (Object.hasOwn(livePolicies, key)) continue;
    if (!Object.hasOwn(replacementPolicies, key)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: required network policy '${key}' is absent from the replacement policy.`,
      );
    }
    livePolicies[key] = structuredClone(replacementPolicies[key]);
    changed = true;
  }

  if (changed) live.network_policies = livePolicies;
  return changed;
}

/**
 * Build one replacement-create input from OpenShell's live policy. Host edits
 * win completely outside filesystem access and network keys required by an
 * explicit active messaging command. Those bounded requirements are added
 * only to the one replacement create input; they are never persisted as a
 * NemoClaw-owned policy shadow.
 */
export function mergeReplacementPolicyAccess(
  livePolicySource: string,
  replacementPolicySource: string,
  requiredNetworkPolicyKeys: readonly string[] = [],
): { readonly changed: boolean; readonly source: string } {
  const live = structuredClone(parseOpenShellPolicy(livePolicySource).policy) as PolicyMapping;
  const replacement = parseOpenShellPolicy(replacementPolicySource).policy as PolicyMapping;
  const filesystemChanged = mergeReplacementFilesystemAccess(live, replacement);
  const networkChanged = mergeRequiredReplacementNetworkPolicies(
    live,
    replacement,
    requiredNetworkPolicyKeys,
  );
  const changed = filesystemChanged || networkChanged;
  return changed
    ? { changed: true, source: YAML.stringify(live) }
    : { changed: false, source: livePolicySource };
}

/** Materialize the single ephemeral policy input consumed by an explicit rebuild. */
export function materializeRebuildPolicyHandoff(input: {
  readonly livePolicyPath: string;
  readonly replacementPolicy: InitialSandboxPolicy;
  readonly requiredNetworkPolicyKeys?: readonly string[];
}): InitialSandboxPolicy {
  const liveSource = fs.readFileSync(input.livePolicyPath, "utf8");
  const replacementSource =
    input.replacementPolicy.sourceBytes?.toString("utf8") ??
    fs.readFileSync(input.replacementPolicy.policyPath, "utf8");
  const merged = mergeReplacementPolicyAccess(
    liveSource,
    replacementSource,
    input.requiredNetworkPolicyKeys,
  );
  if (!merged.changed) {
    return {
      ...input.replacementPolicy,
      policyPath: input.livePolicyPath,
      appliedPresets: [],
      credentialBindingProviders: getCredentialBindingProviders(liveSource),
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
      credentialBindingProviders: getCredentialBindingProviders(merged.source),
      sourceBytes: Buffer.from(merged.source),
      cleanup,
      cleanupExact: cleanup,
    };
  } catch (error) {
    cleanupTempDir(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    throw error;
  }
}
