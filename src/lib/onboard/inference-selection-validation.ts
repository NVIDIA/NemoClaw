// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";
import { getCompatibleAnthropicOpenAiSurfaceBaseUrl } from "../inference/config";
import type { TrustedPrivateEndpointCapability } from "../inference/endpoint-ssrf-preflight";
import type { OnboardInferenceCapabilityCache } from "./inference-capability-cache";

const { probeAnthropicEndpoint, probeOpenAiLikeEndpointOptimized } =
  require("../inference/onboard-probes") as {
    probeAnthropicEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      options?: {
        probeStreaming?: boolean;
        requireStreamingToolCalling?: boolean;
        pinnedAddresses?: readonly string[];
        trustedPrivateCapability?: TrustedPrivateEndpointCapability;
      },
    ): any;
    probeOpenAiLikeEndpointOptimized(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      options?: Record<string, unknown>,
    ): Promise<any>;
  };

type OpenAiLikeProbe = (
  endpointUrl: string,
  model: string,
  apiKey: string | null | undefined,
  options?: Record<string, unknown>,
) => any | Promise<any>;

import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
  parseTrustedPrivateInferenceHostsFromEnv,
} from "../inference/endpoint-ssrf-preflight";
import { shouldForceCompletionsApi } from "../validation";
import {
  getProbeRecovery,
  getTransportRecoveryMessage,
  type ProbeLike,
} from "../validation-recovery";
import { summarizeProbeForDisplay } from "./probe-diagnostics";
import { normalizeReasoningFlag } from "./reasoning-mode";
import { OnboardDeferredExitError } from "./session-bootstrap";

export type EndpointValidationResult =
  | {
      ok: true;
      api: string | null;
      retry?: undefined;
      /** Public addresses approved for this custom endpoint's host probes. */
      pinnedAddresses?: string[];
      /** Non-forgeable proof of the exact host and complete pins admitted by the operator allowlist. */
      trustedPrivateCapability?: TrustedPrivateEndpointCapability;
    }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

export interface OpenAiSelectionValidationOptions {
  /** In-memory credential for managed local endpoints; never read from ambient env. */
  apiKey?: string | null;
  /** Approved no-DNS endpoint pin; [] also disables ambient proxies for managed IP URLs. */
  pinnedAddresses?: readonly string[];
  trustedPrivateCapability?: TrustedPrivateEndpointCapability;
  authMode?: "bearer" | "query-param";
  extraHeaders?: readonly string[];
  requireResponsesToolCalling?: boolean;
  requireChatCompletionsToolCalling?: boolean;
  retryChatCompletionsToolReadiness?: boolean;
  useNvidiaEndpointProbePayload?: boolean;
  /** Provider identity used only for safe, provider-specific diagnostics. */
  provider?: string;
  revalidateSandboxIdentity?: (operation: string) => void;

  skipResponsesProbe?: boolean;
  probeStreaming?: boolean;
  allowHostDockerInternal?: boolean;
  probeFromDocker?: { expectedPort: number } | null;
  capabilityCache?: OnboardInferenceCapabilityCache;
}

export interface InferenceSelectionValidationDeps {
  isNonInteractive(): boolean;
  agentProductName(): string;
  getCredential?: typeof getCredential;
  probeAnthropicEndpoint?: typeof probeAnthropicEndpoint;
  probeOpenAiLikeEndpoint?: OpenAiLikeProbe;
  /** Injectable DNS resolver for the custom-endpoint SSRF preflight (tests). */
  resolveEndpointHost?: EndpointDnsLookupFn;
  /** Exact private endpoint hosts trusted by the operator (tests may inject this). */
  trustedPrivateEndpointHosts?: readonly string[];
  /**
   * Optional abort teardown hook for tests. Production loads the helper lazily
   * so openshell binaries stay out of the validation unit graph.
   */
  teardownOrphanManagedGatewayOnAbort?: () => boolean;
  promptValidationRecovery(
    label: string,
    recovery: ReturnType<typeof getProbeRecovery>,
    credentialEnv?: string | null,
    helpUrl?: string | null,
    revalidateSandboxIdentity?: (operation: string) => void,
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
    options?: OpenAiSelectionValidationOptions,
  ): Promise<EndpointValidationResult>;
  validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage?: string,
    helpUrl?: string | null,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<EndpointValidationResult>;
  validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
    capabilityCache?: OnboardInferenceCapabilityCache,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<EndpointValidationResult>;
  validateCustomAnthropicSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
    options?: {
      intendedApi?: "anthropic-messages" | "openai-completions";
      revalidateSandboxIdentity?: (operation: string) => void;
    },
  ): Promise<EndpointValidationResult>;
}

