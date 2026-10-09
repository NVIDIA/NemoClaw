// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { normalizeNativeHostedProviderAttachment } from "../../inference/native-hosted/contract";
import { CLI_NAME } from "../../cli/branding";
import { R, RD } from "../../cli/terminal-style";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import {
  checkRebuildGatewayProviderOrBail,
  validateRebuildHostInferenceCredential,
  shouldVerifyRebuildGatewayProvider,
  type HostCredentialTarget,
} from "./rebuild-provider-preflight";
import { getRebuildCredentialEnvFromRegistry } from "./rebuild-resume-config";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_INFERENCE_CREDENTIAL_ENV: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
  inspectHermesProviderBinding: (runOpenshellFn: typeof runOpenshell) => Promise<{
    exists: boolean;
    credentialKeys: string[] | null;
  }>;
};

export type RebuildBail = (message: string, code?: number) => never;
export type RebuildLog = (message: string) => void;
export type RebuildCredentialPreflightOptions = {
  /** A validated prepared recovery may rebuild a missing provider from an exported host key. */
  allowMissingGatewayProviderWithHostCredential?: boolean;
  onGatewayProviderReconfigureRequired?: (provider: string, credentialEnv: string) => void;
};

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

async function preflightHermesProviderCredentials(
  persistedAuthMethod: unknown,
  credentialEnv: string | null,
  log: RebuildLog,
): Promise<boolean> {
  const authMethod =
    normalizeHermesRebuildAuthMethod(persistedAuthMethod) ||
    (credentialEnv === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV ? "api_key" : null);
  // Native Hermes stores either logical authentication method under one profile key.
  const expectedCredentialEnv = hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV;
  const binding = await hermesProviderAuth.inspectHermesProviderBinding(runOpenshell);

  if (binding.exists) {
    const matches =
      binding.credentialKeys?.length === 1 &&
      (binding.credentialKeys[0] === expectedCredentialEnv ||
        (authMethod === "api_key" &&
          binding.credentialKeys[0] === hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV));
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

  // A rebuild may reuse only the recorded provider identity. Recreating a
  // missing provider here would mutate credentials before the receipt check.
  console.error("");
  console.error(
    `  ${RD}Rebuild preflight failed:${R} Hermes Provider is not registered in OpenShell.`,
  );
  console.error("  Hermes Provider credentials must be stored in OpenShell, not host-side files.");
  if (authMethod === "api_key") {
    console.error(
      `  Re-run ${CLI_NAME} onboard to recreate the sandbox with its native provider attachment.`,
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

export async function preflightRebuildHostCredential(
  target: HostCredentialTarget,
  credentialValue: string | null,
  bail: RebuildBail,
): Promise<boolean> {
  if (!credentialValue || (await validateRebuildHostInferenceCredential(target, credentialValue)))
    return true;
  console.error("");
  console.error(
    `  ${RD}Rebuild preflight failed:${R} the host inference credential could not be validated.`,
  );
  console.error("  Check the host inference credential and recorded endpoint, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
  bail("Host inference credential validation failed");
  return false;
}

export async function preflightRebuildCredentials(
  sb: RebuildSandboxEntry,
  log: RebuildLog,
  bail: RebuildBail,
  options: RebuildCredentialPreflightOptions = {},
): Promise<boolean> {
  const rebuildCredentialEnv = getRebuildCredentialEnvFromRegistry(
    sb.provider,
    sb.credentialEnv,
    sb.endpointUrl,
  );
  const rebuildProvider = sb.provider;
  const rawAttachment =
    sb.nativeHostedProviderAttachment !== undefined
      ? sb.nativeHostedProviderAttachment
      : sb.nativeNvidiaProviderAttachment;
  const nativeAttachment = normalizeNativeHostedProviderAttachment(rawAttachment);
  if (rawAttachment !== undefined && !nativeAttachment) {
    bail("Malformed native provider attachment; sandbox is untouched.");
    return false;
  }
  if (nativeAttachment) {
    if (
      !(await checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail, {
        nativeAttachment,
      }))
    )
      return false;
    return preflightRebuildHostCredential(
      { ...sb, credentialEnv: rebuildCredentialEnv },
      rebuildCredentialEnv
        ? rebuildOnboardDependencies.hydrateCredentialEnv(rebuildCredentialEnv)
        : null,
      bail,
    );
  }

  if (rebuildProvider === hermesProviderAuth.HERMES_PROVIDER_NAME) {
    if (
      !(await preflightHermesProviderCredentials(sb.hermesAuthMethod, rebuildCredentialEnv, log))
    ) {
      bail("Missing Hermes Provider credentials");
      return false;
    }
    return true;
  }

  if (!rebuildCredentialEnv) {
    if (
      !(await checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail))
    ) {
      return false;
    }
    log(
      "Preflight credential check: no credentialEnv in session (local inference or missing session)",
    );
    return true;
  }

  const credentialValue = rebuildOnboardDependencies.hydrateCredentialEnv(rebuildCredentialEnv);
  log(
    `Preflight credential check: ${rebuildCredentialEnv} → ${credentialValue ? "present" : "MISSING"}`,
  );
  if (
    !(await checkRebuildGatewayProviderOrBail(rebuildProvider, rebuildCredentialEnv, log, bail, {
      allowProviderReconfigure: options.allowMissingGatewayProviderWithHostCredential,
      hostCredentialAvailable: Boolean(credentialValue),
      onProviderReconfigureRequired: options.onGatewayProviderReconfigureRequired,
    }))
  ) {
    return false;
  }
  if (!credentialValue && shouldVerifyRebuildGatewayProvider(rebuildProvider)) {
    log(
      `Preflight credential check: provider '${rebuildProvider}' registered in gateway — skipping env check for ${rebuildCredentialEnv}`,
    );
    return true;
  }
  if (credentialValue) {
    return preflightRebuildHostCredential(
      { ...sb, credentialEnv: rebuildCredentialEnv },
      credentialValue,
      bail,
    );
  }

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
