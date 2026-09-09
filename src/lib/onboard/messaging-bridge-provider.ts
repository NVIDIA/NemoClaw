// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Messaging-channel custom provider-profile wiring.
//
// A messaging channel that needs a custom OpenShell credential boundary or
// mints its outbound token gateway-side declares an OpenShell provider profile
// co-located with the channel at
//   src/lib/messaging/channels/<channel>/provider-profile/<agent>.yaml
// (the same per-channel convention as policy presets, <channel>/policy/<agent>.yaml).
//
// The profile YAML is the single source of truth for the provider type and
// injectable credential env var. A refresh block additionally marks a
// gateway-minted bridge credential. The messaging applier owns profile import,
// provider mutation, refresh configuration, and refresh observation.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import {
  exportedProviderProfileMatchesContract,
  parseCheckedInProviderProfileContract,
} from "../adapters/openshell/provider-profile";
import { createBuiltInChannelManifestRegistry } from "../messaging/channels";
import type {
  ChannelManifest,
  ChannelSecretInputSpec,
  MessagingAgentId,
} from "../messaging/manifest";
import { ROOT } from "../state/paths";

// Create-time credential sentinel: the real value is minted by
// `provider refresh configure`; this only has to be non-empty so the provider is
// created (the gateway overwrites it on the first mint).
export const MESSAGING_BRIDGE_PENDING_VALUE = "openshell-managed-pending-mint";

const CHANNELS_SUBPATH = ["src", "lib", "messaging", "channels"] as const;
const PROVIDER_PROFILE_FILE_BY_AGENT: Readonly<Record<MessagingAgentId, string>> = {
  openclaw: "openclaw.yaml",
  hermes: "hermes.yaml",
};

type RunOpenshell = (
  args: string[],
  // The runner accepts a wider options shape; we only set ignoreError + stdio
  // here, so erase the type at the boundary to keep this module free of the
  // runner.ts internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: any,
) => { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null };

/** Discovered bridge profile for one channel/agent, parsed from its profile YAML. */
export interface MessagingBridgeProfile {
  readonly channelId: string;
  readonly agent: MessagingAgentId;
  readonly profilePath: string;
  /** OpenShell profile id (`provider create --type <profileId>`). */
  readonly profileId: string;
  /** Injectable credential env var the gateway mints + the L7 proxy injects. */
  readonly credentialKey: string;
  /** Credential-refresh strategy, or null for a caller-supplied static credential. */
  readonly strategy: string | null;
  /** OAuth scope(s) declared in the profile's refresh block. */
  readonly scopes: readonly string[];
  /** Material names the profile marks `secret: true` (ingested through --secret-material-env). */
  readonly secretMaterialKeys: readonly string[];
  /** Env var holding the pasted secret material (the channel's primary required secret). */
  readonly sourceSecretEnv: string;
}

export type RefreshingMessagingBridgeProfile = MessagingBridgeProfile & {
  readonly strategy: string;
};

function hasRefreshStrategy(
  profile: MessagingBridgeProfile,
): profile is RefreshingMessagingBridgeProfile {
  return profile.strategy !== null;
}

export interface ListMessagingBridgeProfilesDeps {
  readonly root?: string;
  readonly manifests?: readonly ChannelManifest[];
  readonly existsSync?: (file: string) => boolean;
  readonly readFileSync?: (file: string) => string;
}

export interface MessagingBridgeSecretResolveDeps {
  readonly getCredential: (envKey: string) => string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly normalizeCredentialValue?: (value: unknown) => string;
}

export interface CollectMessagingBridgeTokenDefsInput extends MessagingBridgeSecretResolveDeps {
  readonly sandboxName: string;
  /**
   * Recorded sandbox agent, unnormalized. Bridge profiles are per-agent and a
   * channel may ship both (Google Chat does), so the profile filter selects the
   * matching one and rejects an agent no profile declares.
   */
  readonly agent: string | null | undefined;
  readonly enabledChannels: readonly string[] | null;
  readonly disabledChannelNames: ReadonlySet<string>;
  /** Injected for tests; defaults to convention discovery. */
  readonly profiles?: readonly MessagingBridgeProfile[];
}

