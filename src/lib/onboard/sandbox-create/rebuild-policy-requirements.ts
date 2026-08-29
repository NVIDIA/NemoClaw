// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";

import { parseOpenShellPolicy } from "../../policy/merge";
import type { InitialSandboxPolicy } from "../initial-policy";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "../temp-files";

const REBUILD_CREATE_POLICY_PREFIX = "nemoclaw-rebuild-create-policy";

function isPolicyMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePolicyValue<T>(value: T): T {
  return structuredClone(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Cannot prepare rebuild policy: ${label} must be a string array.`);
  }
  return [...value];
}

function unionStrings(existing: string[], required: string[]): string[] {
  return [...existing, ...required.filter((entry) => !existing.includes(entry))];
}

/**
 * Preserve the complete live OpenShell base policy while adding only current
 * replacement-image requirements that are absent from an older sandbox.
 */
export function mergeRebuildPolicyRequirements(
  livePolicySource: string,
  currentPolicySource: string,
): string {
  const live = clonePolicyValue(parseOpenShellPolicy(livePolicySource).policy) as Record<
    string,
    unknown
  >;
  const current = parseOpenShellPolicy(currentPolicySource).policy as Record<string, unknown>;

  const liveFilesystem = live.filesystem_policy;
  const currentFilesystem = current.filesystem_policy;
  if (currentFilesystem !== undefined) {
    if (!isPolicyMapping(currentFilesystem)) {
      throw new Error(
        "Cannot prepare rebuild policy: current filesystem_policy must be a mapping.",
      );
    }
    if (liveFilesystem !== undefined && !isPolicyMapping(liveFilesystem)) {
      throw new Error("Cannot prepare rebuild policy: live filesystem_policy must be a mapping.");
    }
    const mergedFilesystem = clonePolicyValue(
      isPolicyMapping(liveFilesystem) ? liveFilesystem : {},
    );
    for (const field of ["read_only", "read_write"] as const) {
      const required = currentFilesystem[field];
      if (required === undefined) continue;
      const existing = mergedFilesystem[field];
      mergedFilesystem[field] = unionStrings(
        existing === undefined ? [] : stringArray(existing, `live filesystem_policy.${field}`),
        stringArray(required, `current filesystem_policy.${field}`),
      );
    }
    for (const [key, value] of Object.entries(currentFilesystem)) {
      if (!Object.hasOwn(mergedFilesystem, key)) mergedFilesystem[key] = clonePolicyValue(value);
    }
    live.filesystem_policy = mergedFilesystem;
  }

  const currentNetwork = current.network_policies;
  if (currentNetwork !== undefined) {
    if (!isPolicyMapping(currentNetwork)) {
      throw new Error("Cannot prepare rebuild policy: current network_policies must be a mapping.");
    }
    const liveNetwork = live.network_policies;
    if (liveNetwork !== undefined && !isPolicyMapping(liveNetwork)) {
      throw new Error("Cannot prepare rebuild policy: live network_policies must be a mapping.");
    }
    const mergedNetwork = clonePolicyValue(isPolicyMapping(liveNetwork) ? liveNetwork : {});
    for (const [key, value] of Object.entries(currentNetwork)) {
      if (!Object.hasOwn(mergedNetwork, key)) mergedNetwork[key] = clonePolicyValue(value);
    }
    live.network_policies = mergedNetwork;
  }

  for (const [key, value] of Object.entries(current)) {
    if (
      key !== "version" &&
      key !== "filesystem_policy" &&
      key !== "network_policies" &&
      !Object.hasOwn(live, key)
    ) {
      live[key] = clonePolicyValue(value);
    }
  }
  return YAML.stringify(live);
}

export function materializeRebuildCreatePolicy(input: {
  readonly livePolicyPath: string;
  readonly currentPolicy: InitialSandboxPolicy;
}): InitialSandboxPolicy {
  const policyPath = secureTempFile(REBUILD_CREATE_POLICY_PREFIX, ".yaml");
  try {
    const source = mergeRebuildPolicyRequirements(
      fs.readFileSync(input.livePolicyPath, "utf8"),
      input.currentPolicy.sourceBytes?.toString("utf8") ??
        fs.readFileSync(input.currentPolicy.policyPath, "utf8"),
    );
    fs.writeFileSync(policyPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const cleanup = createExactTempFileCleanup(policyPath, REBUILD_CREATE_POLICY_PREFIX);
    return {
      ...input.currentPolicy,
      policyPath,
      sourceBytes: Buffer.from(source),
      cleanup,
      cleanupExact: cleanup,
    };
  } catch (error) {
    cleanupTempDir(policyPath, REBUILD_CREATE_POLICY_PREFIX);
    throw error;
  }
}
