// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";

import { cleanupTempDir, secureTempFile } from "../onboard/temp-files";

const TEMP_FILE_PREFIX = "nemoclaw-permissive-runtime";

/**
 * Build a permissive policy YAML whose filesystem path lists
 * (`filesystem_policy.read_only` + `filesystem_policy.read_write`) and
 * `network_policies` keys are a superset of the live sandbox's, so a live
 * transition never has to remove a path or drop a registered route.
 *
 * Only those three collections are unioned. Other `filesystem_policy`
 * fields (e.g. `include_workdir`) are preserved verbatim from the static
 * base — the bug class this helper exists for is losing live entries on a
 * live sandbox, not policy shape changes.
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
 * `network_policies` merges by key: a live-only route is copied in, and a
 * route the base already declares keeps the base's definition. Provider-
 * composed `_provider_*` entries are never copied.
 *
 * Returns the path to a freshly created temp YAML file when the live
 * policy carries filesystem lists or network routes that need merging.
 * Falls back to the static base path when the live policy is empty / has
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
}

export function buildRuntimePermissivePolicy(
  basePermissivePath: string,
  deps: PermissiveRuntimeDeps,
): string {
  const live = deps.livePolicyYaml ? safeYamlObject(deps.livePolicyYaml) : null;
  const liveRw = readStringList(live, "read_write");
  const liveRo = readStringList(live, "read_only");
  const liveNetwork = readNetworkPolicies(live);
  const liveNetworkNames = Object.keys(liveNetwork);

  // Nothing live to merge — keep the static path so the caller's apply
  // path is unchanged.
  if (liveRw.length === 0 && liveRo.length === 0 && liveNetworkNames.length === 0) {
    return basePermissivePath;
  }

  let baseYaml: string;
  try {
    baseYaml = deps.readBasePolicy();
  } catch {
    return basePermissivePath;
  }
  const base = safeYamlObject(baseYaml);
  if (!base) {
    return basePermissivePath;
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

  // Carry live-only network routes across the swap. The static baseline is
  // a fixed allowlist, so a route registered at runtime — a generated MCP
  // bridge entry, a sandbox-scoped custom preset — is absent from it and
  // would be dropped by the whole-document replacement, leaving the
  // registry owning a route the gateway no longer serves (#7952).
  //
  // The static base wins on a shared key: it is the more permissive of the
  // two by construction, so the applied document is unchanged for every
  // key the baseline already declares.
  if (liveNetworkNames.length > 0) {
    const baseNetwork =
      base.network_policies &&
      typeof base.network_policies === "object" &&
      !Array.isArray(base.network_policies)
        ? (base.network_policies as Record<string, unknown>)
        : ((base.network_policies = {} as Record<string, unknown>),
          base.network_policies as Record<string, unknown>);
    for (const name of liveNetworkNames) {
      if (!(name in baseNetwork)) baseNetwork[name] = liveNetwork[name];
    }
  }

  const yaml = YAML.stringify(base);
  if (deps.writeTempPolicy) {
    try {
      return deps.writeTempPolicy(yaml);
    } catch {
      return basePermissivePath;
    }
  }
  let tmpPath: string | null = null;
  try {
    tmpPath = secureTempFile(TEMP_FILE_PREFIX, ".yaml");
    fs.writeFileSync(tmpPath, yaml, { mode: 0o600 });
    return tmpPath;
  } catch {
    // secureTempFile may have created an mkdtemp directory before
    // writeFileSync failed. Clean it up so we do not leak a 0700 dir
    // on /tmp every time the write path errors.
    if (tmpPath) cleanupTempDir(tmpPath, TEMP_FILE_PREFIX);
    return basePermissivePath;
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

// `policy get --base` can defensively include provider-composed
// `_provider_*` entries that `policy set` must never receive. Every other
// read-modify-write path filters them (see withoutProviderComposedPolicies
// in nemoclaw/src/shared/openshell-policy-boundary.cts); this one is a
// write path too, so it filters them as well. Inlined rather than imported
// because that module is only reachable through a built artifact, and this
// helper must stay dependency-free.
const PROVIDER_COMPOSED_PREFIX = "_provider_";

function readNetworkPolicies(root: Record<string, unknown> | null): Record<string, unknown> {
  const value = root?.network_policies;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([name]) => !name.startsWith(PROVIDER_COMPOSED_PREFIX),
    ),
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
