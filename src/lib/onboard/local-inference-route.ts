// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { getProbeRecovery } from "../validation-recovery";
import type { OpenShellInferenceRouteMutator } from "../adapters/openshell/inference-route";

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
