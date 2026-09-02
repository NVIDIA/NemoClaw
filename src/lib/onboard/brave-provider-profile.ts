// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { registerCheckedInProviderProfile } from "../adapters/openshell/provider-profile-registration";
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
 * Single source of truth for "the user opted in to Brave Search at runtime."
 * Returning true on a config whose `fetchEnabled` is false would cause
 * `createSandbox` to push a Brave provider/token and trip the BRAVE_API_KEY-
 * required abort even when the feature is off, while the downstream
 * finalization/verifier paths already gate on `fetchEnabled`. Keep every gate
 * routed through this helper so they stay aligned.
 */
export function shouldEnableWebSearch(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return isWebSearchEnabled(webSearchConfig as { fetchEnabled: boolean } | null | undefined);
}

export type BraveProviderProfileDeps = {
  root: string;
  runOpenshell: (
    args: string[],
    // The runner accepts a wider options shape; we only set ignoreError +
    // stdio here, so erase the type at the boundary to keep this module
    // free of the runner.ts internals.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null };
  redact: (input: string) => string;
  log?: (message?: string) => void;
  exit?: (code?: number) => never;
};

type TokenDefShape = { providerType?: string; token: string | null };

export function braveProviderProfilePath(root: string): string {
  return webSearchProviderProfilePath(root, "brave");
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
  deps: BraveProviderProfileDeps,
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

  for (const provider of neededProviders) {
    let failureStatus = 1;
    const result = registerCheckedInProviderProfile({
      profilePath: webSearchProviderProfilePath(deps.root, provider),
      runOpenshell: (args, options) => {
        const command = deps.runOpenshell(args, options);
        failureStatus =
          Number.isInteger(command.status) && command.status !== 0
            ? (command.status ?? 1)
            : failureStatus;
        return command;
      },
    });
    if (result.ok) continue;

    const diagnostic = compactText(deps.redact(result.error.message));
    errorLog(
      `\n  ✗ Failed to register the ${provider} web-search provider profile with OpenShell.`,
    );
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
    exit(failureStatus);
  }
}
