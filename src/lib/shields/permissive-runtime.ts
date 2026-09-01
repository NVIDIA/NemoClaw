// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";

import { diagnosticPreview } from "../sandbox-name-contract";

function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPolicyValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalPolicyValue(record[key])]),
  );
}

export function serializeCanonicalPolicy(policy: Record<string, unknown>): string {
  return YAML.stringify(canonicalPolicyValue(policy));
}

export function describeCanonicalPolicyReference(policy: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalPolicyValue(policy)), "utf8")
    .digest("hex");
  const networkPolicies = policy.network_policies;
  const policyKeys =
    networkPolicies && typeof networkPolicies === "object" && !Array.isArray(networkPolicies)
      ? Object.keys(networkPolicies).sort()
      : [];
  return `canonical JSON SHA-256 ${digest}; network policy keys: ${
    policyKeys.length > 0 ? policyKeys.map(diagnosticPreview).join(", ") : "(none)"
  }`;
}
import { materializeMessagingPolicySandboxName } from "../messaging/channels/policy";
import { cleanupTempDir, secureTempFile } from "../onboard/temp-files";

import { composeLiveNetworkPolicies } from "./mcp-policy-transition";

const TEMP_FILE_PREFIX = "nemoclaw-permissive-runtime";

/**
 * Build a permissive policy YAML whose filesystem path lists
 * (`filesystem_policy.read_only` + `filesystem_policy.read_write`) are a
 * superset of the live sandbox's, so OpenShell never has to remove a path
 * on a live transition.
 *
 * Only the two path lists are unioned. Other `filesystem_policy` fields
 * (e.g. `include_workdir`) are preserved verbatim from the static base —
 * the bug class this helper exists for is path removal on a live sandbox,
 * not policy shape changes.
 *
 * The live `landlock` stanza is carried through as well when the live policy
 * has one (#8461). OpenShell applies Landlock at startup and rejects any
 * later policy that changes it, so the emitted document must restate the
 * value the sandbox is already running rather than the static base's.
 *
 * Background (#3942, #3957, #3168): OpenShell refuses to remove a
 * `filesystem_policy.read_only` or `filesystem_policy.read_write` entry
 * on a live sandbox. The static `openclaw-sandbox-permissive.yaml`
 * baseline does not see runtime-injected paths — `/proc` on GPU
 * sandboxes, `/opt/hermes` on Hermes, `/home/linuxbrew` on post-#3913
 * OpenClaw, and any future agent- or feature-specific enrichment. Each
 * past mismatch shipped its own permissive-YAML patch. This helper
 * closes the loop by unioning whatever the live sandbox advertises into
 * the permissive YAML before it is applied, so future runtime injections
 * are absorbed automatically.
 *
 * Resolution rules when a path appears in both `read_only` and
 * `read_write`:
 * - Live `read_write` is the more permissive of the two and takes
 *   priority: if the live state writes a path, the permissive transition
 *   keeps it writable, removing it from `read_only` first so we never
 *   emit a path in both lists.
 * - Live `read_only` is merged into base `read_only` only when the same
 *   path is not already granted `read_write` (either by base or by live).
 *
 * Returns the path to a freshly created temp YAML file when the live
 * policy carries filesystem paths or a Landlock stanza that must be
 * preserved. Falls back to the static base path when the live policy has
 * neither, when the base YAML cannot be parsed, or when temp-file I/O
 * fails — degrading to the existing static apply path rather than
 * aborting shields-down with an I/O error.
 */
export interface PermissiveRuntimeDeps {
  // Pre-parsed live policy YAML body (e.g. parseCurrentPolicy(rawPolicy)
  // from the caller, which already strips the OpenShell header). Passed
  // in rather than fetched here so live-policy acquisition stays
  // outside this helper — the helper itself still does I/O (base read,
  // temp file write) but does not shell out to openshell.
  livePolicyYaml: string;
  // Lazy because callers may want to defer the read until the helper
  // actually needs it. The returned string is parsed by YAML.parse.
  readBasePolicy: () => string;
  // Injectable temp-file writer. Defaults to fs.writeFileSync via
  // secureTempFile when omitted. Exposed so tests can drive the
  // write-failure fallback path without monkey-patching node:fs.
  writeTempPolicy?: (yaml: string) => string;
  // Hermes permissive messaging routes carry sandbox-scoped credential
  // bindings. Supplying the target name makes composition fail closed unless
  // every retained placeholder can be materialized before the policy is staged.
  sandboxName?: string;
}

