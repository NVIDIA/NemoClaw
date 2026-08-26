// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import type { CheckedInBoundaryComparison } from "../adapters/openshell/provider-profile";
import {
  compareExportedProfileToCheckedIn,
  isMissingProviderProfile,
  normalizeOpenshellDiagnostic,
  openshellResultDiagnostic,
} from "../adapters/openshell/provider-profile";
import { compactText } from "../core/url-utils";
import { isWebSearchEnabled } from "../inference/web-search";

export const BRAVE_PROVIDER_PROFILE_ID = "brave";
export const TAVILY_PROVIDER_PROFILE_ID = "tavily";
// OpenShell custom profiles are immutable after import. Use a versioned Hermes
// profile so upgrades never accept the earlier Deep Agents-only Tavily binary
// allowlist as compatible with Hermes.
export const HERMES_TAVILY_PROVIDER_PROFILE_ID = "tavily-hermes-v1";
export const WEB_SEARCH_PROVIDER_PROFILE_IDS = [
  BRAVE_PROVIDER_PROFILE_ID,
  TAVILY_PROVIDER_PROFILE_ID,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
] as const;
export type WebSearchProviderProfileId = (typeof WEB_SEARCH_PROVIDER_PROFILE_IDS)[number];

/**
 * Single source of truth for "the user opted in to web search at runtime."
 * Returning true on a config whose `fetchEnabled` is false would cause
 * `createSandbox` to push a web-search provider/token and trip the required
 * abort even when the feature is off, while the downstream
 * finalization/verifier paths already gate on `fetchEnabled`. Keep every gate
 * routed through this helper so they stay aligned.
 */
export function shouldEnableWebSearch(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return isWebSearchEnabled(webSearchConfig as { fetchEnabled: boolean } | null | undefined);
}

type RunOpenshellResult = {
  status: number | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
  error?: Error;
};

export type WebSearchProviderProfileDeps = {
  root: string;
  runOpenshell: (
    args: string[],
    // The runner accepts a wider options shape. Keep this module free of the
    // runner.ts internals by erasing that shape at the injected boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => RunOpenshellResult;
  redact: (input: string) => string;
  log?: (message?: string) => void;
  exit?: (code?: number) => never;
  readFileSync?: (file: string) => string;
};

type TokenDefShape = { providerType?: string; token: string | null };

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
}

/**
 * Whether an exported profile is the one this codebase ships for `provider`,
 * comparing its credential boundary (endpoints, binaries, credential rewrite
 * rules, inference_capable). A profile ID match alone is not proof of this:
 * OpenShell custom profiles are immutable after import, but that says nothing
 * about what content some other process (an older NemoClaw version, a
 * different tool, an unrelated host-global registration) imported under the
 * same ID before this run ever probed it. Skipping re-import on ID match alone
 * would silently trust that unverified boundary (#10371).
 *
 * Compares through OpenShell's export representation, and distinguishes a read
 * that never completed from confirmed drift.
 */
function compareWebSearchProfileToCheckedIn(
  root: string,
  provider: WebSearchProviderProfileId,
  exportedJson: string,
  readFileSync: (file: string) => string,
): CheckedInBoundaryComparison {
  return compareExportedProfileToCheckedIn(
    exportedJson,
    () => readFileSync(webSearchProviderProfilePath(root, provider)),
    provider,
  );
}

