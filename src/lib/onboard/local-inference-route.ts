// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { getProbeRecovery } from "../validation-recovery";

export interface LocalInferenceRouteDeps {
  runOpenshell(
    args: string[],
    options: { ignoreError: true },
  ): { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null };
  isNonInteractive(): boolean;
  promptValidationRecovery(
    label: string,
    recovery: ReturnType<typeof getProbeRecovery>,
    credentialEnv?: string | null,
    helpUrl?: string | null,
  ): Promise<"credential" | "selection" | "retry" | "model">;
  classifyApplyFailure(message: string): ReturnType<typeof getProbeRecovery>;
  compactText(value: string): string;
  redact(value: string): string;
  localInferenceTimeoutSecs: number;
  error(message: string): void;
  exitProcess(code: number): never;
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
    const args = [
      "inference",
      "set",
      "--no-verify",
      "--provider",
      provider,
      "--model",
      model,
      "--timeout",
      String(deps.localInferenceTimeoutSecs),
    ];
    while (true) {
      const applyResult = deps.runOpenshell(args, { ignoreError: true });
      if (applyResult.status === 0) {
        return false;
      }
      const detail =
        deps.compactText(deps.redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
        `Failed to configure inference provider '${provider}'.`;
      deps.error(`  ${detail}`);
      if (deps.isNonInteractive()) {
        // Only surface the resume guidance when we are actually about to exit —
        // printing it on every interactive retry is misleading because the user
        // is still inside an active onboard run.
        deps.error(
          "  No sandbox was created. Fix the inference route and re-run " +
            "`nemoclaw onboard --resume` to continue, or choose a different provider/model.",
        );
        return deps.exitProcess(applyResult.status || 1);
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