export function buildRuntimePermissivePolicy(
  basePermissivePath: string,
  deps: PermissiveRuntimeDeps,
): string {
  const live = deps.livePolicyYaml ? safeYamlObject(deps.livePolicyYaml) : null;
  const liveRw = readStringList(live, "read_write");
  const liveRo = readStringList(live, "read_only");
  const liveNetworkPolicies =
    live?.network_policies &&
    typeof live.network_policies === "object" &&
    !Array.isArray(live.network_policies)
      ? (live.network_policies as Record<string, unknown>)
      : {};
  const hasLiveNetworkPolicies = Object.keys(liveNetworkPolicies).length > 0;
  const discordProviderName = deps.sandboxName ? `${deps.sandboxName}-discord-bridge` : null;
  const slackProviderNames = deps.sandboxName
    ? [`${deps.sandboxName}-slack-app`, `${deps.sandboxName}-slack-bridge`]
    : [];
  const preserveDiscordBinding =
    discordProviderName !== null && policyUsesCredentialProvider(live, discordProviderName);
  const preserveSlackBinding =
    slackProviderNames.length > 0 &&
    networkPolicyUsesExactCredentialProviders(live, "slack", slackProviderNames);
  const preserveCredentialBinding = preserveDiscordBinding || preserveSlackBinding;

  // No live startup-sealed or filesystem state to carry forward — keep the
  // static path so the caller's apply path is unchanged unless live network
  // entries must survive the complete-policy replacement.
  if (
    liveRw.length === 0 &&
    liveRo.length === 0 &&
    live?.landlock === undefined &&
    !hasLiveNetworkPolicies &&
    deps.sandboxName === undefined
  ) {
    return basePermissivePath;
  }

  let baseYaml: string;
  try {
    baseYaml = deps.readBasePolicy();
  } catch (error) {
    if (hasLiveNetworkPolicies) {
      throw new Error(
        "Cannot read the Shields-down policy while live network policies are active",
        {
          cause: error,
        },
      );
    }
    if (deps.sandboxName !== undefined) {
      throw new Error("Cannot read the Shields-down policy with credential provider bindings", {
        cause: error,
      });
    }
    return basePermissivePath;
  }
  let base = safeYamlObject(baseYaml);
  if (!base) {
    if (hasLiveNetworkPolicies) {
      throw new Error(
        "Cannot parse the Shields-down policy while live network policies are active",
      );
    }
    if (deps.sandboxName !== undefined) {
      throw new Error("Cannot parse the Shields-down policy with credential provider bindings");
    }
    return basePermissivePath;
  }
  if (deps.sandboxName !== undefined) {
    const networkPolicies = base.network_policies;
    if (networkPolicies && typeof networkPolicies === "object" && !Array.isArray(networkPolicies)) {
      const policies = networkPolicies as Record<string, unknown>;
      if (!preserveDiscordBinding) delete policies.discord;
      if (!preserveSlackBinding) delete policies.slack;
    }
  }
  if (deps.sandboxName !== undefined && preserveCredentialBinding) {
    const materialized = materializeMessagingPolicySandboxName(
      YAML.stringify(base),
      deps.sandboxName,
    );
    if (materialized === null) {
      throw new Error("Cannot materialize the Shields-down credential provider binding");
    }
    base = safeYamlObject(materialized);
    if (!base) {
      throw new Error("Cannot parse the materialized Shields-down credential provider binding");
    }
  }
  const fsPolicy =
    base.filesystem_policy && typeof base.filesystem_policy === "object"
      ? (base.filesystem_policy as Record<string, unknown>)
      : ((base.filesystem_policy = {} as Record<string, unknown>),
        base.filesystem_policy as Record<string, unknown>);

  const baseRw = new Set(readStringList(base, "read_write"));
  const baseRo = new Set(readStringList(base, "read_only"));

  // RW wins: a live write-path must stay writable in the new policy,
  // and the same path cannot also live in read_only afterwards.
  for (const p of liveRw) {
    baseRo.delete(p);
    baseRw.add(p);
  }
  for (const p of liveRo) {
    if (!baseRw.has(p)) baseRo.add(p);
  }

  fsPolicy.read_write = [...baseRw];
  fsPolicy.read_only = [...baseRo];

  // OpenShell applies Landlock at sandbox startup and rejects a policy whose
  // stanza differs from the one the sandbox started with. An agent that ships
  // no permissive policy of its own falls back to the OpenClaw document. Its
  // `best_effort` then contradicts a baseline such as Deep Agents Code's
  // `strict`, and OpenShell refuses the policy (#8461). Carry the live stanza
  // through so the emitted document proposes no Landlock change. This can only
  // ever restate what the sandbox is already running.
  if (live?.landlock !== undefined) {
    base.landlock = live.landlock;
  }

  const yaml = live
    ? composeLiveNetworkPolicies(YAML.stringify(base), deps.livePolicyYaml)
    : YAML.stringify(base);
  if (deps.writeTempPolicy) {
    try {
      return deps.writeTempPolicy(yaml);
    } catch (error) {
      if (hasLiveNetworkPolicies) {
        throw new Error(
          "Cannot stage the Shields-down policy while live network policies are active",
          {
            cause: error,
          },
        );
      }
      if (deps.sandboxName !== undefined) {
        throw new Error("Cannot stage the Shields-down credential provider binding", {
          cause: error,
        });
      }
      return basePermissivePath;
    }
  }
  let tmpPath: string | null = null;
  try {
    tmpPath = secureTempFile(TEMP_FILE_PREFIX, ".yaml");
    fs.writeFileSync(tmpPath, yaml, { mode: 0o600 });
    return tmpPath;
  } catch (error) {
    // secureTempFile may have created an mkdtemp directory before
    // writeFileSync failed. Clean it up so we do not leak a 0700 dir
    // on /tmp every time the write path errors.
    if (tmpPath) cleanupTempDir(tmpPath, TEMP_FILE_PREFIX);
    if (hasLiveNetworkPolicies) {
      throw new Error(
        "Cannot stage the Shields-down policy while live network policies are active",
        {
          cause: error,
        },
      );
    }
    if (deps.sandboxName !== undefined) {
      throw new Error("Cannot stage the Shields-down credential provider binding", {
        cause: error,
      });
    }
    return basePermissivePath;
  }
}

