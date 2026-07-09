// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../inference/config";

const { probeAnthropicEndpoint, probeOpenAiLikeEndpoint } =
  require("../inference/onboard-probes") as {
    probeAnthropicEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      options?: { probeStreaming?: boolean; pinnedAddresses?: readonly string[] },
    ): any;
    probeOpenAiLikeEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      options?: Record<string, unknown>,
    ): any;
  };

import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
} from "../inference/endpoint-ssrf-preflight";
import { shouldForceCompletionsApi } from "../validation";
import { getProbeRecovery } from "../validation-recovery";
import { summarizeProbeForDisplay } from "./probe-diagnostics";
import { normalizeReasoningFlag } from "./reasoning-mode";

export type EndpointValidationResult =
  | {
      ok: true;
      api: string | null;
      retry?: undefined;
      /** Public addresses approved for this custom endpoint's host probes. */
      pinnedAddresses?: string[];
    }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

export interface InferenceSelectionValidationDeps {
  isNonInteractive(): boolean;
  agentProductName(): string;
  getCredential?: typeof getCredential;
  probeAnthropicEndpoint?: typeof probeAnthropicEndpoint;
  probeOpenAiLikeEndpoint?: typeof probeOpenAiLikeEndpoint;
  /** Injectable DNS resolver for the custom-endpoint SSRF preflight (tests). */
  resolveEndpointHost?: EndpointDnsLookupFn;
  promptValidationRecovery(
    label: string,
    recovery: ReturnType<typeof getProbeRecovery>,
    credentialEnv?: string | null,
    helpUrl?: string | null,
  ): Promise<"credential" | "selection" | "retry" | "model">;
}

export interface InferenceSelectionValidationHelpers {
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv?: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: {
      authMode?: "bearer" | "query-param";
      requireResponsesToolCalling?: boolean;
      requireChatCompletionsToolCalling?: boolean;
      skipResponsesProbe?: boolean;
      probeStreaming?: boolean;
      allowHostDockerInternal?: boolean;
    },
  ): Promise<EndpointValidationResult>;
  validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage?: string,
    helpUrl?: string | null,
  ): Promise<EndpointValidationResult>;
  validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
  ): Promise<EndpointValidationResult>;
  validateCustomAnthropicSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
    options?: {
      intendedApi?: "anthropic-messages" | "openai-completions";
    },
  ): Promise<EndpointValidationResult>;
}

