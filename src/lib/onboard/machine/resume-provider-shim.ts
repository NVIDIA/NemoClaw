// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { runOpenshell } from "../../adapters/openshell/runtime";
import {
  normalizeNativeNvidiaProviderAttachment,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
} from "../../inference/native-nvidia/contract";
import {
  recordedCustomCredentialEnv,
  usesCustomNativeOnboarding,
} from "../../inference/native-provider/custom-setup";
import { D, R } from "../../cli/terminal-style";
import { isBedrockRuntimeEndpoint } from "../../inference/bedrock-runtime";
import { DEFAULT_ROUTE_CREDENTIAL_ENV } from "../../inference/config";
import { recordedNativeProviderAttachment } from "../../inference/native-provider/recorded-selection";
import { validateNvidiaApiKeyValue } from "../../validation";
import { hydrateCredentialEnv } from "../credential-env";
import { resolveSandboxGatewayName } from "../gateway-binding/identity";
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
  getRemoteProviderConfigForName(name: string): { credentialEnv: string } | null;
};

export type ResumeProviderShimDeps = {
  getSandbox?: (
    name: string,
  ) =>
    | (NonNullable<Parameters<typeof usesCustomNativeOnboarding>[3]> &
        Parameters<typeof recordedNativeProviderAttachment>[0] &
        NonNullable<Parameters<typeof resolveSandboxGatewayName>[0]>)
    | null
    | undefined;
  isNonInteractive: ResumeProviderRecoveryDeps["isNonInteractive"];
  providerExistsInGateway(name: string, gatewayName: string): boolean | Promise<boolean>;
  isRoutedInferenceProvider: ResumeProviderRecoveryDeps["isRoutedInferenceProvider"];
  replaceNamedCredential: ResumeProviderRecoveryDeps["replaceNamedCredential"];
  /** Recover an exact gateway-scoped managed runtime; false means no managed owner state exists. */
  resumeManagedLlamaCppRuntime?: (
    sandboxName: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ) => Promise<boolean>;
};

export function createResumeProviderShim(deps: ResumeProviderShimDeps) {
  return {
    async ensureManagedLlamaCppResumeReady(
      provider: string | null | undefined,
      sandboxName: string | null | undefined,
      revalidateSandboxIdentity?: (operation: string) => void,
    ): Promise<boolean> {
      if (provider !== "llama-cpp-local" || !sandboxName || !deps.resumeManagedLlamaCppRuntime) {
        return false;
      }
      return deps.resumeManagedLlamaCppRuntime(sandboxName, revalidateSandboxIdentity);
    },
    async ensureResumeProviderReady(
      gatewayName: string,
      provider: string | null | undefined,
      credentialEnv: string | null | undefined,
      revalidateSandboxIdentity?: (operation: string) => void,
      selection?: {
        sandboxName: string | null;
        endpointUrl: string | null;
        recoverRecordedProvider?: boolean;
      },
    ): Promise<ResumeProviderRecoveryResult & { nativeNvidiaRecovery?: boolean }> {
      const recorded =
        provider && selection?.sandboxName ? deps.getSandbox?.(selection.sandboxName) : undefined;
      const recoverRegisteredProvider = () =>
        ensureResumeProviderReadyImpl(provider, credentialEnv, {
          remoteProviderConfig: onboardProviders.REMOTE_PROVIDER_CONFIG,
          defaultRouteCredentialEnv: DEFAULT_ROUTE_CREDENTIAL_ENV,
          isRoutedInferenceProvider: deps.isRoutedInferenceProvider,
          providerExistsInGateway: (name) => deps.providerExistsInGateway(name, gatewayName),
          hydrateCredentialEnv,
          getProviderLabel: onboardProviders.getProviderLabel,
          isNonInteractive: deps.isNonInteractive,
          note: (message) => console.log(`${D}${message}${R}`),
          replaceNamedCredential: deps.replaceNamedCredential,
          revalidateSandboxIdentity,
          validateNvidiaApiKeyValue,
          log: (message) => console.log(message),
          warn: (message) => console.error(message),
          exit: (code) => process.exit(code),
        });
      if (
        provider === NVIDIA_HOSTED_LOGICAL_PROVIDER &&
        recorded?.nativeNvidiaProviderAttachment !== undefined
      ) {
        if (selection?.recoverRecordedProvider) {
          recordedNativeProviderAttachment(recorded);
          if (resolveSandboxGatewayName(recorded) !== gatewayName) {
            throw new Error("Recorded native NVIDIA provider does not match the resume target.");
          }
          credentialEnv = NVIDIA_HOSTED_CREDENTIAL_ENV;
          if (!hydrateCredentialEnv(credentialEnv)) {
            // Re-enter setup with the recorded recovery authority. Its logical
            // name is not the credential-bearing gateway registration.
            return { forceInferenceSetup: true, credentialEnv, nativeNvidiaRecovery: true };
          }
          const recovered = await recoverRegisteredProvider();
          return { ...recovered, forceInferenceSetup: true, credentialEnv };
        }
        if (!normalizeNativeNvidiaProviderAttachment(recorded.nativeNvidiaProviderAttachment)) {
          throw new Error("Invalid native NVIDIA provider attachment during resume.");
        }
        if (selection?.recoverRecordedProvider === false) {
          // A logical gateway provider cannot authorize recovery of a recorded
          // native attachment owned by another session's reservation.
          throw new Error("Recorded native NVIDIA provider recovery is not authorized.");
        }
        // Native setup verifies the live provider identity against its receipt.
        // The logical name is not the credential-bearing gateway provider.
        return {
          forceInferenceSetup: true,
          credentialEnv: credentialEnv || NVIDIA_HOSTED_CREDENTIAL_ENV,
        };
      }
      if (
        provider &&
        selection?.sandboxName &&
        deps.getSandbox &&
        usesCustomNativeOnboarding(provider, selection.endpointUrl, selection.sandboxName, recorded)
      ) {
        // Setup verifies the endpoint-bound receipt and live resource identity.
        // Looking up the logical name here would demand a key before that check.
        return {
          forceInferenceSetup: true,
          credentialEnv:
            credentialEnv ||
            recordedCustomCredentialEnv(
              provider,
              selection.endpointUrl,
              recorded?.nativeHostedProviderAttachment,
            ) ||
            onboardProviders.getRemoteProviderConfigForName(provider)?.credentialEnv ||
            null,
          nativeCustomSetup: true,
        };
      }
      return recoverRegisteredProvider();
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
