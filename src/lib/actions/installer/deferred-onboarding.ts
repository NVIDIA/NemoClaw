// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeInstallerProvider } from "../../domain/installer/provider";
import { isProviderKeyCredentialCandidate } from "../../inference/provider-key/contract";

export type DeferredOnboardingDecision =
  | "credential-present"
  | "defer"
  | "existing-sandbox"
  | "not-requested"
  | "unsupported-agent"
  | "unsupported-local-model"
  | "unsupported-provider";

export interface DeferredOnboardingPlan {
  agent: string;
  decision: DeferredOnboardingDecision;
  requested: boolean;
}

export interface BuildDeferredOnboardingPlanOptions {
  registeredSandboxCount?: number;
  requested?: boolean;
  runtimeSupported?: boolean;
}

function hasHostedCredential(env: NodeJS.ProcessEnv): boolean {
  if ((env.NVIDIA_INFERENCE_API_KEY ?? "").length > 0) return true;
  if ((env.NVIDIA_API_KEY ?? "").length > 0) return true;
  const providerKey = (env.NEMOCLAW_PROVIDER_KEY ?? "").trim();
  return providerKey.length > 0 && isProviderKeyCredentialCandidate(providerKey);
}

export function buildDeferredOnboardingPlan(
  env: NodeJS.ProcessEnv = {},
  options: BuildDeferredOnboardingPlanOptions = {},
): DeferredOnboardingPlan {
  const registeredSandboxCount = options.registeredSandboxCount ?? 0;
  if (!Number.isInteger(registeredSandboxCount) || registeredSandboxCount < 0) {
    throw new Error("Registered sandbox count must be a non-negative integer");
  }

  const requested = options.requested === true;
  const requestedName = env.NEMOCLAW_AGENT?.trim() || "openclaw";
  if (!requested) {
    return {
      agent: requestedName,
      decision: "not-requested",
      requested: false,
    };
  }
  const result = (decision: DeferredOnboardingDecision): DeferredOnboardingPlan => ({
    agent: requestedName,
    decision,
    requested,
  });

  if (options.runtimeSupported !== true) return result("unsupported-agent");
  if (env.NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE === "1") {
    return result("unsupported-local-model");
  }

  const rawProvider = env.NEMOCLAW_PROVIDER;
  const provider =
    rawProvider === undefined || rawProvider === ""
      ? "build"
      : normalizeInstallerProvider(rawProvider);
  if (provider !== "build" && provider !== "routed") return result("unsupported-provider");
  if (registeredSandboxCount > 0) return result("existing-sandbox");
  if (hasHostedCredential(env)) return result("credential-present");
  return result("defer");
}
