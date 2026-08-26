// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { runOpenshell } from "../../adapters/openshell/runtime";
import { D, R } from "../../cli/terminal-style";
import { isBedrockRuntimeEndpoint } from "../../inference/bedrock-runtime";
import { DEFAULT_ROUTE_CREDENTIAL_ENV } from "../../inference/config";
import { validateNvidiaApiKeyValue } from "../../validation";
import { hydrateCredentialEnv } from "../credential-env";
import {
  matchesGatewayProviderBinding,
  readGatewayProviderMetadata,
} from "../gateway-provider-metadata";
import {
  ensureResumeProviderReady as ensureResumeProviderReadyImpl,
  type ResumeProviderRecoveryDeps,
  type ResumeProviderRecoveryResult,
} from "../resume-provider-recovery";

const onboardProviders = require("../providers") as {
  REMOTE_PROVIDER_CONFIG: ResumeProviderRecoveryDeps["remoteProviderConfig"];
  getProviderLabel: ResumeProviderRecoveryDeps["getProviderLabel"];
};

export type ResumeProviderShimDeps = {
  isNonInteractive: ResumeProviderRecoveryDeps["isNonInteractive"];
  providerExistsInGateway(name: string, gatewayName: string): boolean;
  isRoutedInferenceProvider: ResumeProviderRecoveryDeps["isRoutedInferenceProvider"];
  replaceNamedCredential: ResumeProviderRecoveryDeps["replaceNamedCredential"];
  /** Recover an exact gateway-scoped managed runtime; false means no managed owner state exists. */
  resumeManagedLlamaCppRuntime?: (
    sandboxName: string,
    revalidatePolicyRequirements?: (operation: string) => void,
  ) => Promise<boolean>;
};

export function createResumeProviderShim(deps: ResumeProviderShimDeps) {
  return {
    async ensureManagedLlamaCppResumeReady(
      provider: string | null | undefined,
      sandboxName: string | null | undefined,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<boolean> {
      if (provider !== "llama-cpp-local" || !sandboxName || !deps.resumeManagedLlamaCppRuntime) {
        return false;
      }
      return deps.resumeManagedLlamaCppRuntime(sandboxName, revalidatePolicyRequirements);
    },
    async ensureResumeProviderReady(
      gatewayName: string,
      provider: string | null | undefined,
      credentialEnv: string | null | undefined,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<ResumeProviderRecoveryResult> {
      return ensureResumeProviderReadyImpl(provider, credentialEnv, {
        remoteProviderConfig: onboardProviders.REMOTE_PROVIDER_CONFIG,
        defaultRouteCredentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
        isRoutedInferenceProvider: deps.isRoutedInferenceProvider,
        providerExistsInGateway: (name) => deps.providerExistsInGateway(name, gatewayName),
        hydrateCredentialEnv,
        getProviderLabel: onboardProviders.getProviderLabel,
        isNonInteractive: deps.isNonInteractive,
        note: (message) => console.log(`${D}${message}${R}`),
        replaceNamedCredential: deps.replaceNamedCredential,
        revalidatePolicyRequirements,
        validateNvidiaApiKeyValue,
        log: (message) => console.log(message),
        warn: (message) => console.error(message),
        exit: (code) => process.exit(code),
      });
    },
    isResumeProviderSurfaceReady,
  };
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
