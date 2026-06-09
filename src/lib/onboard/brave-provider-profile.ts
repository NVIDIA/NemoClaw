// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { compactText } from "../core/url-utils";

export const BRAVE_PROVIDER_PROFILE_ID = "brave";

/**
 * Single source of truth for "the user opted in to Brave Search at runtime."
 * Returning true on a config whose `fetchEnabled` is false would cause
 * `createSandbox` to push a Brave provider/token and trip the BRAVE_API_KEY-
 * required abort even when the feature is off, while the downstream
 * finalization/verifier paths already gate on `fetchEnabled`. Keep every gate
 * routed through this helper so they stay aligned.
 */
export function shouldEnableBraveWebSearch(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return Boolean(webSearchConfig?.fetchEnabled);
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

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
}

export function braveProviderProfilePath(root: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", "brave.yaml");
}

/**
 * Register the Brave Search provider profile with OpenShell so providers
 * created with `--type brave` drive the L7 proxy's X-Subscription-Token
 * rewrite. Skipped unless at least one token definition is Brave-typed and
 * has a usable token. Idempotent: tolerates OpenShell reporting that the
 * custom profile is already registered.
 */
export function ensureBraveProviderProfile(
  tokenDefs: readonly TokenDefShape[],
  deps: BraveProviderProfileDeps,
): void {
  const needs = tokenDefs.some(
    ({ providerType, token }) => providerType === BRAVE_PROVIDER_PROFILE_ID && Boolean(token),
  );
  if (!needs) return;

  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));

  const result = deps.runOpenshell(
    ["provider", "profile", "import", "--file", braveProviderProfilePath(deps.root)],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0) return;

  // OpenShell reports re-imports of an already-registered custom profile as
  // a non-zero exit. Tolerate that so re-onboard / recreate keeps working.
  const rawDiagnostic = `${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`;
  if (/already exists/i.test(rawDiagnostic)) return;

  const diagnostic = compactText(deps.redact(rawDiagnostic));
  errorLog("\n  ✗ Failed to register the Brave Search provider profile with OpenShell.");
  if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
  errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
  exit(result.status || 1);
}
