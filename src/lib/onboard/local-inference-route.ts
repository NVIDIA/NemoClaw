// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { getProbeRecovery } from "../validation-recovery";
import type { OpenShellInferenceRouteMutator } from "../adapters/openshell/inference-route";
import { OPENROUTER_PROVIDER_NAME } from "../inference/openrouter";
import { LOCAL_INFERENCE_TIMEOUT_ROUTE_PROVIDERS, localInferenceTimeoutRangeError } from "./env";
import type { SandboxMessagingPlan } from "../messaging/manifest";

/** Only shared routes that send the timeout own its range constraint. */
export function localInferenceRouteTimeoutError(
  provider: string,
  usesBedrockRuntimeAdapter: boolean,
): string | null {
  return LOCAL_INFERENCE_TIMEOUT_ROUTE_PROVIDERS.includes(provider) ||
    usesBedrockRuntimeAdapter ||
    provider === OPENROUTER_PROVIDER_NAME
    ? localInferenceTimeoutRangeError()
    : null;
}

export function canResumeInferenceRoute(input: {
  needsBedrockRuntimeAdapter: boolean;
  provider: string;
  hasHostLocalInference: boolean;
  forceProviderSelection: boolean;
  forceInferenceSetup: boolean;
  effectiveResume: boolean;
  selectsNativeLocal: boolean;
  nativeLocalAttached(): boolean;
  routeReady(): boolean;
}): boolean {
  // A ready shared route does not prove a native local provider attachment:
  // another sandbox on a reused gateway can own the same shared route.
  return (
    !input.needsBedrockRuntimeAdapter &&
    input.provider !== OPENROUTER_PROVIDER_NAME &&
    !input.hasHostLocalInference &&
    !input.forceProviderSelection &&
    !input.forceInferenceSetup &&
    input.effectiveResume &&
    input.routeReady() &&
    (!input.selectsNativeLocal || input.nativeLocalAttached())
  );
}

export function shouldRefreshCompatibleEndpointRouteForMessaging(
  provider: string | null,
  selectedMessagingChannels: readonly string[],
  messagingPlan: Pick<SandboxMessagingPlan, "channels"> | null | undefined,
  agentName: string,
  nativeCustomSetup: boolean | undefined,
): boolean {
  const channels = messagingPlan?.channels;
  return (
    !nativeCustomSetup &&
    provider === "compatible-endpoint" &&
    agentName === "openclaw" &&
    (selectedMessagingChannels.length > 0 ||
      (Array.isArray(channels) &&
        channels.some((channel) => channel.active === true && channel.disabled !== true)))
  );
}

export function shouldReuseRetainedOpenRouterCredential(input: {
  provider: string | null;
  forceInferenceSetup: boolean;
  hydratedCredential: string | null | undefined;
}): boolean {
  return (
    input.provider === OPENROUTER_PROVIDER_NAME &&
    !input.forceInferenceSetup &&
    !input.hydratedCredential
  );
}

export interface LocalInferenceRouteDeps {
  inferenceRouteMutator: OpenShellInferenceRouteMutator;
  gatewayName: string;
  isNonInteractive(): boolean;
  promptValidationRecovery(
    label: string,
    recovery: ReturnType<typeof getProbeRecovery>,
    credentialEnv?: string | null,
    helpUrl?: string | null,
  ): Promise<"credential" | "selection" | "retry" | "model">;
  classifyApplyFailure(message: string): ReturnType<typeof getProbeRecovery>;
  localInferenceTimeoutSecs: number;
  error(message: string): void;
  exitProcess(code: number): never;
  exitAmbiguousRouteResult?(code: number): never;
}

const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  "vllm-local": "Local vLLM",
  "ollama-local": "Local Ollama",
};

// Source-of-truth boundary: the invalid state is a failed OpenShell `inference set` route apply.
// OpenShell owns that command result, but cannot own NemoClaw's interactive provider retry and
// selection state, so this adapter translates the failure into onboarding recovery. Regression
// coverage lives in local-inference-route.test.ts and the #4257 onboarding integration tests.
// Remove this adapter when OpenShell exposes equivalent non-terminating interactive recovery, or
// when NemoClaw onboarding no longer owns provider retry/selection.
// Returns true if the user chose to back out to provider selection; false on success.
export function createLocalInferenceRouteApplier(deps: LocalInferenceRouteDeps) {
  return async function applyLocalInferenceRoute(
    provider: string,
    model: string,
  ): Promise<boolean> {
    const label = LOCAL_PROVIDER_LABELS[provider] || provider;
    while (true) {
      const applyResult = await deps.inferenceRouteMutator.setInferenceRoute({
        target: { kind: "named", gatewayName: deps.gatewayName },
        route: { provider, model },
        verification: "skip",
        verificationTimeoutSeconds: deps.localInferenceTimeoutSecs,
      });
      if (applyResult.ok) return false;
      const detail = applyResult.error.message;
      deps.error(`  ${detail}`);
      if (applyResult.ambiguous) {
        deps.error(
          `  The route update result is unknown. Inspect gateway '${deps.gatewayName}' before retrying onboarding.`,
        );
        return (deps.exitAmbiguousRouteResult ?? deps.exitProcess)(1);
      }
      if (deps.isNonInteractive()) {
        // Only surface the resume guidance when we are actually about to exit —
        // printing it on every interactive retry is misleading because the user
        // is still inside an active onboard run.
        deps.error(
          "  No sandbox was created. Fix the inference route and re-run " +
            "`nemoclaw onboard --resume` to continue, or choose a different provider/model.",
        );
        return deps.exitProcess(
          applyResult.error.kind === "command" ? (applyResult.error.exitCode ?? 1) : 1,
        );
      }
      const retry = await deps.promptValidationRecovery(
        label,
        deps.classifyApplyFailure(detail),
        null,
        null,
      );
      if (retry === "credential" || retry === "retry") {
        continue;
      }
      return true;
    }
  };
}
