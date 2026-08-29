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

function networkPolicyIdentity(key: string, value: unknown): string {
  if (!isPolicyMapping(value)) return key;
  const name = value.name;
  return typeof name === "string" && name.trim().length > 0 ? name : key;
}

function mergeReplacementNetworkPolicies(live: PolicyMapping, replacement: PolicyMapping): boolean {
  const replacementNetworkValue = replacement.network_policies;
  if (replacementNetworkValue === undefined) return false;
  const replacementNetwork = policyMapping(replacementNetworkValue, "replacement network_policies");
  const liveNetworkValue = live.network_policies;
  const liveNetwork =
    liveNetworkValue === undefined
      ? {}
      : structuredClone(policyMapping(liveNetworkValue, "live network_policies"));
  const liveIdentities = new Set(
    Object.entries(liveNetwork).flatMap(([key, value]) => [key, networkPolicyIdentity(key, value)]),
  );
  let changed = false;
  for (const [key, value] of Object.entries(replacementNetwork)) {
    const identity = networkPolicyIdentity(key, value);
    if (liveIdentities.has(key) || liveIdentities.has(identity)) continue;
    liveNetwork[key] = structuredClone(value);
    liveIdentities.add(key);
    liveIdentities.add(identity);
    changed = true;
  }
  if (changed) live.network_policies = liveNetwork;
  return changed;
}

function mergeReplacementTopLevelDefaults(
  live: PolicyMapping,
  replacement: PolicyMapping,
): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(replacement)) {
    if (
      key === "version" ||
      key === "filesystem_policy" ||
      key === "network_policies" ||
      Object.hasOwn(live, key)
    ) {
      continue;
    }
    live[key] = structuredClone(value);
    changed = true;
  }
  return changed;
}

/**
 * Build one replacement-create input from OpenShell's live policy. Host edits
 * and same-name entries win; only missing current-image access is added.
 */
export function mergeReplacementPolicyAccess(
  livePolicySource: string,
  replacementPolicySource: string,
): { readonly changed: boolean; readonly source: string } {
  const live = structuredClone(parseOpenShellPolicy(livePolicySource).policy) as PolicyMapping;
  const replacement = parseOpenShellPolicy(replacementPolicySource).policy as PolicyMapping;
  const filesystemChanged = mergeReplacementFilesystemAccess(live, replacement);
  const networkChanged = mergeReplacementNetworkPolicies(live, replacement);
  const topLevelChanged = mergeReplacementTopLevelDefaults(live, replacement);
  const changed = filesystemChanged || networkChanged || topLevelChanged;
  return changed
    ? { changed: true, source: YAML.stringify(live) }
    : { changed: false, source: livePolicySource };
}

/** Materialize the single ephemeral policy input consumed by an explicit rebuild. */
export function materializeRebuildPolicyHandoff(input: {
  readonly livePolicyPath: string;
  readonly replacementPolicy: InitialSandboxPolicy;
}): InitialSandboxPolicy {
  const liveSource = fs.readFileSync(input.livePolicyPath, "utf8");
  const replacementSource =
    input.replacementPolicy.sourceBytes?.toString("utf8") ??
    fs.readFileSync(input.replacementPolicy.policyPath, "utf8");
  const merged = mergeReplacementPolicyAccess(liveSource, replacementSource);
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
