// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";

const { probeAnthropicEndpoint, probeOpenAiLikeEndpoint } =
  require("../inference/onboard-probes") as {
    probeAnthropicEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      resolveArgs?: readonly string[],
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
  buildCurlResolveArgs,
  type EndpointDnsLookupFn,
} from "../inference/endpoint-ssrf-preflight";
import { shouldForceCompletionsApi } from "../validation";
import { getProbeRecovery } from "../validation-recovery";
import { summarizeProbeForDisplay } from "./probe-diagnostics";
import { normalizeReasoningFlag } from "./reasoning-mode";

export type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
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
  // during privileged onboarding. On success it returns the `--resolve` curl
  // args that pin the connection to the validated IP, so the probe curls cannot
  // re-resolve (rebind) the hostname. Returns `{ blocked }` (fail-closed) to
  // short-circuit, or `{ blocked: null, resolveArgs }` when it is safe to probe.
  //
  // Gated on an injected resolver rather than an ambient VITEST flag: production
  // wires the real dns/promises resolver at the composition root (onboard.ts);
  // tests inject a fake resolver to exercise it, or omit it to skip (no real
  // DNS). See PR #6293 PRA-3/PRA-4.
  async function preflightCustomEndpoint(
    label: string,
    endpointUrl: string,
    credentialEnv: string | null,
    helpUrl: string | null,
  ): Promise<{ blocked: EndpointValidationResult | null; resolveArgs: string[] }> {
    if (!deps.resolveEndpointHost) return { blocked: null, resolveArgs: [] };
    const preflight = await assertEndpointResolvesPublic(endpointUrl, deps.resolveEndpointHost);
    if (preflight.ok) {
      return {
        blocked: null,
        resolveArgs: buildCurlResolveArgs(endpointUrl, preflight.pinnedAddress),
      };
    }
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
    return { blocked: { ok: false, retry }, resolveArgs: [] };
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
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, options);
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
    const { blocked, resolveArgs } = await preflightCustomEndpoint(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
    );
    if (blocked) return blocked;
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    // Reasoning-only compatible endpoints often reject Responses, tool-call, and streaming probes.
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      requireResponsesToolCalling: !reasoningEnabled,
      skipResponsesProbe:
        reasoningEnabled || shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: !reasoningEnabled,
      // Pin curl to the preflight-validated IP (rebinding-safe); only present
      // when the preflight actually resolved a public name.
      ...(resolveArgs.length > 0 ? { resolveArgs } : {}),
    });
    if (probe.ok) {
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`,
        );
      }
      return { ok: true, api: probe.api ?? "openai-completions" };
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
  ): Promise<EndpointValidationResult> {
    const { blocked, resolveArgs } = await preflightCustomEndpoint(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
    );
    if (blocked) return blocked;
    const apiKey = resolveCredential(credentialEnv);
    // Pass the pinned --resolve args only when the preflight resolved a public
    // name, so the unpinned call shape (and its assertions) is unchanged.
    const probe =
      resolveArgs.length > 0
        ? runAnthropicProbe(endpointUrl, model, apiKey, resolveArgs)
        : runAnthropicProbe(endpointUrl, model, apiKey);
    if (probe.ok) {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
      return { ok: true, api: probe.api };
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
