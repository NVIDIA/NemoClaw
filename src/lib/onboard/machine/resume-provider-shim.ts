// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import {
  recordedRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
} from "../../inference/native-provider/registered";
import { normalizeNativeLocalProviderAttachment } from "../../inference/native-local/profile";
import { gatewayReachableCompatibleEndpointUrl } from "../../inference/native-local/eligibility";
import type { SandboxEntry } from "../../state/registry";
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
  getRemoteProviderConfigForName(name: string): { credentialEnv: string } | null;
};

export type ResumeProviderShimDeps = {
  getSandbox?: (name: string) => Partial<SandboxEntry> | null | undefined;
  providerAdapter?: ReturnType<typeof createManagedProviderAdapter>;
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
      selection?: { sandboxName: string | null; endpointUrl: string | null },
    ): Promise<ResumeProviderRecoveryResult> {
      const recorded =
        provider && selection?.sandboxName ? deps.getSandbox?.(selection.sandboxName) : undefined;
      if (
        provider === NVIDIA_HOSTED_LOGICAL_PROVIDER &&
        recorded?.nativeNvidiaProviderAttachment !== undefined
      ) {
        if (!normalizeNativeNvidiaProviderAttachment(recorded.nativeNvidiaProviderAttachment)) {
          throw new Error("Invalid native NVIDIA provider attachment during resume.");
        }
        // Native setup verifies the live provider identity against its receipt.
        // The logical name is not the credential-bearing gateway provider.
        return {
          forceInferenceSetup: true,
          credentialEnv: credentialEnv || NVIDIA_HOSTED_CREDENTIAL_ENV,
        };
      }
      if (
        provider === "compatible-endpoint" &&
        recorded?.nativeLocalProviderAttachment !== undefined
      ) {
        const expected = normalizeNativeLocalProviderAttachment(
          recorded.nativeLocalProviderAttachment,
        );
        if (
          !expected ||
          expected.gatewayName !== gatewayName ||
          expected.sandboxName !== selection?.sandboxName ||
          expected.provider !== provider ||
          expected.provider !== recorded.provider ||
          (expected.agent ?? "langchain-deepagents-code") !== recorded.agent ||
          expected.endpointUrl !==
            gatewayReachableCompatibleEndpointUrl(provider, selection?.endpointUrl) ||
          (recorded.credentialEnv ?? null) !== (credentialEnv ?? null)
        )
          throw new Error(
            "Native local provider resume selection does not match its recorded binding.",
          );
        // Native setup verifies the immutable gateway provider and retained credential.
        // The logical provider name is not the sandbox-owned provider name.
        return {
          forceInferenceSetup: true,
          credentialEnv: credentialEnv ?? null,
          nativeCustomSetup: true,
          nativeLocalSetup: true,
        };
      }
      if (recorded?.registeredInferenceProviderAttachment !== undefined) {
        const expected = recordedRegisteredInferenceProviderAttachment(recorded);
        if (
          !expected ||
          expected.gatewayName !== gatewayName ||
          expected.sandboxName !== selection?.sandboxName ||
          expected.providerName !== provider ||
          expected.endpointUrl !== selection?.endpointUrl ||
          expected.credentialEnv !== credentialEnv
        )
          throw new Error(
            "Registered provider resume selection does not match its recorded binding.",
          );
        revalidateSandboxIdentity?.("verifying registered provider resume");
        await registeredInferenceProviderRevision({
          adapter: deps.providerAdapter ?? createManagedProviderAdapter(),
          expected,
        });
        revalidateSandboxIdentity?.("verified registered provider resume");
        return {
          forceInferenceSetup: false,
          credentialEnv: expected.credentialEnv,
          registeredNativeSetup: true,
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
        revalidateSandboxIdentity,
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
