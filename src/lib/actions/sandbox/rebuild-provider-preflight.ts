// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";
import { RD as _RD, R } from "../../cli/terminal-style";
import { isLocalInferenceProvider } from "./rebuild-resume-config";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
};
const { providerExistsInGateway } = require("../../onboard/providers") as {
  providerExistsInGateway: (name: string, runOpenshellFn: typeof runOpenshell) => boolean;
};

function printMissingRebuildGatewayProvider(provider: string, credentialEnv: string | null): void {
  console.error("");
  console.error(
    `  ${_RD}Rebuild preflight failed:${R} provider '${provider}' is not registered in OpenShell.`,
  );
  console.error("  The sandbox registry still points at this upstream provider,");
  console.error("  so rebuild will not recreate it before destroying the sandbox.");
  if (credentialEnv) {
    console.error(`  Rebuild cannot rely on ${credentialEnv} while that provider is missing.`);
  }
  console.error("");
  console.error("  Re-register the provider in OpenShell or rerun onboard, then retry rebuild.");
  console.error("  Sandbox is untouched — no data was lost.");
}

export function shouldVerifyRebuildGatewayProvider(
  provider: string | null | undefined,
): provider is string {
  return Boolean(
    provider &&
      !isLocalInferenceProvider(provider) &&
      provider !== hermesProviderAuth.HERMES_PROVIDER_NAME,
  );
}

export function checkRebuildGatewayProviderOrBail(
  provider: string | null | undefined,
  credentialEnv: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): boolean {
  if (!shouldVerifyRebuildGatewayProvider(provider)) return true;

  const providerRegisteredInGateway = providerExistsInGateway(provider, runOpenshell);
  log(
    `Preflight gateway provider check: provider '${provider}' is ${
      providerRegisteredInGateway ? "registered" : "missing"
    } in OpenShell`,
  );
  if (providerRegisteredInGateway) return true;

  printMissingRebuildGatewayProvider(provider, credentialEnv);
  bail(`Missing gateway provider: ${provider}`);
  return false;
}
