// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Explicit extension: the Hermes image boundary loads this as native ESM.
import {
  getMessagingCredentialEnvKeysByChannel,
  listMessagingCredentialEnvAssignments,
} from "../channels/metadata.ts";

/** The single env target every channel renders into. */
export const HERMES_ENV_RENDER_TARGET = "~/.hermes/.env";

/** The parts of a messaging plan this cleanup reads, in either applier's shape. */
export type CredentialEnvCleanupPlan = {
  readonly agent: string;
  readonly credentialBindings: readonly {
    readonly channelId: string;
    readonly providerEnvKey?: unknown;
  }[];
};

// python-dotenv accepts `export KEY=` with any horizontal whitespace.
const EXPORT_PREFIX = /^export[ \t]+/;

/** Read the assignment key from `KEY=` or `export KEY=`. */
export function readEnvLineKey(line: string): string | null {
  const index = line.indexOf("=");
  if (index <= 0) return null;
  const key = line.slice(0, index).trim().replace(EXPORT_PREFIX, "").trim();
  return key.length > 0 ? key : null;
}

// Credential keys this plan owns:
// - Disabled channels included; stopping one is when the stale line is left.
// - The key must be declared by that channel's manifest, so a persisted
//   binding cannot authorize deleting an unrelated line.
export function ownedCredentialEnvKeys(plan: CredentialEnvCleanupPlan): ReadonlySet<string> {
  const declared = getMessagingCredentialEnvKeysByChannel();
  const owned = new Set<string>();
  for (const binding of plan.credentialBindings) {
    const envKey = typeof binding.providerEnvKey === "string" ? binding.providerEnvKey : "";
    const allowed = declared[binding.channelId] ?? [];
    if (envKey.length > 0 && allowed.includes(envKey)) owned.add(envKey);
  }
  return owned;
}

// Env line keys the current manifests still assign an owned credential to,
// mapped to that credential's provider env key.
function currentCredentialEnvAssignments(
  plan: CredentialEnvCleanupPlan,
): ReadonlyMap<string, string> {
  return new Map(
    listMessagingCredentialEnvAssignments()
      .filter((assignment) => assignment.agent === plan.agent)
      .map((assignment) => [assignment.targetEnvKey, assignment.sourceEnvKey]),
  );
}

// Credential lines the plan must not leave behind. Hermes loads the file with
// override=True, so either case shadows the injected value:
// - the manifests no longer assign the key, so a render still carrying it comes
//   from a plan encoded before that credential moved to a policy binding;
// - the manifests still assign it but this plan renders nothing for it.
// A persisted render is never taken as proof that a key is still wanted.
export function staleCredentialEnvKeys(
  plan: CredentialEnvCleanupPlan,
  rendered: ReadonlySet<string>,
): ReadonlySet<string> {
  const owned = ownedCredentialEnvKeys(plan);
  const assigned = currentCredentialEnvAssignments(plan);
  // Both key spaces: the provider env key, and the line key a manifest renders
  // it under when the two differ.
  const candidates = new Set<string>(owned);
  for (const [lineKey, providerEnvKey] of assigned) {
    if (owned.has(providerEnvKey)) candidates.add(lineKey);
  }
  const stale = new Set<string>();
  for (const key of candidates) {
    if (assigned.has(key) && rendered.has(key)) continue;
    stale.add(key);
  }
  return stale;
}

// A channel whose render collapses to nothing leaves the target unvisited, so
// the stale line survives. Visit it anyway when the plan owns credential keys.
export function migrationOnlyEnvTargets(
  plan: CredentialEnvCleanupPlan,
  renderedTargets: ReadonlySet<string>,
): readonly string[] {
  const owned =
    plan.agent === "hermes" &&
    !renderedTargets.has(HERMES_ENV_RENDER_TARGET) &&
    ownedCredentialEnvKeys(plan).size > 0;
  return owned ? [HERMES_ENV_RENDER_TARGET] : [];
}