function printOpenAiSurfaceGuidance(): void {
  console.error(
    "  This agent needs an endpoint that serves the OpenAI Chat Completions API (/v1/chat/completions).",
  );
  console.error("  The selected Anthropic-compatible endpoint does not serve it.");
  console.error("  Use an OpenAI-compatible endpoint, or switch to an Anthropic-native agent:");
  console.error("  `nemoclaw onboard --agent openclaw`.");
}

export function createInferenceSelectionValidationHelpers(
  deps: InferenceSelectionValidationDeps,
): InferenceSelectionValidationHelpers {
  const resolveCredential = deps.getCredential ?? getCredential;
  const runAnthropicProbe = deps.probeAnthropicEndpoint ?? probeAnthropicEndpoint;
  const runOpenAiLikeProbe = deps.probeOpenAiLikeEndpoint ?? probeOpenAiLikeEndpointOptimized;
  const trustedPrivateEndpointHosts =
    deps.trustedPrivateEndpointHosts ?? parseTrustedPrivateInferenceHostsFromEnv(process.env);

  function exitNonInteractiveValidationFailure(): never {
    // #8952: tear down an unowned managed gateway before fatal exit.
    let gatewayCleanupComplete = false;
    try {
      const teardown =
        deps.teardownOrphanManagedGatewayOnAbort ??
        (() => {
          const { teardownOrphanManagedGatewayOnAbort } =
            require("./gateway-destroy") as typeof import("./gateway-destroy");
          return teardownOrphanManagedGatewayOnAbort();
        });
      gatewayCleanupComplete = teardown();
    } catch (error) {
      // Helper never throws; this covers require/load / inject failures.
      console.error(
        `  Gateway teardown after onboard abort failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
    throw new OnboardDeferredExitError(1, {
      preserveIncompleteSession: gatewayCleanupComplete,
    });
  }

  function printValidationFailure(
    label: string,
    probe?: { failures?: unknown[]; message?: unknown; advisory?: unknown },
  ): void {
    console.error(`  ${label} endpoint validation failed.`);
    if (probe) console.error(`  Validation probe summary: ${summarizeProbeForDisplay(probe)}.`);
    console.error("  Validation details were omitted to avoid exposing credentials.");
    if (!probe) return;
    // An interactive run reaches transport guidance through the recovery
    // prompt. A non-interactive run exits at the next statement, so without
    // this the operator is left with a bare "curl exit 28" and no next step.
    if (deps.isNonInteractive()) {
      const recovery = getProbeRecovery(probe as ProbeLike);
      if (recovery.kind === "transport" && "failure" in recovery) {
        console.error(getTransportRecoveryMessage(recovery.failure));
      }
    }
    // The probe's curated advisory rides on `message`, which no caller prints
    // because it can carry provider response bodies. Neither path shows it
    // today, so print it here for both (#10413).
    if (typeof probe.advisory === "string" && probe.advisory) {
      console.error(`  ${probe.advisory}`);
    }
  }

  function printGeminiRuntimeNotFoundGuidance(
    provider: string | undefined,
    probe: { failures?: unknown[] },
  ): void {
    if (provider !== "gemini-api" || !Array.isArray(probe.failures)) return;
    const chatNotFound = probe.failures.some((failure) => {
      if (!failure || typeof failure !== "object") return false;
      const { name, httpStatus } = failure as Record<string, unknown>;
      return (
        typeof name === "string" && name.startsWith("Chat Completions API") && httpStatus === 404
      );
    });
    if (!chatNotFound) return;
    console.error(
      "  This 404 came from Google's OpenAI-compatible Chat Completions runtime route, not the native /v1beta/models catalog.",
    );
    console.error(
      "  NemoClaw cannot continue from catalog availability alone because the sandbox uses that Chat Completions route at runtime.",
    );
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
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<
    | { blocked: EndpointValidationResult }
    | {
        pinnedAddresses?: string[];
        trustedPrivateCapability?: TrustedPrivateEndpointCapability;
      }
  > {
    // Always run the SSRF preflight. An explicit exact-host allowlist may admit
    // an operator-owned private endpoint, but it does not skip DNS resolution,
    // pinning, or fail-closed resolver handling (#6861).
    const preflight = await assertEndpointResolvesPublic(endpointUrl, deps.resolveEndpointHost, {
      trustedPrivateHosts: trustedPrivateEndpointHosts,
    });
    // On success, carry the validated address set forward so the probe pins its
    // connection (curl --resolve) to a checked address; a second DNS lookup at
    // the probe could otherwise rebind to a private/internal address after this
    // public preflight (TOCTOU — cv review, #6293).
    if (preflight.ok) {
      if (preflight.trustedPrivateEndpoint) {
        console.warn(
          "  ⚠ Using an operator-trusted private inference endpoint; keep " +
            "trusted-private host configuration restricted to infrastructure you control.",
        );
      }
      return {
        pinnedAddresses: preflight.addresses,
        ...(preflight.trustedPrivateCapability
          ? { trustedPrivateCapability: preflight.trustedPrivateCapability }
          : {}),
      };
    }
    const reason = preflight.reason ?? "endpoint resolves to a private/internal address";
    // A preflight failure because the host does not resolve (an unreachable /
    // non-existent endpoint) is a transport failure, not an endpoint-policy
    // rejection. Mark it with curl's "could not resolve host" status (6) so it
    // routes through the transport recovery path — a DNS/VPN/endpoint-URL hint
    // plus a retry/back/exit prompt — instead of silently looping back to
    // provider selection. A private-IP SSRF block keeps status 0: it resolved
    // fine, the address is just refused. (#6854)
    const unresolvedHost = /cannot resolve endpoint host|did not resolve to any address/i.test(
      reason,
    );
    const syntheticProbe = {
      ok: false as const,
      message: reason,
      failures: [
        {
          name: "SSRF preflight",
          httpStatus: 0,
          curlStatus: unresolvedHost ? 6 : 0,
          message: reason,
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
      revalidateSandboxIdentity,
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
    options: OpenAiSelectionValidationOptions = {},
  ): Promise<EndpointValidationResult> {
    const { apiKey: explicitApiKey, provider, ...probeOptions } = options;
    const apiKey =
      explicitApiKey !== undefined
        ? explicitApiKey
        : credentialEnv
          ? resolveCredential(credentialEnv)
          : "";
    const probe = await runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      ...probeOptions,
      calibrateTimeouts: true,
    });
    if (!probe.ok) {
      probeOptions.capabilityCache?.invalidate();
      printValidationFailure(label, probe);
      printGeminiRuntimeNotFoundGuidance(provider, probe);
      if (deps.isNonInteractive()) {
        exitNonInteractiveValidationFailure();
      }
      const retry = await deps.promptValidationRecovery(
        label,
        getProbeRecovery(probe),
        credentialEnv,
        helpUrl,
        options.revalidateSandboxIdentity,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    options.revalidateSandboxIdentity?.("report validated inference endpoint");
    if (probe.note) {
      console.log(`  ℹ ${probe.note}`);
    } else {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    }
    const api = probe.api ?? "openai-completions";
    if (api === "openai-completions" && probe.validated !== false) {
      probeOptions.capabilityCache?.rememberCompletedOpenAiChat({
        endpointUrl,
        model,
        authMode: probeOptions.authMode,
        requireChatCompletionsToolCalling: probeOptions.requireChatCompletionsToolCalling,
        extraHeaders: probeOptions.extraHeaders,
        pinnedAddresses: probeOptions.pinnedAddresses,
        trustedPrivateCapability: probeOptions.trustedPrivateCapability,
      });
    }
    return { ok: true, api };
  }

  async function validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage = "Please choose a provider/model again.",
    helpUrl: string | null = null,
    revalidateSandboxIdentity?: (operation: string) => void,
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
        revalidateSandboxIdentity,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    revalidateSandboxIdentity?.("report validated inference endpoint");
    console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }

  async function validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null = null,
    capabilityCache?: OnboardInferenceCapabilityCache,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<EndpointValidationResult> {
    const preflight = await preflightCustomEndpointOrFail(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
      revalidateSandboxIdentity,
    );
    if ("blocked" in preflight) return preflight.blocked;
    const { pinnedAddresses, trustedPrivateCapability } = preflight;
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    // Reasoning-only compatible endpoints often reject Responses, tool-call, and streaming probes.
    const probe = await runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      calibrateTimeouts: true,
      requireResponsesToolCalling: !reasoningEnabled,
      skipResponsesProbe:
        reasoningEnabled || shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: !reasoningEnabled,
      pinnedAddresses,
      trustedPrivateCapability,
    });
    if (probe.ok) {
      revalidateSandboxIdentity?.("report validated inference endpoint");
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`,
        );
      }
      const api = probe.api ?? "openai-completions";
      if (api === "openai-completions" && probe.validated !== false) {
        capabilityCache?.rememberCompletedOpenAiChat({
          endpointUrl,
          model,
          pinnedAddresses,
          trustedPrivateCapability,
        });
      }
      return {
        ok: true,
        api,
        pinnedAddresses,
        ...(trustedPrivateCapability ? { trustedPrivateCapability } : {}),
      };
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
      revalidateSandboxIdentity,
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
      revalidateSandboxIdentity?: (operation: string) => void;
    } = {},
  ): Promise<EndpointValidationResult> {
    const preflight = await preflightCustomEndpointOrFail(
      label,
      endpointUrl,
      credentialEnv,
      helpUrl,
      options.revalidateSandboxIdentity,
    );
    if ("blocked" in preflight) return preflight.blocked;
    const { pinnedAddresses, trustedPrivateCapability } = preflight;
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    const intendedApi = options.intendedApi ?? "anthropic-messages";
    // Validate the protocol surface that the selected agent will actually use.
    // Hermes routes custom Anthropic providers through the managed OpenAI
    // frontend, while native Anthropic consumers require strict SSE validation
    // for duplicate/missing/out-of-order events (#6289) and a native tool_use
    // result rather than JSON-shaped assistant text (#7967).
    const probe =
      intendedApi === "openai-completions"
        ? await runOpenAiLikeProbe(
            getCompatibleAnthropicOpenAiSurfaceBaseUrl(endpointUrl),
            model,
            apiKey,
            {
              calibrateTimeouts: true,
              skipResponsesProbe: true,
              pinnedAddresses,
              trustedPrivateCapability,
            },
          )
        : runAnthropicProbe(endpointUrl, model, apiKey, {
            // Reasoning-only compatible endpoints often reject streaming probes,
            // so mirror the custom OpenAI-compatible path and skip streaming.
            probeStreaming: !reasoningEnabled,
            requireStreamingToolCalling: !reasoningEnabled,
            pinnedAddresses,
            trustedPrivateCapability,
          });
    if (probe.ok) {
      options.revalidateSandboxIdentity?.("report validated inference endpoint");
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${intendedApi}.`,
        );
      }
      return {
        ok: true,
        api: intendedApi,
        pinnedAddresses,
        ...(trustedPrivateCapability ? { trustedPrivateCapability } : {}),
      };
    }
    printValidationFailure(label, probe);
    const recovery = getProbeRecovery(probe, { allowModelRetry: true });
    if (intendedApi === "openai-completions" && recovery.kind === "endpoint") {
      printOpenAiSurfaceGuidance();
    }
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
    }
    const retry = await deps.promptValidationRecovery(
      label,
      recovery,
      credentialEnv,
      helpUrl,
      options.revalidateSandboxIdentity,
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