export interface LiveNetworkRuntimePolicyDeps {
  livePolicyYaml: string;
  readBasePolicy: () => string;
  writeTempPolicy?: (yaml: string) => string;
}

/**
 * Preserve current live OpenShell policy entries in a custom Shields-down
 * policy. OpenShell's live document is the only source used for their keys and
 * content.
 */
export function buildRuntimePolicyWithLiveNetworkEntries(
  _basePolicyPath: string,
  deps: LiveNetworkRuntimePolicyDeps,
): string {
  let baseYaml: string;
  try {
    baseYaml = deps.readBasePolicy();
  } catch (error) {
    throw new Error("Cannot read the Shields policy while preserving live network entries", {
      cause: error,
    });
  }
  const yaml = composeLiveNetworkPolicies(baseYaml, deps.livePolicyYaml);
  if (deps.writeTempPolicy) {
    try {
      return deps.writeTempPolicy(yaml);
    } catch (error) {
      throw new Error("Cannot stage the Shields policy with live network entries", {
        cause: error,
      });
    }
  }

  let tmpPath: string | null = null;
  try {
    tmpPath = secureTempFile(TEMP_FILE_PREFIX, ".yaml");
    fs.writeFileSync(tmpPath, yaml, { mode: 0o600 });
    return tmpPath;
  } catch (error) {
    if (tmpPath) cleanupTempDir(tmpPath, TEMP_FILE_PREFIX);
    throw new Error("Cannot stage the Shields policy with live network entries", {
      cause: error,
    });
  }
}

function safeYamlObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function policyUsesCredentialProvider(
  policy: Record<string, unknown> | null,
  providerName: string,
): boolean {
  const networkPolicies = policy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return false;
  }
  for (const networkPolicy of Object.values(networkPolicies)) {
    if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) {
      continue;
    }
    const endpoints = (networkPolicy as Record<string, unknown>).endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
      const binding = (endpoint as Record<string, unknown>).credential_binding;
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      if ((binding as Record<string, unknown>).provider === providerName) return true;
    }
  }
  return false;
}

function networkPolicyUsesExactCredentialProviders(
  policy: Record<string, unknown> | null,
  policyName: string,
  providerNames: readonly string[],
): boolean {
  const networkPolicies = policy?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return false;
  }
  const networkPolicy = (networkPolicies as Record<string, unknown>)[policyName];
  if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) {
    return false;
  }
  const endpoints = (networkPolicy as Record<string, unknown>).endpoints;
  if (!Array.isArray(endpoints)) return false;
  const liveProviders = new Set<string>();
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
    const binding = (endpoint as Record<string, unknown>).credential_binding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
    const provider = (binding as Record<string, unknown>).provider;
    if (typeof provider === "string") liveProviders.add(provider);
  }
  return (
    liveProviders.size === providerNames.length &&
    providerNames.every((providerName) => liveProviders.has(providerName))
  );
}

function readStringList(
  root: Record<string, unknown> | null,
  key: "read_only" | "read_write",
): string[] {
  const fsPolicy = root?.filesystem_policy;
  if (!fsPolicy || typeof fsPolicy !== "object") return [];
  const value = (fsPolicy as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