export interface MatchRegisteredMessagingBridgeProfileDeps {
  readonly root: string;
  readonly runOpenshell: RunOpenshell;
  readonly profiles?: readonly MessagingBridgeProfile[];
  readonly readFileSync?: (file: string) => string;
}

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
}

function profileMatchesCheckedInBoundary(
  profile: MessagingBridgeProfile,
  exported: string,
  readFileSync: (file: string) => string,
): boolean {
  try {
    const expected = parseCheckedInProviderProfileContract(readFileSync(profile.profilePath));
    return (
      expected !== null &&
      expected.profileId === profile.profileId &&
      (profile.strategy !== null ||
        (expected.boundary.endpoints.length === 0 &&
          expected.boundary.binaries.length === 0 &&
          expected.boundary.inference_capable === false)) &&
      exportedProviderProfileMatchesContract(exported, expected)
    );
  } catch {
    return false;
  }
}

/** Compare a registered bridge profile with its checked-in credential boundary. */
export function matchesRegisteredMessagingBridgeProfile(
  providerType: string,
  deps: MatchRegisteredMessagingBridgeProfileDeps,
): boolean | null {
  const profile = (deps.profiles ?? listMessagingBridgeProfiles({ root: deps.root })).find(
    (candidate) => candidate.profileId === providerType,
  );
  if (!profile) return null;
  const exported = deps.runOpenshell(
    ["provider", "profile", "export", profile.profileId, "--output", "json"],
    {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  if (exported.status !== 0) return false;
  return profileMatchesCheckedInBoundary(
    profile,
    bufferOrStringToText(exported.stdout),
    deps.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf-8")),
  );
}

function isSafeChannelId(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);
}

/** Co-located provider-profile path, twin of channel policy's `<channel>/policy/<agent>.yaml`. */
export function channelProviderProfilePath(
  root: string,
  channelId: string,
  agent: MessagingAgentId,
): string | null {
  if (!isSafeChannelId(channelId)) return null;
  return path.join(
    root,
    ...CHANNELS_SUBPATH,
    channelId,
    "provider-profile",
    PROVIDER_PROFILE_FILE_BY_AGENT[agent],
  );
}

function primarySecretEnv(manifest: ChannelManifest): string | null {
  const input = manifest.inputs.find(
    (entry): entry is ChannelSecretInputSpec => entry.kind === "secret" && entry.required,
  );
  return input?.envKey ?? null;
}

function parseProfileYaml(
  content: string,
): Omit<MessagingBridgeProfile, "channelId" | "agent" | "profilePath" | "sourceSecretEnv"> | null {
  let doc: Record<string, unknown> | null;
  try {
    doc = YAML.parse(content) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  const profileId = doc?.id;
  if (typeof profileId !== "string" || !profileId) return null;
  const credentials = Array.isArray(doc?.credentials) ? doc?.credentials : null;
  const credential = credentials?.[0] as Record<string, unknown> | undefined;
  if (!credential) return null;
  const envVars = Array.isArray(credential.env_vars) ? credential.env_vars : [];
  const credentialKey = typeof envVars[0] === "string" ? envVars[0] : null;
  if (!credentialKey) return null;
  const refresh = credential.refresh as Record<string, unknown> | undefined;
  const strategy =
    typeof refresh?.strategy === "string" && refresh.strategy ? refresh.strategy : null;
  if (strategy === null && (!Array.isArray(doc?.endpoints) || doc.endpoints.length !== 0)) {
    return null;
  }
  const scopes = Array.isArray(refresh?.scopes)
    ? refresh.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const material = Array.isArray(refresh?.material) ? refresh.material : [];
  const secretMaterialKeys = material
    .filter(
      (m): m is { name: string; secret: true } =>
        !!m &&
        (m as { secret?: unknown }).secret === true &&
        typeof (m as { name?: unknown }).name === "string",
    )
    .map((m) => m.name);
  return { profileId, credentialKey, strategy, scopes, secretMaterialKeys };
}

/**
 * Discover the bridge provider profiles by convention: every channel manifest
 * whose co-located `provider-profile/<agent>.yaml` exists and parses. Injectable
 * for tests; defaults to the built-in registry + real filesystem.
 */
export function listMessagingBridgeProfiles(
  deps: ListMessagingBridgeProfilesDeps = {},
): MessagingBridgeProfile[] {
  const root = deps.root ?? ROOT;
  const existsSync = deps.existsSync ?? ((file: string) => fs.existsSync(file));
  const readFileSync = deps.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf-8"));
  const manifests = deps.manifests ?? createBuiltInChannelManifestRegistry().list();

  const profiles: MessagingBridgeProfile[] = [];
  for (const manifest of manifests) {
    const sourceSecretEnv = primarySecretEnv(manifest);
    if (!sourceSecretEnv) continue;
    for (const agent of manifest.supportedAgents) {
      const profilePath = channelProviderProfilePath(root, manifest.id, agent);
      if (!profilePath || !existsSync(profilePath)) continue;
      const parsed = parseProfileYaml(readFileSync(profilePath));
      if (!parsed) continue;
      profiles.push({ channelId: manifest.id, agent, profilePath, sourceSecretEnv, ...parsed });
    }
  }
  return profiles;
}

/**
 * Resolve the pasted secret material with the same order the rest of onboarding
 * uses: the credential store first, then the injected env map (mirrors the Brave
 * key resolution). Using `getCredential` alone misses non-interactive runs where
 * the value arrives through the passed-in env.
 */
export function resolveMessagingBridgeSecret(
  envKey: string,
  deps: MessagingBridgeSecretResolveDeps,
): string | null {
  const fromCredential = deps.getCredential(envKey);
  if (fromCredential) return fromCredential;
  if (deps.env && deps.normalizeCredentialValue) {
    const fromEnv = deps.normalizeCredentialValue(deps.env[envKey]);
    if (fromEnv) return fromEnv;
  }
  return null;
}

/** Static custom provider type for one channel in the selected agent, if declared. */
export function staticMessagingProviderTypeForChannel(
  channelId: string,
  agent: string | null | undefined,
  profiles: readonly MessagingBridgeProfile[] = listMessagingBridgeProfiles(),
): string | null {
  return (
    messagingBridgeProfilesForAgent(agent, profiles).find(
      (profile) => profile.channelId === channelId && profile.strategy === null,
    )?.profileId ?? null
  );
}

/** Gateway-minted bridge provider name for a channel (sandbox-scoped). */
function bridgeProviderNameFor(sandboxName: string, channelId: string): string {
  return `${sandboxName}-${channelId}-bridge`;
}

/**
 * Build the messaging token definitions for every enabled bridge channel whose
 * source secret was captured. Mirrors how the Brave provider is pushed in
 * messaging-prep: the value is a non-empty sentinel used only to create a
 * missing provider. An exact existing provider keeps its working credential
 * until refresh succeeds. The real material is built as ephemeral input for
 * the messaging applier.
 */
export function collectMessagingBridgeTokenDefs(
  input: CollectMessagingBridgeTokenDefsInput,
): { name: string; envKey: string; token: string; providerType: string }[] {
  const profiles = messagingBridgeProfilesForAgent(input.agent, input.profiles).filter(
    hasRefreshStrategy,
  );
  const defs: { name: string; envKey: string; token: string; providerType: string }[] = [];
  for (const profile of profiles) {
    if (input.disabledChannelNames.has(profile.channelId)) continue;
    if (input.enabledChannels != null && !input.enabledChannels.includes(profile.channelId))
      continue;
    const secret = resolveMessagingBridgeSecret(profile.sourceSecretEnv, input);
    if (!secret) continue;
    defs.push({
      name: bridgeProviderNameFor(input.sandboxName, profile.channelId),
      envKey: profile.credentialKey,
      token: MESSAGING_BRIDGE_PENDING_VALUE,
      providerType: profile.profileId,
    });
  }
  return defs;
}

/**
 * Single authority for which bridge profiles an agent may use. An unset agent is
 * OpenClaw, matching `toMessagingAgentId`; a recorded agent no profile declares
 * selects nothing, so it mints and reuses no bridge.
 */
export function messagingBridgeProfilesForAgent(
  agent: string | null | undefined,
  profiles: readonly MessagingBridgeProfile[] = listMessagingBridgeProfiles(),
): MessagingBridgeProfile[] {
  const name = agent?.trim().toLowerCase() || "openclaw";
  return profiles.filter((profile) => profile.agent === name);
}

/**
 * Gateway-minted bridge provider name(s) for a channel — the providers
 * `channels remove` must tear down. A bridge-backed channel has no
 * channelTokenKeys, so these would otherwise be left dangling (still minting and
 * rotating a token for a removed channel). `profiles` is injectable for tests;
 * defaults to convention discovery.
 */
export function bridgeProviderNamesForChannel(
  sandboxName: string,
  channelName: string,
  profiles: readonly MessagingBridgeProfile[] = listMessagingBridgeProfiles(),
): string[] {
  return [
    ...new Set(
      profiles
        .filter((profile) => profile.channelId === channelName && hasRefreshStrategy(profile))
        .map((profile) => bridgeProviderNameFor(sandboxName, profile.channelId)),
    ),
  ];
}

/**
 * Source-secret env var(s) a channel's bridge profile(s) require — for naming
 * the missing env var in enable-time error messages.
 */
export function bridgeSecretEnvsForChannel(
  channelName: string,
  profiles: readonly MessagingBridgeProfile[] = listMessagingBridgeProfiles(),
): string[] {
  return [
    ...new Set(
      profiles
        .filter((profile) => profile.channelId === channelName && hasRefreshStrategy(profile))
        .map((profile) => profile.sourceSecretEnv),
    ),
  ];
}

export function buildMessagingBridgeRefreshMaterial(
  profile: RefreshingMessagingBridgeProfile,
  secret: string,
):
  | { ok: true; material: { key: string; value: string }[]; secretKeys: string[] }
  | { ok: false; reason: string } {
  if (profile.strategy === "google_service_account_jwt") {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(secret) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "service account JSON could not be parsed" };
    }
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    if (
      typeof clientEmail !== "string" ||
      !clientEmail.trim() ||
      typeof privateKey !== "string" ||
      !privateKey.trim()
    ) {
      return { ok: false, reason: "service account JSON missing client_email/private_key" };
    }
    const material = [
      { key: "client_email", value: clientEmail },
      { key: "private_key", value: privateKey },
    ];
    // Join every declared scope space-separated so ONE minted token carries all
    // of them. Hermes Google Chat needs chat.bot AND pubsub in a single
    // credential; taking only scopes[0] made `:pull` fail with 403.
    if (profile.scopes.length > 0) {
      material.push({ key: "scope", value: profile.scopes.join(" ") });
    }
    // This strategy always emits private_key as material, so force it into the
    // secret set (delivered via --secret-material-env, never argv) regardless of
    // what the profile declares. A profile whose secretMaterialKeys omitted it
    // would otherwise leak the key into argv.
    const secretKeys = Array.from(new Set([...profile.secretMaterialKeys, "private_key"]));
    return { ok: true, material, secretKeys };
  }
  return { ok: false, reason: `unsupported refresh strategy '${profile.strategy}'` };
}