export function webSearchProviderProfilePath(
  root: string,
  provider: WebSearchProviderProfileId,
): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${provider}.yaml`);
}

/** Register every selected web-search provider profile before token upsert. */
export function ensureWebSearchProviderProfiles(
  tokenDefs: readonly TokenDefShape[],
  deps: WebSearchProviderProfileDeps,
): void {
  const neededProviders = new Set<WebSearchProviderProfileId>();
  for (const { providerType, token } of tokenDefs) {
    if (!token) continue;
    if (
      typeof providerType === "string" &&
      (WEB_SEARCH_PROVIDER_PROFILE_IDS as readonly string[]).includes(providerType)
    ) {
      neededProviders.add(providerType as WebSearchProviderProfileId);
    }
  }
  if (neededProviders.size === 0) return;

  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  const readFileSync = deps.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf-8"));

  const rejectDriftedProfile = (provider: WebSearchProviderProfileId): never => {
    errorLog(
      `\n  ✗ The '${provider}' OpenShell provider profile already registered in the selected ` +
        "OpenShell gateway does not match the profile this NemoClaw checkout ships.",
    );
    errorLog(
      "    Its endpoints, binaries, credential rules, or inference capability differ from " +
        `${webSearchProviderProfilePath(deps.root, provider)}.`,
    );
    errorLog(
      "    Find the selected gateway's name with 'openshell gateway info', then remove the " +
        `conflicting profile from that gateway (openshell provider profile -g <gateway-name> ` +
        `delete ${provider}) and re-run onboarding. Other sandboxes that use the same gateway may ` +
        "share this profile — confirm the effect before removing it.",
    );
    return exit(1);
  };

  const rejectUnverifiableProfile = (provider: WebSearchProviderProfileId): never => {
    errorLog(
      `\n  ✗ Could not verify the '${provider}' OpenShell provider profile already registered in ` +
        "the selected OpenShell gateway against the profile this NemoClaw checkout ships.",
    );
    errorLog(
      "    The gateway's export was not readable as JSON, or " +
        `${webSearchProviderProfilePath(deps.root, provider)} could not be read as a provider ` +
        "profile. An unfinished check is not proof the registered profile drifted, so it was " +
        "left in place. Resolve the read failure and re-run onboarding.",
    );
    return exit(1);
  };

  const rejectProbeFailure = (
    provider: WebSearchProviderProfileId,
    operation: string,
    rawDiagnostic: string,
  ): never => {
    const diagnostic = compactText(deps.redact(rawDiagnostic));
    errorLog(
      `\n  ✗ Could not check whether the ${provider} web-search provider profile is already ` +
        `registered (${operation} failed).`,
    );
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog(
      "    Confirm the OpenShell gateway is reachable and this account is authorized, then re-run onboarding.",
    );
    return exit(1);
  };

  const exportProfile = (provider: WebSearchProviderProfileId) =>
    deps.runOpenshell(["provider", "profile", "export", provider, "--output", "json"], {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });

  for (const provider of neededProviders) {
    // These profiles live in one host-global OpenShell custom-profile store, so
    // every rebuild and every additional sandbox re-imports what the first
    // onboard already registered. Probe first and skip the re-import — the same
    // idiom ensureMessagingBridgeProfiles() uses for the same reason — so
    // OpenShell's "already exists" diagnostic stops reaching the terminal on
    // routine rebuilds. A fresh host answers the probe with a harmless
    // "not found" that suppressOutput hides.
    const alreadyRegistered = exportProfile(provider);
    if (alreadyRegistered.status === 0) {
      // A profile ID match is not proof this is the checked-in profile: immutability
      // after import says nothing about what content was imported under
      // this ID before this run ever probed it. Verify the boundary before
      // trusting it (#10371).
      const comparison = compareWebSearchProfileToCheckedIn(
        deps.root,
        provider,
        bufferOrStringToText(alreadyRegistered.stdout),
        readFileSync,
      );
      if (comparison === "indeterminate") rejectUnverifiableProfile(provider);
      if (comparison === "mismatch") rejectDriftedProfile(provider);
      continue;
    }

    // A nonzero probe status alone is not proof the profile is missing — the
    // gateway could be unreachable, this account unauthorized, or the probe
    // could have timed out or spawned incorrectly. Only a recognized
    // "not found" diagnostic makes it safe to proceed to import; anything
    // else must stop here rather than attempt a state-changing import in
    // response to a read that never actually completed (#10371).
    const probeDiagnostic = openshellResultDiagnostic(alreadyRegistered);
    if (
      !Number.isInteger(alreadyRegistered.status) ||
      !isMissingProviderProfile(probeDiagnostic, provider)
    ) {
      rejectProbeFailure(provider, "provider profile export", probeDiagnostic);
    }

    const result = deps.runOpenshell(
      [
        "provider",
        "profile",
        "import",
        "--file",
        webSearchProviderProfilePath(deps.root, provider),
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      },
    );
    if (result.status === 0) continue;

    // Reconcile a lost race: the probe saw no profile but a concurrent import
    // registered it first. OpenShell reports that re-import as a non-zero exit,
    // so tolerate it and keep re-onboard / recreate working. Normalize wrapped
    // diagnostics so race recovery recognizes `already exists` regardless of
    // terminal width or TTY output (#10159, #10371).
    const rawDiagnostic = openshellResultDiagnostic(result);
    if (/already exists/iu.test(normalizeOpenshellDiagnostic(rawDiagnostic))) {
      // The race winner might not be our own import: re-export and verify
      // the boundary before treating the race as resolved, exactly as the
      // initial probe above does.
      const raced = exportProfile(provider);
      if (raced.status !== 0) {
        rejectProbeFailure(
          provider,
          "post-race provider profile export",
          openshellResultDiagnostic(raced),
        );
      }
      const racedComparison = compareWebSearchProfileToCheckedIn(
        deps.root,
        provider,
        bufferOrStringToText(raced.stdout),
        readFileSync,
      );
      if (racedComparison === "indeterminate") rejectUnverifiableProfile(provider);
      if (racedComparison === "mismatch") rejectDriftedProfile(provider);
      continue;
    }

    const diagnostic = compactText(deps.redact(rawDiagnostic));
    errorLog(
      `\n  ✗ Failed to register the ${provider} web-search provider profile with OpenShell.`,
    );
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog(
      "    Fix the error above. If OpenShell requires an update, rerun the NemoClaw installer. Then rerun onboarding.",
    );
    exit(result.status || 1);
  }
}
