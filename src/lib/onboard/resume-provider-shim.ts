// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Wires `ensureResumeProviderReady` (in `./resume-provider-recovery`) to the
// dependencies it needs. Lives outside `src/lib/onboard.ts` so the wiring
// doesn't count against the entrypoint-budget gate.

import { DEFAULT_ROUTE_CREDENTIAL_ENV } from "../inference/config";
import { hydrateCredentialEnv } from "./credential-env";
import { validateNvidiaApiKeyValue } from "../validation";
import { D, R } from "../cli/terminal-style";
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
  providerExistsInGateway: ResumeProviderRecoveryDeps["providerExistsInGateway"];
  resumeProviderShimDeps: {
    isRoutedInferenceProvider: ResumeProviderRecoveryDeps["isRoutedInferenceProvider"];
    replaceNamedCredential: ResumeProviderRecoveryDeps["replaceNamedCredential"];
  };
};

export async function ensureResumeProviderReady(
  provider: string | null | undefined,
  credentialEnv: string | null | undefined,
): Promise<ResumeProviderRecoveryResult> {
  const o = require("../onboard") as OnboardLazy;
  return ensureResumeProviderReadyImpl(provider, credentialEnv, {
    remoteProviderConfig: onboardProviders.REMOTE_PROVIDER_CONFIG,
    defaultRouteCredentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
    isRoutedInferenceProvider: o.resumeProviderShimDeps.isRoutedInferenceProvider,
    providerExistsInGateway: o.providerExistsInGateway,
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
