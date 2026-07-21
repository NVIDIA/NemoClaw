// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generic messaging-channel "bridge provider" wiring.
//
// A messaging channel that mints its outbound token gateway-side (so the
// secret never enters the sandbox) declares an OpenShell provider profile
// co-located with the channel at
//   src/lib/messaging/channels/<channel>/provider-profile/<agent>.yaml
// (the same per-channel convention as policy presets, <channel>/policy/<agent>.yaml).
//
// The profile YAML is the single source of truth: it declares the provider `id`
// (used as `provider create --type <id>`), the injectable credential env var, and
// the credential-refresh strategy + material shape. This module discovers those
// profiles by convention and drives the two OpenShell steps that bracket provider
// creation — `provider profile import` (before) and `provider refresh configure`
// (after) — for ANY channel that has one, so no channel-specific logic lives in
// the generic provider-upsert path. Today only Google Chat uses this; a second
// minted-token channel needs only its own profile YAML.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { compactText } from "../core/url-utils";
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

type TokenDefShape = { name: string; providerType?: string; token: string | null };

/** Discovered bridge profile for one channel/agent, parsed from its profile YAML. */
export interface MessagingBridgeProfile {
  readonly channelId: string;
  readonly agent: MessagingAgentId;
  readonly profilePath: string;
  /** OpenShell profile id (`provider create --type <profileId>`). */
  readonly profileId: string;
  /** Injectable credential env var the gateway mints + the L7 proxy injects. */
  readonly credentialKey: string;
  /** Credential-refresh strategy (OpenShell kebab-case, e.g. google-service-account-jwt). */
  readonly strategy: string;
  /** OAuth scope(s) declared in the profile's refresh block. */
  readonly scopes: readonly string[];
  /** Material names the profile marks `secret: true` (ingested through --secret-material-env). */
  readonly secretMaterialKeys: readonly string[];
  /** Env var holding the pasted secret material (the channel's primary required secret). */
  readonly sourceSecretEnv: string;
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
  readonly enabledChannels: readonly string[] | null;
  readonly disabledChannelNames: ReadonlySet<string>;
  /** Injected for tests; defaults to convention discovery. */
  readonly profiles?: readonly MessagingBridgeProfile[];
}

export interface EnsureMessagingBridgeProfilesDeps {
  readonly root: string;
  readonly runOpenshell: RunOpenshell;
  readonly redact: (input: string) => string;
  readonly log?: (message?: string) => void;
  readonly exit?: (code?: number) => never;
  readonly profiles?: readonly MessagingBridgeProfile[];
}

export interface ConfigureMessagingBridgeRefreshesDeps extends MessagingBridgeSecretResolveDeps {
  readonly runOpenshell: RunOpenshell;
  readonly redact: (input: string) => string;
  readonly log?: (message?: string) => void;
  readonly profiles?: readonly MessagingBridgeProfile[];
}

// Result of gateway-refresh configuration. `ok:false` when a bridge token def is
// present but minting could not be configured, so the caller fails onboarding
// instead of leaving the channel able to receive but not reply.
export type MessagingBridgeRefreshResult = { ok: boolean; reason?: string };

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
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
  const refresh = credential.refresh as Record<string, unknown> | undefined;
  if (!credentialKey || !refresh) return null;
  const strategy = refresh.strategy;
  if (typeof strategy !== "string" || !strategy) return null;
  const scopes = Array.isArray(refresh.scopes)
    ? refresh.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const material = Array.isArray(refresh.material) ? refresh.material : [];
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
function resolveBridgeSecret(
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

function bridgeProfilesForTokenDefs(
  tokenDefs: readonly TokenDefShape[],
  profiles: readonly MessagingBridgeProfile[],
): MessagingBridgeProfile[] {
  const presentProfileIds = new Set(
    tokenDefs.filter(({ token }) => Boolean(token)).map(({ providerType }) => providerType),
  );
  return profiles.filter((profile) => presentProfileIds.has(profile.profileId));
}

/** Gateway-minted bridge provider name for a channel (sandbox-scoped). */
function bridgeProviderNameFor(sandboxName: string, channelId: string): string {
  return `${sandboxName}-${channelId}-bridge`;
}

/**
 * Build the messaging token definitions for every enabled bridge channel whose
 * source secret was captured. Mirrors how the Brave provider is pushed in
 * messaging-prep: the value is a non-empty sentinel (overwritten by the first
 * refresh) and the real material is supplied separately by
 * {@link configureMessagingBridgeRefreshes}.
 */
export function collectMessagingBridgeTokenDefs(
  input: CollectMessagingBridgeTokenDefsInput,
): { name: string; envKey: string; token: string; providerType: string }[] {
  const profiles = input.profiles ?? listMessagingBridgeProfiles();
  const defs: { name: string; envKey: string; token: string; providerType: string }[] = [];
  for (const profile of profiles) {
    if (input.disabledChannelNames.has(profile.channelId)) continue;
    if (input.enabledChannels != null && !input.enabledChannels.includes(profile.channelId))
      continue;
    const secret = resolveBridgeSecret(profile.sourceSecretEnv, input);
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
        .filter((profile) => profile.channelId === channelName)
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
        .filter((profile) => profile.channelId === channelName)
        .map((profile) => profile.sourceSecretEnv),
    ),
  ];
}

