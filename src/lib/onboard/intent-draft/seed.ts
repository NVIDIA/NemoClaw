// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardOptions } from "../types";
import {
  createOnboardIntentDraft,
  type OnboardIntentAnswers,
  type OnboardIntentDraft,
  validateOnboardIntentEndpointUrl,
} from "./schema";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Seed only explicit, non-secret inputs. A seeded choice is still visible on
 * the review screen and can be changed before materialization.
 */
export function seedOnboardIntentDraft(
  opts: Readonly<OnboardOptions>,
  requestedSandboxName: string | null,
  env: NodeJS.ProcessEnv = process.env,
  resolveAgent: (agent: string) => string = (agent) => agent,
): OnboardIntentDraft {
  const answers: OnboardIntentAnswers = {};
  const requestedAgent = optionalString(opts.agent) ?? optionalString(env.NEMOCLAW_AGENT);
  if (requestedAgent) {
    Object.assign(answers, { agent: resolveAgent(requestedAgent) });
  }

  const provider = optionalString(env.NEMOCLAW_PROVIDER);
  if (provider) {
    const rawEndpoint = optionalString(env.NEMOCLAW_ENDPOINT_URL);
    Object.assign(answers, {
      inference: {
        provider,
        model: optionalString(env.NEMOCLAW_MODEL),
        endpointUrl: rawEndpoint ? validateOnboardIntentEndpointUrl(rawEndpoint) : null,
        authMethod: optionalString(env.NEMOCLAW_HERMES_AUTH_METHOD),
      },
    });
  }

  if (requestedSandboxName) Object.assign(answers, { sandbox: requestedSandboxName });

  const webSearch = optionalString(env.NEMOCLAW_WEB_SEARCH_PROVIDER);
  if (webSearch) {
    Object.assign(answers, { web_search: webSearch === "none" ? null : webSearch });
  }

  const resourceProfile = optionalString(env.NEMOCLAW_RESOURCE_PROFILE);
  const cpu = optionalString(env.NEMOCLAW_CPU);
  const memory = optionalString(env.NEMOCLAW_RAM);
  const gpu =
    opts.sandboxGpu ??
    (opts.gpu === true && opts.noGpu !== true
      ? "enable"
      : opts.noGpu === true && opts.gpu !== true
        ? "disable"
        : null);
  if (resourceProfile || cpu || memory || gpu) {
    Object.assign(answers, {
      resources: {
        profile: resourceProfile ?? (cpu || memory ? "custom" : "default"),
        gpu: gpu ?? "auto",
        ...(cpu ? { cpu } : {}),
        ...(memory ? { memory } : {}),
      },
    });
  }

  const policy = optionalString(opts.policyTier) ?? optionalString(env.NEMOCLAW_POLICY_TIER);
  if (policy) Object.assign(answers, { policy });

  return createOnboardIntentDraft(answers);
}
