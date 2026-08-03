// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardOptions } from "../types";
import type { OnboardIntentDraft } from "./schema";

export const ONBOARD_INTENT_RUNTIME_ENV_KEYS = [
  "NEMOCLAW_AGENT",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_HERMES_AUTH_METHOD",
  "NEMOCLAW_SANDBOX_NAME",
  "NEMOCLAW_WEB_SEARCH_PROVIDER",
  "NEMOCLAW_HERMES_TOOL_GATEWAYS",
  "NEMOCLAW_RESOURCE_PROFILE",
  "NEMOCLAW_CPU",
  "NEMOCLAW_RAM",
  "NEMOCLAW_POLICY_TIER",
  "NEMOCLAW_ONBOARD_INTENT_ACCEPTED",
] as const;

/** Capture the process environment so library callers do not retain draft projection state. */
export function captureOnboardIntentEnvironment(env: NodeJS.ProcessEnv = process.env): () => void {
  const previous = new Map<string, string | undefined>(
    ONBOARD_INTENT_RUNTIME_ENV_KEYS.map((key) => [key, env[key]]),
  );
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

function assignOrDelete(env: NodeJS.ProcessEnv, key: string, value: string | null): void {
  if (value === null || value.length === 0) delete env[key];
  else env[key] = value;
}

/**
 * Atomically project an accepted draft into the existing forward-only
 * materialization inputs. This function never handles credential values.
 */
export function applyAcceptedOnboardIntentDraft(
  draft: OnboardIntentDraft,
  opts: OnboardOptions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (draft.phase !== "accepted") {
    throw new Error("Onboarding intent must be accepted before materialization.");
  }
  const answers = draft.answers;
  if (
    !answers.agent ||
    !answers.inference ||
    !answers.sandbox ||
    answers.web_search === undefined ||
    !answers.messaging ||
    !answers.tools ||
    !answers.resources ||
    !answers.policy
  ) {
    throw new Error("Accepted onboarding intent is incomplete.");
  }

  opts.agent = answers.agent;
  opts.sandboxName = answers.sandbox;
  opts.sandboxGpu = answers.resources.gpu === "auto" ? null : answers.resources.gpu;
  opts.policyTier = answers.policy;

  env.NEMOCLAW_AGENT = answers.agent;
  env.NEMOCLAW_PROVIDER = answers.inference.provider;
  assignOrDelete(env, "NEMOCLAW_MODEL", answers.inference.model);
  assignOrDelete(env, "NEMOCLAW_ENDPOINT_URL", answers.inference.endpointUrl);
  assignOrDelete(env, "NEMOCLAW_HERMES_AUTH_METHOD", answers.inference.authMethod);
  env.NEMOCLAW_SANDBOX_NAME = answers.sandbox;
  env.NEMOCLAW_WEB_SEARCH_PROVIDER = answers.web_search ?? "none";
  env.NEMOCLAW_HERMES_TOOL_GATEWAYS = answers.tools.hermesGateways.join(",");
  env.NEMOCLAW_RESOURCE_PROFILE =
    answers.resources.profile === "custom" ? "default" : answers.resources.profile;
  assignOrDelete(env, "NEMOCLAW_CPU", answers.resources.cpu ?? null);
  assignOrDelete(env, "NEMOCLAW_RAM", answers.resources.memory ?? null);
  env.NEMOCLAW_POLICY_TIER = answers.policy;
  env.NEMOCLAW_ONBOARD_INTENT_ACCEPTED = "1";
}
