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
// gateway-minted bridge credential. This module imports every active custom
// profile before provider creation and configures refresh only for profiles that
// declare it.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  /** Credential-refresh strategy, or null for a caller-supplied static credential. */
  readonly strategy: string | null;
  /** OAuth scope(s) declared in the profile's refresh block. */
  readonly scopes: readonly string[];
  /** Material names the profile marks `secret: true` (ingested through --secret-material-env). */
  readonly secretMaterialKeys: readonly string[];
  /** Env var holding the pasted secret material (the channel's primary required secret). */
  readonly sourceSecretEnv: string;
}

type RefreshingMessagingBridgeProfile = MessagingBridgeProfile & { readonly strategy: string };

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

export interface EnsureMessagingBridgeProfilesDeps {
  readonly root: string;
  readonly runOpenshell: RunOpenshell;
  readonly redact: (input: string) => string;
  readonly log?: (message?: string) => void;
  readonly exit?: (code?: number) => never;
  readonly profiles?: readonly MessagingBridgeProfile[];
  readonly readFileSync?: (file: string) => string;
}

export interface MatchRegisteredStaticMessagingProfileDeps {
  readonly root: string;
  readonly runOpenshell: RunOpenshell;
  readonly profiles?: readonly MessagingBridgeProfile[];
  readonly readFileSync?: (file: string) => string;
}

export interface ConfigureMessagingBridgeRefreshesDeps extends MessagingBridgeSecretResolveDeps {
  readonly runOpenshell: RunOpenshell;
  readonly redact: (input: string) => string;
  readonly log?: (message?: string) => void;
  readonly profiles?: readonly MessagingBridgeProfile[];
  /** Injected for tests; defaults to a synchronous wait. */
  readonly sleep?: (milliseconds: number) => void;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
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

function credentialBoundary(doc: Record<string, unknown>): Record<string, unknown> | null {
  if (
    typeof doc.id !== "string" ||
    !Array.isArray(doc.credentials) ||
    !Array.isArray(doc.endpoints) ||
    !Array.isArray(doc.binaries) ||
    typeof doc.inference_capable !== "boolean"
  ) {
    return null;
  }
  const credentials = doc.credentials.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const credential = entry as Record<string, unknown>;
    return {
      name: credential.name,
      env_vars: credential.env_vars,
      required: credential.required,
      auth_style: credential.auth_style,
      header_name: credential.header_name,
      query_param: credential.query_param,
      refresh: credential.refresh ?? null,
    };
  });
  if (credentials.some((entry) => entry === null)) return null;
  return {
    id: doc.id,
    credentials,
    endpoints: doc.endpoints,
    binaries: doc.binaries,
    inference_capable: doc.inference_capable,
  };
}

function staticProfileMatchesCheckedInBoundary(
  profile: MessagingBridgeProfile,
  exported: string,
  readFileSync: (file: string) => string,
): boolean {
  try {
    const actual = JSON.parse(exported) as Record<string, unknown>;
    const expected = YAML.parse(readFileSync(profile.profilePath)) as Record<string, unknown>;
    const actualBoundary = credentialBoundary(actual);
    const expectedBoundary = credentialBoundary(expected);
    return (
      actualBoundary !== null &&
      expectedBoundary !== null &&
      expectedBoundary.id === profile.profileId &&
      Array.isArray(expectedBoundary.endpoints) &&
      expectedBoundary.endpoints.length === 0 &&
      Array.isArray(expectedBoundary.binaries) &&
      expectedBoundary.binaries.length === 0 &&
      expectedBoundary.inference_capable === false &&
      isDeepStrictEqual(actualBoundary, expectedBoundary)
    );
  } catch {
    return false;
  }
}

