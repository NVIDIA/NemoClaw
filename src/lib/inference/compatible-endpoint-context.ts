// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createOpenAiLikeAuthConfig } from "../adapters/http/auth-config";
import { runCurlProbe } from "../adapters/http/probe";
import { getCredential } from "../credentials/store";
import { isLoopbackHostname, isPrivateHostname } from "../private-networks";
import {
  assertEndpointResolvesPublic,
  buildResolvePinArgs,
  type EndpointDnsLookupFn,
} from "./endpoint-ssrf-preflight";
import {
  hasExplicitContextWindow,
  MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  parsePositiveInteger,
} from "./ollama-runtime-context";
import { resolveVllmContextWindowFromModels } from "./vllm-runtime-context";

// Explicit NEMOCLAW_CONTEXT_WINDOW overrides share the auto-detect ceiling so a
// user-supplied window can't bake an implausible value the probed path rejects.
const MAX_COMPATIBLE_CONTEXT_WINDOW = MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW;

// Hosts that only resolve inside the OpenShell sandbox network (or are the
// hijacked docker-internal alias), mirroring probeOpenAiLikeEndpoint's
// SANDBOX_INTERNAL_HOSTS / isHijackedDockerInternalUrl. A host-side GET to these
// cannot reach the real endpoint, so we skip the probe rather than emit a
// misleading warning and let Hermes auto-detect / an explicit override stand.
const NON_HOST_PROBEABLE_HOSTS = new Set(["host.openshell.internal", "host.docker.internal"]);

function isHostProbeableEndpoint(endpointUrl: string): boolean {
  try {
    return !NON_HOST_PROBEABLE_HOSTS.has(new URL(endpointUrl).hostname);
  } catch {
    return false;
  }
}

// SSRF source boundary: true when the endpoint host is a private/internal
// address (and not one of the allowed sandbox-internal aliases, which are
// screened separately by isHostProbeableEndpoint). Reuses the shared
// isPrivateHostname validator so the /v1/models context probe never issues a
// host-side GET to an attacker-reachable private address.
//
// Loopback (127.0.0.0/8, ::1, localhost) is exempt, mirroring the same
// exemption in probeOpenAiLikeEndpoint: a locally-run vLLM/Ollama custom
// endpoint is reached host-side on loopback, and loopback only targets the
// probing host itself, not a pivot to other internal infrastructure. Without
// this the two probes disagreed — the chat-completions validation probe
// allowed the localhost endpoint but this context probe skipped it, so a
// localhost vLLM never propagated its max_model_len (#6177). See PR #6293
// PRA-5 / PRA-19.
function isPrivateEndpoint(endpointUrl: string): boolean {
  try {
    const { hostname } = new URL(endpointUrl);
    return isPrivateHostname(hostname) && !isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/** Injectable `/v1/models` fetcher; returns parsed JSON, or null when unavailable. */
export type CompatibleEndpointModelsFetcher = (
  endpointUrl: string,
  apiKey: string,
  /**
   * SSRF-preflight-validated address(es) to pin the fetch curl to via
   * `--resolve` (TOCTOU/DNS-rebinding defense, #6293). Optional so injected test
   * fakes can ignore it.
   */
  pinnedAddresses?: string[],
) => unknown | null;

export interface ApplyCompatibleEndpointContextWindowOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn">;
  /** Credential env used to authenticate the `/v1/models` probe. */
  credentialEnv?: string | null;
  /** Already-resolved API key; takes precedence over `credentialEnv`. */
  apiKey?: string | null;
  /** Override the default host curl fetch (unit tests inject a fake). */
  fetchModels?: CompatibleEndpointModelsFetcher;
  /** Override credential resolution (unit tests inject a fake). */
  resolveCredential?: (credentialEnv: string) => string | null | undefined;
  /**
   * Injectable DNS resolver for the SSRF preflight run before the host-side
   * `/v1/models` curl. When omitted under the unit-test runner the DNS
   * preflight is skipped (the string-level private check still applies);
   * production uses the real `dns/promises` resolver.
   */
  resolveHost?: EndpointDnsLookupFn;
}

/**
 * GET `<baseUrl>/models` on the host and return the parsed JSON body, or null
 * when the endpoint is unreachable, errors, or returns a non-JSON body. This is
 * the same source vLLM local onboarding reads, generalized to any configured
 * OpenAI-compatible endpoint (custom / `compatible-endpoint`). Auth is sent when
 * the endpoint requires an API key (e.g. a vLLM launched with `--api-key`).
 *
 * Security: this runs host-side during privileged onboarding, before the
 * sandbox and its OpenShell network policy exist, and targets the same endpoint
 * URL the immediately-preceding chat-completions validation probe already
 * reached — so it adds no egress surface beyond that validation. The credential
 * travels in a curl `--config` temp file (0600), never on the argv.
 *
 * SSRF: private/internal endpoints are rejected by the caller
 * (`applyCompatibleEndpointContextWindow`) at the source boundary, before this
 * fetch runs, using the shared `isPrivateHostname` validator — the same guard
 * `probeOpenAiLikeEndpoint` applies. A self-hosted vLLM is reached through the
 * sandbox-internal alias (`host.openshell.internal`), which is skipped
 * separately, not via a raw private-LAN URL. This fetcher therefore only ever
 * sees an already-validated, routable endpoint URL.
 */
export function fetchCompatibleEndpointModels(
  endpointUrl: string,
  apiKey: string,
  pinnedAddresses?: string[],
): unknown | null {
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authConfig = createOpenAiLikeAuthConfig(apiKey || "");
  try {
    const result = runCurlProbe(
      [
        "-sS",
        ...buildResolvePinArgs(`${baseUrl}/models`, pinnedAddresses),
        "--connect-timeout",
        "10",
        "--max-time",
        "15",
        ...authConfig.args,
        `${baseUrl}/models`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles, pinnedAddresses },
    );
    if (!result.ok || !result.body) return null;
    try {
      return JSON.parse(result.body);
    } catch {
      return null;
    }
  } finally {
    authConfig.cleanup();
  }
}

// The value this probe last auto-detected. onboard can re-run provider
// selection (e.g. after a failed `inference set` the user picks a different
// endpoint/model), so a value we set on an earlier pass must not be mistaken
// for a user override on the next — otherwise a stale window from endpoint A
// would be kept for endpoint B. Mirrors the Ollama auto-state contract.
// TODO(#6177): this auto-state tracking mirrors the Ollama contract
// (autoDetectedOllamaContextWindow in ollama-runtime-context.ts). If a third
// provider adopts the same "auto-detected vs user override" pattern, extract a
// shared trackAutoDetectedContextWindow helper instead of duplicating it again.
let autoDetectedCompatibleContextWindow: string | null = null;

/** Test-only: forget any tracked auto value without touching the environment. */
export function resetCompatibleEndpointContextWindowAutoState(): void {
  autoDetectedCompatibleContextWindow = null;
}

/**
 * Drop a value this probe auto-detected on an earlier pass. onboard calls this
 * before each provider-selection pass so that when the user retries away to a
 * different provider, endpoint A's probed `max_model_len` is not left in the
 * environment where `dockerfile-patch` would bake it as if the user had set it.
 * A genuine user-supplied `NEMOCLAW_CONTEXT_WINDOW` (one this probe never wrote)
 * is preserved because it never equals the tracked auto value (#6177).
 */
export function clearAutoDetectedCompatibleContextWindow(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    autoDetectedCompatibleContextWindow &&
    env.NEMOCLAW_CONTEXT_WINDOW === autoDetectedCompatibleContextWindow
  ) {
    delete env.NEMOCLAW_CONTEXT_WINDOW;
  }
  autoDetectedCompatibleContextWindow = null;
}

