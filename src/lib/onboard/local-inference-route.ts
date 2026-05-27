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
}

const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  "vllm-local": "Local vLLM",
  "ollama-local": "Local Ollama",
};

// Wraps `openshell inference set` for local providers (ollama-local, vllm-local)
// with the same retry/recovery surface as the remote-provider path. Without this,
// a nonzero exit from `openshell inference set` propagates through runOpenshell
// and calls process.exit() directly, which terminates onboarding mid-step with no
// context — onboarding appears to stop silently after the [4/8] warning. See #4257.
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
      console.error(`  ${detail}`);
      if (deps.isNonInteractive()) {
        // Only surface the resume guidance when we are actually about to exit —
        // printing it on every interactive retry is misleading because the user
        // is still inside an active onboard run.
        console.error(
          "  No sandbox was created. Fix the inference route and re-run " +
            "`nemoclaw onboard --resume` to continue, or choose a different provider/model.",
        );
        process.exit(applyResult.status || 1);
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
