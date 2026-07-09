// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Wires `ensureResumeProviderReady` (in `./resume-provider-recovery`) to the
// dependencies it needs. Lives outside `src/lib/onboard.ts` so the wiring
// doesn't count against the entrypoint-budget gate.

import { runOpenshell } from "../adapters/openshell/runtime";
import { D, R } from "../cli/terminal-style";
import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import { DEFAULT_ROUTE_CREDENTIAL_ENV } from "../inference/config";
import { validateNvidiaApiKeyValue } from "../validation";
import { hydrateCredentialEnv } from "./credential-env";
import {
  matchesGatewayProviderBinding,
  readGatewayProviderMetadata,
} from "./gateway-provider-metadata";
import {
  ensureResumeProviderReady as ensureResumeProviderReadyImpl,
  type ResumeProviderRecoveryDeps,
  type ResumeProviderRecoveryResult,
} from "./resume-provider-recovery";

const onboardProviders = require("./providers") as {
  REMOTE_PROVIDER_CONFIG: ResumeProviderRecoveryDeps["remoteProviderConfig"];
  getProviderLabel: ResumeProviderRecoveryDeps["getProviderLabel"];
};

// Lazy require breaks the circular module load — by the time
// `ensureResumeProviderReady` is called, onboard.ts has finished loading
// and its `module.exports.resumeProviderShimDeps` is populated.
type OnboardLazy = {
  isNonInteractive: ResumeProviderRecoveryDeps["isNonInteractive"];
  providerExistsInGateway(name: string, gatewayName: string): boolean;
  resumeProviderShimDeps: {
    isRoutedInferenceProvider: ResumeProviderRecoveryDeps["isRoutedInferenceProvider"];
    replaceNamedCredential: ResumeProviderRecoveryDeps["replaceNamedCredential"];
  };
};

export async function ensureResumeProviderReady(
  gatewayName: string,
  provider: string | null | undefined,
  credentialEnv: string | null | undefined,
): Promise<ResumeProviderRecoveryResult> {
  const o = require("../onboard") as OnboardLazy;
  return ensureResumeProviderReadyImpl(provider, credentialEnv, {
    remoteProviderConfig: onboardProviders.REMOTE_PROVIDER_CONFIG,
    defaultRouteCredentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
    isRoutedInferenceProvider: o.resumeProviderShimDeps.isRoutedInferenceProvider,
    providerExistsInGateway: (name) => o.providerExistsInGateway(name, gatewayName),
    hydrateCredentialEnv,
    getProviderLabel: onboardProviders.getProviderLabel,
    isNonInteractive: o.isNonInteractive,
    note: (m) => console.log(`${D}${m}${R}`),
    replaceNamedCredential: o.resumeProviderShimDeps.replaceNamedCredential,
    validateNvidiaApiKeyValue,
    log: (m) => console.log(m),
    warn: (m) => console.error(m),
    exit: (c) => process.exit(c),
  });
}

export function isResumeProviderSurfaceReady(
  gatewayName: string,
  provider: string | null | undefined,
  preferredInferenceApi: string | null | undefined,
  credentialEnv: string | null | undefined,
  endpointUrl: string | null | undefined,
): boolean {
  if (
    provider !== "compatible-anthropic-endpoint" ||
    preferredInferenceApi !== "openai-completions" ||
    isBedrockRuntimeEndpoint(endpointUrl)
  ) {
    return true;
  }

  const metadata = readGatewayProviderMetadata(
    provider,
    runOpenshell as unknown as Parameters<typeof readGatewayProviderMetadata>[1],
    gatewayName,
  );
  return matchesGatewayProviderBinding(metadata, {
    name: provider,
    type: "openai",
    credentialKey: credentialEnv ?? "COMPATIBLE_ANTHROPIC_API_KEY",
    configKey: "OPENAI_BASE_URL",
  });
}