/**
 * Set `NEMOCLAW_CONTEXT_WINDOW` from a configured OpenAI-compatible endpoint's
 * runtime `max_model_len` so custom / `compatible-endpoint` onboarding no longer
 * falls back to a small architecture-default context (see #6177).
 *
 * - An explicit `NEMOCLAW_CONTEXT_WINDOW` always wins and is never downgraded.
 * - A value this probe set on an earlier pass is not treated as an override; it
 *   is recomputed, or cleared when the new endpoint reports nothing usable.
 * - A sandbox-internal / docker-internal endpoint URL is not host-probeable, so
 *   the probe is skipped and Hermes auto-detect is left in place.
 * - When the endpoint cannot be probed, warn and keep the default context.
 * - Under the unit-test runner the default curl fetch is skipped (endpoints are
 *   unreachable and curl would hang on DNS); pass `fetchModels` to exercise it.
 *
 * Source boundary: `/v1/models` is served by an out-of-repo endpoint the user
 * configured. Invalid states tolerated — unreachable/timing-out host, non-JSON
 * or non-vLLM body, missing/malformed/over-ceiling `max_model_len`, and
 * ambiguous multi-model catalogs — all fall back to Hermes/OpenClaw auto-detect
 * (never throw, never guess). NemoClaw cannot fix the producer, so it validates
 * before consuming. Regression coverage: compatible-endpoint-context.test.ts and
 * the real-server compatible-endpoint-context-probe.test.ts. Remove this probe
 * only if a typed, validated cross-provider model-catalog fetch subsumes it.
 */