export function createInferenceSelectionValidationHelpers(
  deps: InferenceSelectionValidationDeps,
): InferenceSelectionValidationHelpers {
  const resolveCredential = deps.getCredential ?? getCredential;
  const runAnthropicProbe = deps.probeAnthropicEndpoint ?? probeAnthropicEndpoint;
  const runOpenAiLikeProbe = deps.probeOpenAiLikeEndpoint ?? probeOpenAiLikeEndpoint;

  function exitNonInteractiveValidationFailure(): never {
    process.exitCode = 1;
    (process.exit as (code?: number) => void)(1);
    throw new Error("Non-interactive endpoint validation failed.");
  }

  function printValidationFailure(
    label: string,
    probe?: { failures?: unknown[]; message?: unknown },
  ): void {
    console.error(`  ${label} endpoint validation failed.`);
    if (probe) console.error(`  Validation probe summary: ${summarizeProbeForDisplay(probe)}.`);
    console.error("  Validation details were omitted to avoid exposing credentials.");
  }

  // DNS-backed SSRF preflight for user-supplied custom endpoints. Resolves the
  // endpoint host and fails closed before any host-side probe curl when it (or
  // a resolved address) is private/reserved, so a public-looking name that
  // resolves to loopback/link-local/RFC1918 cannot reach internal services
  // during privileged onboarding. Returns a fail-closed EndpointValidationResult
  // to short-circuit the caller, or null when the endpoint is safe to probe.
  // See PR #6293 PRA-4.
  async function preflightCustomEndpointOrFail(
    label: string,
    endpointUrl: string,
    credentialEnv: string | null,
    helpUrl: string | null,
  ): Promise<{ blocked: EndpointValidationResult } | { pinnedAddresses?: string[] }> {
    // Always run the SSRF preflight. It defaults to the real dns/promises
    // resolver; tests inject deps.resolveEndpointHost. No env-gated bypass — an
    // ambient VITEST flag must never disable SSRF enforcement (cv review, #6293).
    const preflight = await assertEndpointResolvesPublic(endpointUrl, deps.resolveEndpointHost);
    // On success, carry the validated address set forward so the probe pins its
    // connection (curl --resolve) to a checked address; a second DNS lookup at
    // the probe could otherwise rebind to a private/internal address after this
    // public preflight (TOCTOU — cv review, #6293).
    if (preflight.ok) return { pinnedAddresses: preflight.addresses };
    const syntheticProbe = {
      ok: false as const,
      message: preflight.reason,
      failures: [
        {
          name: "SSRF preflight",
          httpStatus: 0,
          curlStatus: 0,
          message: preflight.reason ?? "endpoint resolves to a private/internal address",
          body: "",
        },
      ],
    };
    printValidationFailure(label, syntheticProbe);
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
    }
    const retry = await deps.promptValidationRecovery(
      label,
      getProbeRecovery(syntheticProbe),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log("  Please choose a provider/model again.");
      console.log("");
    }
    return { blocked: { ok: false, retry } };
  }

  async function validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null = null,
    retryMessage = "Please choose a provider/model again.",
    helpUrl: string | null = null,
    options: {
      authMode?: "bearer" | "query-param";
      requireResponsesToolCalling?: boolean;
      requireChatCompletionsToolCalling?: boolean;
      skipResponsesProbe?: boolean;
      probeStreaming?: boolean;
      allowHostDockerInternal?: boolean;
    } = {},
  ): Promise<EndpointValidationResult> {
    const apiKey = credentialEnv ? resolveCredential(credentialEnv) : "";
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      ...options,
      calibrateTimeouts: true,
    });
    if (!probe.ok) {
      printValidationFailure(label, probe);
      if (deps.isNonInteractive()) {
        exitNonInteractiveValidationFailure();
      }
      const retry = await deps.promptValidationRecovery(
        label,
        getProbeRecovery(probe),
        credentialEnv,
        helpUrl,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    if (probe.note) {
      console.log(`  ℹ ${probe.note}`);
    } else {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    }
    return { ok: true, api: probe.api ?? "openai-completions" };
  }

  async function validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage = "Please choose a provider/model again.",
    helpUrl: string | null = null,
  ): Promise<EndpointValidationResult> {
    const apiKey = resolveCredential(credentialEnv);
    const probe = runAnthropicProbe(endpointUrl, model, apiKey);
    if (!probe.ok) {
      printValidationFailure(label, probe);
      if (deps.isNonInteractive()) {
        exitNonInteractiveValidationFailure();
      }
      const retry = await deps.promptValidationRecovery(
        label,
        getProbeRecovery(probe),
        credentialEnv,
        helpUrl,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }

  async function validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null = null,
  ): Promise<EndpointValidationResult> {
    const preflight = await preflightCustomEndpointOrFail(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
    );
    if ("blocked" in preflight) return preflight.blocked;
    const { pinnedAddresses } = preflight;
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    // Reasoning-only compatible endpoints often reject Responses, tool-call, and streaming probes.
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      calibrateTimeouts: true,
      requireResponsesToolCalling: !reasoningEnabled,
      skipResponsesProbe:
        reasoningEnabled || shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: !reasoningEnabled,
      pinnedAddresses,
    });
    if (probe.ok) {
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`,
        );
      }
      return { ok: true, api: probe.api ?? "openai-completions", pinnedAddresses };
    }
    printValidationFailure(label, probe);
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
    }
    const retry = await deps.promptValidationRecovery(
      label,
      getProbeRecovery(probe, { allowModelRetry: true }),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log("  Please choose a provider/model again.");
      console.log("");
    }
    return { ok: false, retry };
  }

  async function validateCustomAnthropicSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null = null,
    options: {
      intendedApi?: "anthropic-messages" | "openai-completions";
    } = {},
  ): Promise<EndpointValidationResult> {
    const preflight = await preflightCustomEndpointOrFail(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
    );
    if ("blocked" in preflight) return preflight.blocked;
    const { pinnedAddresses } = preflight;
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    const intendedApi = options.intendedApi ?? "anthropic-messages";
    // Validate the protocol surface that the selected agent will actually use.
    // Hermes routes custom Anthropic providers through the managed OpenAI
    // frontend, while native Anthropic consumers require strict SSE validation
    // for duplicate/missing/out-of-order events (#6289).
    const probe =
      intendedApi === "openai-completions"
        ? runOpenAiLikeProbe(
            getCompatibleAnthropicOpenAiSurfaceBaseUrl(endpointUrl),
            model,
            apiKey,
            { calibrateTimeouts: true, skipResponsesProbe: true, pinnedAddresses },
          )
        : runAnthropicProbe(endpointUrl, model, apiKey, {
            // Reasoning-only compatible endpoints often reject streaming probes,
            // so mirror the custom OpenAI-compatible path and skip streaming.
            probeStreaming: !reasoningEnabled,
            pinnedAddresses,
          });
    if (probe.ok) {
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${intendedApi}.`,
        );
      }
      return { ok: true, api: intendedApi, pinnedAddresses };
    }
    printValidationFailure(label, probe);
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
    }
    const retry = await deps.promptValidationRecovery(
      label,
      getProbeRecovery(probe, { allowModelRetry: true }),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log("  Please choose a provider/model again.");
      console.log("");
    }
    return { ok: false, retry };
  }

  return {
    validateOpenAiLikeSelection,
    validateAnthropicSelectionWithRetryMessage,
    validateCustomOpenAiLikeSelection,
    validateCustomAnthropicSelection,
  };
}