/** Compare a registered static profile with its checked-in credential boundary. */
export function matchesRegisteredStaticMessagingProfile(
  providerType: string,
  deps: MatchRegisteredStaticMessagingProfileDeps,
): boolean | null {
  const profile = (deps.profiles ?? listMessagingBridgeProfiles({ root: deps.root })).find(
    (candidate) => candidate.profileId === providerType && candidate.strategy === null,
  );
  if (!profile) return null;
  const exported = deps.runOpenshell(
    ["provider", "profile", "export", profile.profileId, "--output", "json"],
    { ignoreError: true, suppressOutput: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (exported.status !== 0) return false;
  return staticProfileMatchesCheckedInBoundary(
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
 * messaging-prep: the value is a non-empty sentinel (overwritten by the first
 * refresh) and the real material is supplied separately by
 * {@link configureMessagingBridgeRefreshes}.
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
  const readFileSync = deps.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf-8"));

  const rejectMismatchedStaticProfile = (profile: MessagingBridgeProfile): void => {
    errorLog(
      `\n  ✗ OpenShell provider profile '${profile.profileId}' does not match NemoClaw's endpointless ${profile.channelId} credential contract.`,
    );
    errorLog("    Remove the conflicting profile and re-run onboarding.");
    exit(1);
  };

  for (const profile of active) {
    // Onboard registers each bridge provider twice: once up front so an
    // interrupted run can resume, then again during create-plan materialization.
    // Probe first and skip the re-import so the second pass never hits OpenShell's
    // "already exists" error. A fresh gateway answers the probe with a harmless
    // "not found" that suppressOutput hides — only the exit status says whether
    // the profile already exists.
    const alreadyRegistered = deps.runOpenshell(
      ["provider", "profile", "export", profile.profileId, "--output", "json"],
      { ignoreError: true, suppressOutput: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (alreadyRegistered.status === 0) {
      if (
        profile.strategy === null &&
        !staticProfileMatchesCheckedInBoundary(
          profile,
          bufferOrStringToText(alreadyRegistered.stdout),
          readFileSync,
        )
      ) {
        rejectMismatchedStaticProfile(profile);
        return;
      }
      continue;
    }
    // Probe failed for something other than "not found" (gateway down, auth, …):
    // surface it instead of masking a real problem.
    const probeDiagnostic = `${bufferOrStringToText(alreadyRegistered.stderr)} ${bufferOrStringToText(
      alreadyRegistered.stdout,
    )}`;
    if (probeDiagnostic.trim() && !/not found/i.test(probeDiagnostic)) {
      errorLog(`\n  ⚠ Unexpected error probing the ${profile.channelId} provider profile:`);
      const probeText = compactText(deps.redact(probeDiagnostic));
      if (probeText) errorLog(`    ${probeText.slice(0, 500)}`);
    }

    const result = deps.runOpenshell(
      ["provider", "profile", "import", "--file", profile.profilePath],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) continue;

    // Reconcile a lost race: the probe saw no profile but a concurrent import made it.
    const rawDiagnostic = `${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`;
    if (/already exists/i.test(rawDiagnostic)) {
      if (profile.strategy !== null) continue;
      const racedProfile = deps.runOpenshell(
        ["provider", "profile", "export", profile.profileId, "--output", "json"],
        { ignoreError: true, suppressOutput: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (
        racedProfile.status !== 0 ||
        !staticProfileMatchesCheckedInBoundary(
          profile,
          bufferOrStringToText(racedProfile.stdout),
          readFileSync,
        )
      ) {
        rejectMismatchedStaticProfile(profile);
        return;
      }
      continue;
    }

    const diagnostic = compactText(deps.redact(rawDiagnostic));
    errorLog(
      `\n  ✗ Failed to register the ${profile.channelId} provider profile with OpenShell.`,
    );
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
    exit(result.status || 1);
    return;
  }
}

function buildRefreshMaterial(
  profile: RefreshingMessagingBridgeProfile,
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

// Gateway-side minting is asynchronous: `provider refresh configure` records the
// material and leaves the credential `configured`, and the refresh worker mints
// on its next sweep. Onboarding must wait for that mint:
// - Until it lands, the provider still holds the create-time sentinel.
// - The sandbox reads the provider environment once, at boot, and every later
//   agent restart inherits that read.
// - OpenShell retains old credential generations, so the boot revision still
//   resolves after the mint - to the sentinel, not to the token.
// - The agent then authenticates with the sentinel, the channel API rejects it,
//   and it reads as a channel auth failure rather than an onboarding order bug.
const BRIDGE_MINT_POLL_ATTEMPTS = 50;
const BRIDGE_MINT_POLL_INTERVAL_MS = 3_000;
const BRIDGE_MINT_STATUS_TIMEOUT_MS = 15_000;
// Attempts alone do not bound the wait: each probe also spends command time.
const BRIDGE_MINT_DEADLINE_MS = 300_000;
const BRIDGE_MINT_STATUS_REFRESHED = "refreshed";
const ANSI_STYLE_PATTERN = /\u001B\[[0-9;]*m/g;

/**
 * Read the STATUS cell for `credentialKey` out of `openshell provider refresh
 * status` output.
 * - Columns are separated by runs of spaces, so a timestamp keeps its one inner
 *   space.
 * - Returns "" when the credential has no row.
 */
export function refreshStatusForCredential(text: string, credentialKey: string): string {
  const row = text
    .split("\n")
    .map((line) => line.replace(ANSI_STYLE_PATTERN, "").trim())
    .find((line) => line.includes(credentialKey));
  const columns = (row ?? "").split(/\s{2,}/).filter(Boolean);
  const keyIndex = columns.indexOf(credentialKey);
  // Columns are PROVIDER, CREDENTIAL_KEY, STRATEGY, STATUS, ...
  return keyIndex < 0 ? "" : (columns[keyIndex + 2] ?? "");
}

function sleepSync(milliseconds: number): void {
  // Vitest sets process.env.VITEST, so the poll loop costs no wall-clock in tests.
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForMintedBridgeCredential(
  providerName: string,
  credentialKey: string,
  deps: ConfigureMessagingBridgeRefreshesDeps,
): MessagingBridgeRefreshResult {
  const sleep = deps.sleep ?? sleepSync;
  const now = deps.now ?? (() => Date.now());
  // The mint runs on the gateway's own sweep, so this can sit for a minute.
  (deps.log ?? console.error)(`  Waiting for the gateway to mint ${credentialKey}…`);
  const deadline = now() + BRIDGE_MINT_DEADLINE_MS;
  let status = "";
  for (let attempt = 0; attempt < BRIDGE_MINT_POLL_ATTEMPTS && now() < deadline; attempt += 1) {
    const result = deps.runOpenshell(
      ["provider", "refresh", "status", providerName, "--credential-key", credentialKey],
      // suppressOutput: the runner re-emits piped child output; without it every
      // poll reprints the whole status table into the onboarding transcript.
      {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
        timeout: BRIDGE_MINT_STATUS_TIMEOUT_MS,
      },
    );
    // A nonzero probe can still print a stale table; only trust a clean read.
    status =
      result.status === 0
        ? refreshStatusForCredential(bufferOrStringToText(result.stdout), credentialKey)
        : "";
    if (status === BRIDGE_MINT_STATUS_REFRESHED) return { ok: true };
    sleep(BRIDGE_MINT_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    reason: `gateway token minting did not complete for '${providerName}' (last status '${status || "unknown"}')`,
  };
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
  const active = bridgeProfilesForTokenDefs(tokenDefs, profiles).filter(hasRefreshStrategy);
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
    if (result.status === 0) {
      const minted = waitForMintedBridgeCredential(bridge.name, profile.credentialKey, deps);
      if (minted.ok) continue;
      warn(`\n  ✗ ${profile.channelId} bridge: ${minted.reason}.`);
      warn("    Outbound replies for this channel will not authenticate until this is resolved.");
      return minted;
    }

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
