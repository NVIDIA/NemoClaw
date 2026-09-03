// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  type CheckedInProviderProfileResult,
  reconcileCheckedInProviderProfile,
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

/** Return whether the user enabled web search for this run. */
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
    // The runner accepts a wider options shape. Keep this module free of runner internals.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => RunOpenshellResult;
  redact: (input: string) => string;
  log?: (message?: string) => void;
  exit?: (code?: number) => never;
  readFileSync?: (file: string) => string;
};

type TokenDefShape = { providerType?: string; token: string | null };

export function webSearchProviderProfilePath(
  root: string,
  provider: WebSearchProviderProfileId,
): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${provider}.yaml`);
}

function webSearchFailureMessages(
  provider: WebSearchProviderProfileId,
  profilePath: string,
  result: Exclude<CheckedInProviderProfileResult, { ok: true }>,
  redact: (input: string) => string,
): string[] {
  if (result.reason === "profile-drifted") {
    return [
      `\n  ✗ The '${provider}' OpenShell provider profile already registered in the selected OpenShell gateway does not match the profile this NemoClaw checkout ships.`,
      `    Its endpoints, binaries, credential rules, or inference capability differ from ${profilePath}.`,
      `    Onboarding remains stopped. Run 'openshell gateway info' to identify the selected gateway. Confirm with its administrator which sandboxes use '${provider}' before changing the shared profile. If replacement is approved, run 'openshell provider profile -g <gateway-name> delete ${provider}', then re-run onboarding.`,
    ];
  }
  if (result.reason === "profile-unreadable") {
    return [
      `\n  ✗ Could not verify the '${provider}' OpenShell provider profile against ${profilePath}.`,
      "    The exported or checked-in profile was unreadable. It was left in place; resolve the read failure and re-run onboarding.",
    ];
  }
  const operation = result.operation ?? "profile operation";
  const diagnostic = compactText(redact(result.diagnostic ?? ""));
  const messages = [
    result.reason === "import-failed"
      ? `\n  ✗ Failed to register the ${provider} web-search provider profile with OpenShell.`
      : `\n  ✗ Could not check whether the ${provider} web-search provider profile is registered (${operation} failed).`,
  ];
  if (diagnostic) messages.push(`    ${diagnostic.slice(0, 500)}`);
  messages.push(
    result.reason === "import-failed"
      ? "    Fix the error. If OpenShell requires an update, rerun the NemoClaw installer, then onboarding."
      : "    Confirm the OpenShell gateway is reachable and this account is authorized, then re-run onboarding.",
  );
  return messages;
}

/** Register or validate every selected web-search profile before token upsert. */
export function ensureWebSearchProviderProfiles(
  tokenDefs: readonly TokenDefShape[],
  deps: WebSearchProviderProfileDeps,
): void {
  const neededProviders = new Set<WebSearchProviderProfileId>();
  for (const { providerType, token } of tokenDefs) {
    if (
      token &&
      typeof providerType === "string" &&
      (WEB_SEARCH_PROVIDER_PROFILE_IDS as readonly string[]).includes(providerType)
    ) {
      neededProviders.add(providerType as WebSearchProviderProfileId);
    }
  }

  const log = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  const readFileSync = deps.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf-8"));
  for (const provider of neededProviders) {
    const profilePath = webSearchProviderProfilePath(deps.root, provider);
    const result = reconcileCheckedInProviderProfile({
      profileId: provider,
      profilePath,
      readCheckedInProfile: () => readFileSync(profilePath),
      runOpenshell: deps.runOpenshell,
    });
    if (result.ok) continue;
    for (const message of webSearchFailureMessages(provider, profilePath, result, deps.redact)) {
      log(message);
    }
    const status = result.reason === "import-failed" ? result.diagnosticStatus : undefined;
    exit(status || 1);
  }
}