/**
 * Register each active bridge provider profile with OpenShell before providers
 * are created (they are created with `--type <profileId>`). Idempotent: tolerates
 * OpenShell reporting the custom profile already exists. Self-gates when no bridge
 * token def is present.
 */
export function ensureMessagingBridgeProfiles(
  tokenDefs: readonly TokenDefShape[],
  deps: EnsureMessagingBridgeProfilesDeps,
): void {
  const profiles = deps.profiles ?? listMessagingBridgeProfiles({ root: deps.root });
  const active = bridgeProfilesForTokenDefs(tokenDefs, profiles);
  if (active.length === 0) return;

  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));

  for (const profile of active) {
    const result = deps.runOpenshell(
      ["provider", "profile", "import", "--file", profile.profilePath],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) continue;

    const rawDiagnostic = `${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`;
    if (/already exists/i.test(rawDiagnostic)) continue;

    const diagnostic = compactText(deps.redact(rawDiagnostic));
    errorLog(
      `\n  ✗ Failed to register the ${profile.channelId} bridge provider profile with OpenShell.`,
    );
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
    exit(result.status || 1);
    return;
  }
}

function buildRefreshMaterial(
  profile: MessagingBridgeProfile,
  secret: string,
):
  | { ok: true; material: { key: string; value: string }[]; secretKeys: string[] }
  | { ok: false; reason: string } {
  if (profile.strategy === "google-service-account-jwt") {
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
      !clientEmail ||
      typeof privateKey !== "string" ||
      !privateKey
    ) {
      return { ok: false, reason: "service account JSON missing client_email/private_key" };
    }
    const material = [
      { key: "client_email", value: clientEmail },
      { key: "private_key", value: privateKey },
    ];
    // Scope comes from the profile's declared refresh scopes (single source of truth).
    if (profile.scopes[0]) material.push({ key: "scope", value: profile.scopes[0] });
    const secretKeys =
      profile.secretMaterialKeys.length > 0 ? [...profile.secretMaterialKeys] : ["private_key"];
    return { ok: true, material, secretKeys };
  }
  return { ok: false, reason: `unsupported refresh strategy '${profile.strategy}'` };
}

/**
 * Configure gateway-side credential refresh for every active bridge provider:
 * the gateway mints (and rotates) the token from the pasted secret material. Must
 * run AFTER the providers are created. Fail-closed: when a bridge token def is
 * present but minting cannot be configured, returns { ok:false } so the caller
 * aborts rather than leaving the channel able to receive but not reply. The secret
 * material is never logged.
 */
export function configureMessagingBridgeRefreshes(
  tokenDefs: readonly TokenDefShape[],
  deps: ConfigureMessagingBridgeRefreshesDeps,
): MessagingBridgeRefreshResult {
  const profiles = deps.profiles ?? listMessagingBridgeProfiles();
  const active = bridgeProfilesForTokenDefs(tokenDefs, profiles);
  if (active.length === 0) return { ok: true };

  const warn = deps.log ?? console.error;
  for (const profile of active) {
    const bridge = tokenDefs.find(
      ({ providerType, token }) => providerType === profile.profileId && Boolean(token),
    );
    if (!bridge) continue;

    const secret = resolveBridgeSecret(profile.sourceSecretEnv, deps);
    if (!secret) {
      warn(
        `\n  ✗ ${profile.channelId} bridge: secret material unavailable; cannot configure gateway token minting.`,
      );
      return { ok: false, reason: "secret material unavailable" };
    }

    const built = buildRefreshMaterial(profile, secret);
    if (!built.ok) {
      warn(
        `\n  ✗ ${profile.channelId} bridge: ${built.reason}; cannot configure gateway token minting.`,
      );
      return { ok: false, reason: built.reason };
    }

    // OpenShell reads secret refresh material from its own process environment,
    // so private keys never appear in argv. Reuse the same ephemeral variable
    // names safely: each profile is configured by a separate child process.
    const secretKeys = new Set(built.secretKeys);
    const materialArgs: string[] = [];
    const secretMaterialEnv: NodeJS.ProcessEnv = {};
    let secretIndex = 0;
    for (const { key, value } of built.material) {
      if (secretKeys.has(key)) {
        const envName = `MESSAGING_BRIDGE_SECRET_${secretIndex}`;
        secretIndex += 1;
        secretMaterialEnv[envName] = value;
        materialArgs.push("--secret-material-env", `${key}=${envName}`);
        continue;
      }
      materialArgs.push("--material", `${key}=${value}`);
    }
    const result = deps.runOpenshell(
      [
        "provider",
        "refresh",
        "configure",
        "--credential-key",
        profile.credentialKey,
        "--strategy",
        profile.strategy,
        ...materialArgs,
        bridge.name,
      ],
      {
        env: secretMaterialEnv,
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status === 0) continue;

    // Redact before logging — never echo secret material.
    const diagnostic = compactText(
      deps.redact(`${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`),
    );
    warn(
      `\n  ✗ ${profile.channelId} bridge: failed to configure gateway token minting for '${bridge.name}'.`,
    );
    if (diagnostic) warn(`    ${diagnostic.slice(0, 500)}`);
    warn("    Outbound replies for this channel will not authenticate until this is resolved.");
    return {
      ok: false,
      reason: diagnostic || `provider refresh configure exited with status ${result.status}`,
    };
  }
  return { ok: true };
}
