// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { R, RD } from "../../cli/terminal-style";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  checkRebuildGatewayProviderOrBail,
  shouldVerifyRebuildGatewayProvider,
} from "./rebuild-provider-preflight";
import { getRebuildCredentialEnvFromRegistry } from "./rebuild-resume-config";

const onboardModule = require("../../onboard") as {
  hydrateCredentialEnv: (name: string) => string | null;
};
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_INFERENCE_CREDENTIAL_ENV: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
  inspectHermesProviderBinding: (runOpenshellFn: typeof runOpenshell) => {
    exists: boolean;
    credentialKeys: string[] | null;
  };
  registerHermesInferenceProvider: (
    apiKey: string,
    runOpenshellFn: typeof runOpenshell,
    credentialEnv?: string,
    baseUrl?: string,
  ) => void;
};

export type RebuildBail = (message: string, code?: number) => never;
export type RebuildLog = (message: string) => void;

function normalizeHermesRebuildAuthMethod(value: unknown): "oauth" | "api_key" | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "oauth" || normalized === "nous_oauth" || normalized === "nous_portal_oauth") {
    return "oauth";
  }
  if (
    normalized === "api" ||
    normalized === "key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "nous_api_key"
  ) {
    return "api_key";
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function preflightHermesProviderCredentials(
  persistedAuthMethod: unknown,
  credentialEnv: string | null,
  log: RebuildLog,
): boolean {
  const authMethod =
    normalizeHermesRebuildAuthMethod(persistedAuthMethod) ||
    (credentialEnv === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV ? "api_key" : null);
  const expectedCredentialEnv =
    authMethod === "api_key"
      ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
      : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV;
  const binding = hermesProviderAuth.inspectHermesProviderBinding(runOpenshell);

  if (binding.exists) {
    const matches =
      binding.credentialKeys?.length === 1 && binding.credentialKeys[0] === expectedCredentialEnv;
    if (matches) {
      log("Hermes Provider rebuild preflight: credential binding matches");
      return true;
    }
    log("Hermes Provider rebuild preflight: credential binding does not match");
    console.error("");
    console.error(
      `  ${RD}Rebuild preflight failed:${R} the shared Hermes Provider credential binding has changed.`,
    );
    console.error(
      "  Expected exactly the credential binding recorded for this sandbox; re-run Hermes onboarding to reconcile it.",
    );
    console.error("  Sandbox is untouched — no data was lost.");
    return false;
  }

  if (authMethod === "api_key") {
    const envKey = nonEmptyString(
      process.env[hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV],
    );
    log(
      `Hermes Provider rebuild preflight: OpenShell provider missing; API key env=${envKey ? "present" : "missing"}`,
    );
    if (envKey) {
      try {
        console.log(
          "  Hermes Provider is not registered in OpenShell; registering it from the configured exported API-key environment variable before rebuild.",
        );
        hermesProviderAuth.registerHermesInferenceProvider(
          envKey,
          runOpenshell,
          hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
        );
        const registered = hermesProviderAuth.inspectHermesProviderBinding(runOpenshell);
        return (
          registered.credentialKeys?.length === 1 &&
          registered.credentialKeys[0] === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        );
      } catch (err) {
        log(
          `Hermes Provider rebuild preflight: failed to register OpenShell provider: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  console.error("");
  console.error(
    `  ${RD}Rebuild preflight failed:${R} Hermes Provider is not registered in OpenShell.`,
  );
  console.error("  Hermes Provider credentials must be stored in OpenShell, not host-side files.");
  if (authMethod === "api_key") {
    console.error(
      `  Export the Hermes Provider API key and rerun rebuild, or re-run ${CLI_NAME} onboard to register it.`,
    );
  } else {
    console.error(
      `  Re-run ${CLI_NAME} onboard interactively to authorize Hermes Provider and register it with OpenShell.`,
    );
  }
  console.error("");
  console.error("  Sandbox is untouched — no data was lost.");
  return false;
}

export function preflightRebuildCredentials(
  sb: RebuildSandboxEntry,
  log: RebuildLog,
  bail: RebuildBail,
): boolean {
  const rebuildCredentialEnv = getRebuildCredentialEnvFromRegistry(sb.provider, sb.credentialEnv);
  const rebuildProvider = sb.provider;

  if (rebuildProvider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    if (!preflightHermesProviderCredentials(sb.hermesAuthMethod, rebuildCredentialEnv, log)) {
      bail("Missing Hermes Provider credentials");
      return false;
    }
    return true;
  }

  if (!rebuildCredentialEnv) {
    if (!checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail)) {
      return false;
    }
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
    return true;
  }

  const credentialValue = onboardModule.hydrateCredentialEnv(rebuildCredentialEnv);
  log(
    `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
  );
  if (!checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail)) {
    return false;
  }
  if (!credentialValue && shouldVerifyRebuildGatewayProvider(rebuildProvider)) {
    log(
      `Preflight credential check: provider '${rebuildProvider}' registered in gateway — skipping env check for ${rebuildCredentialEnv}`,
    );
    return true;
  }
  if (credentialValue) return true;

  console.error("");
  console.error(`  ${RD}Rebuild preflight failed:${R} provider credential not found.`);
  console.error(`  The non-interactive recreate step requires ${rebuildCredentialEnv},`);
  console.error("  but it is not set in the environment.");
  console.error("");
  console.error("  To fix, do one of:");
  console.error(`    export ${rebuildCredentialEnv}=<your-key>`);
  console.error(`    ${CLI_NAME} onboard          # re-enter the key interactively`);
  console.error("");
  console.error("  Sandbox is untouched — no data was lost.");
  bail(`Missing credential: ${rebuildCredentialEnv}`);
  return false;
}