export async function applyCompatibleEndpointContextWindow(
  endpointUrl: string,
  model: string | null | undefined,
  options: ApplyCompatibleEndpointContextWindowOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  const currentContextWindow = env.NEMOCLAW_CONTEXT_WINDOW;
  const currentIsPreviousAuto =
    !!currentContextWindow &&
    !!autoDetectedCompatibleContextWindow &&
    currentContextWindow === autoDetectedCompatibleContextWindow;
  const userContextWindow = currentIsPreviousAuto ? null : currentContextWindow;

  const clearPreviousAuto = (): void => {
    if (currentIsPreviousAuto) {
      delete env.NEMOCLAW_CONTEXT_WINDOW;
      autoDetectedCompatibleContextWindow = null;
    }
  };

  if (hasExplicitContextWindow(userContextWindow)) {
    // hasExplicitContextWindow only checks non-emptiness, so a malformed value
    // ("0", "abc", or one above the auto-detect ceiling) would otherwise be
    // kept verbatim and baked into config. Validate it the same way the probed
    // path validates a discovered max_model_len; on an invalid override, warn
    // and fall through to auto-detect instead of honoring an unusable value.
    // See PR #6293 PRA-4 / PRA-7 (Nemotron).
    const parsedOverride = parsePositiveInteger(userContextWindow);
    if (parsedOverride && parsedOverride <= MAX_COMPATIBLE_CONTEXT_WINDOW) {
      logger.log(`  ℹ Keeping configured context window: ${parsedOverride} tokens`);
      return;
    }
    logger.warn(
      `  ⚠ Ignoring invalid NEMOCLAW_CONTEXT_WINDOW="${userContextWindow}"; it must be a ` +
        `positive integer ≤ ${MAX_COMPATIBLE_CONTEXT_WINDOW}. Auto-detecting from the endpoint.`,
    );
    // Drop the unusable override so a failed/skipped probe can't leave it to be
    // baked downstream; auto-detect below re-populates it when the endpoint
    // reports a valid max_model_len.
    delete env.NEMOCLAW_CONTEXT_WINDOW;
  }

  // A sandbox-internal endpoint (e.g. host.openshell.internal) resolves only
  // inside the sandbox, so a host-side GET cannot reach it; skip cleanly and
  // leave Hermes auto-detect rather than emit a misleading probe failure.
  if (!isHostProbeableEndpoint(endpointUrl)) {
    clearPreviousAuto();
    return;
  }

  // SSRF source boundary: refuse to probe /v1/models on a private/internal
  // endpoint. This path issues its own host-side GET independent of the
  // chat-completions validation probe, so it must screen the URL itself with
  // the shared isPrivateHostname validator (defense-in-depth alongside the
  // DNS-pinning config-write boundary). See PR #6293 PRA-1/PRA-3.
  if (isPrivateEndpoint(endpointUrl)) {
    logger.warn(
      "  ⚠ Endpoint host is a private/internal address; skipping the /v1/models " +
        "context probe. Use a routable public URL to auto-detect the context window.",
    );
    clearPreviousAuto();
    return;
  }

  const fetchModels = options.fetchModels;

  // DNS-backed SSRF: the string-level isPrivateEndpoint check above only sees
  // literal IPs and reserved names. This host-side GET is its own curl boundary
  // (independent of the chat-completions validation probe), so always run the
  // resolver preflight — a public-looking name that resolves to loopback/
  // link-local/RFC1918 is refused before the fetch. It defaults to the real
  // dns/promises resolver (assertEndpointResolvesPublic); tests inject
  // options.resolveHost. No env-gated bypass: an ambient VITEST flag must never
  // disable SSRF enforcement (cv review, PR #6293).
  const preflight = await assertEndpointResolvesPublic(endpointUrl, options.resolveHost);
  if (!preflight.ok) {
    logger.warn(
      `  ⚠ ${preflight.reason}; skipping the /v1/models context probe. ` +
        "Use a routable public URL to auto-detect the context window.",
    );
    clearPreviousAuto();
    return;
  }

  const resolveCredential = options.resolveCredential ?? getCredential;
  const apiKey =
    options.apiKey ?? (options.credentialEnv ? resolveCredential(options.credentialEnv) : "") ?? "";

  // Pin the /v1/models fetch to the address(es) the preflight just validated so
  // a second DNS lookup in the fetch curl cannot rebind the host to a private
  // address after the public preflight passed (TOCTOU — cv review, #6293).
  const models = (fetchModels ?? fetchCompatibleEndpointModels)(
    endpointUrl,
    apiKey,
    preflight.addresses,
  );
  if (models === null || models === undefined) {
    logger.warn(
      "  ⚠ Could not read the endpoint's /v1/models max_model_len; using the default context " +
        "window. Set NEMOCLAW_CONTEXT_WINDOW to override.",
    );
    clearPreviousAuto();
    return;
  }

  // strictModelMatch: a compatible endpoint can be a shared gateway serving many
  // models, so never guess the first entry's max_model_len for a model that is
  // not an exact /v1/models id — that would bake an unrelated model's window.
  const contextLength = resolveVllmContextWindowFromModels(models, model, logger, {
    strictModelMatch: true,
  });
  if (contextLength === null) {
    clearPreviousAuto();
    return;
  }

  const value = String(contextLength);
  env.NEMOCLAW_CONTEXT_WINDOW = value;
  autoDetectedCompatibleContextWindow = value;
  logger.log(`  ✓ Using endpoint max_model_len: ${value} tokens`);
}
