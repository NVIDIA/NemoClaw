// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
} from "../inference/gateway-route-compatibility";
import {
  buildHttpsPinRouteBaseUrl,
  computeHttpsPinRouteId,
  type HttpsPinCredentialProviderType,
  isHttpsPinRuntimeEligible,
} from "../inference/https-pin-runtime";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import { ConfigUrlValidationError } from "../sandbox/config";
import type { ConfigValue } from "../security/credential-filter";
import type { Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import { InferenceSetError } from "./inference-set-error";

/**
 * Custom-route compatibility is intentionally checked twice. The invalid state
 * is a requested endpoint whose DNS-pinned identity differs from the route that
 * passed the preliminary registry check. The source boundary is the
 * operator-supplied `--endpoint-url`; DNS validation is asynchronous, so the
 * synchronous preparation phase cannot safely pin it. Finalization therefore
 * validates the pinned URL against a fresh registry snapshot before any route,
 * config, or registry mutation. The DNS-change regression test in
 * inference-set-gateway-route-containment.test.ts protects this boundary.
 * Collapse these phases only when preparation can consume fully DNS-validated
 * metadata without introducing an earlier mutation or endpoint probe.
 */
export type RegistryInferenceMetadata = Pick<
  SandboxEntry,
  "endpointUrl" | "endpointSource" | "credentialEnv" | "preferredInferenceApi" | "nimContainer"
>;

export interface ExplicitCustomRouteOptions {
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
}

type RewriteConfigUrlsWithDnsPinning = (value: ConfigValue) => Promise<ConfigValue>;

/**
 * Resolves a DNS-backed HTTPS custom endpoint to a pinned, locally-terminated
 * route base URL instead of the raw operator-supplied URL. OpenShell never
 * sees the real hostname; the returned URL always targets the trusted
 * `host.openshell.internal` bridge, matching the shape already exempted by
 * {@link ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS}.
 */
export interface EnsureHttpsPinRuntimeAdapterOptions {
  gatewayName: string;
  provider: string;
  endpointUrl: string;
  providerType: HttpsPinCredentialProviderType;
  credentialValue: string;
}
export type EnsureHttpsPinRuntimeAdapterFn = (
  options: EnsureHttpsPinRuntimeAdapterOptions,
) => Promise<{ baseUrl: string; credentialEnv: string; token: string; routeId: string }>;

export interface HttpsPinProviderBinding {
  baseUrl: string;
  credentialEnv: string;
  token: string;
  routeId: string;
  providerType: HttpsPinCredentialProviderType;
}

type EnsureHttpsPinAdapterRoute = (endpointUrl: string) => Promise<string>;

export interface PreparedInferenceSetRoute {
  gatewayName: string;
  preliminaryExplicitMetadata: RegistryInferenceMetadata | null;
  /** Invocation-only source URL; never persisted for HTTPS-pin routes. */
  preliminaryExplicitSourceEndpointUrl: string | null;
  preliminaryRegistryMetadata: RegistryInferenceMetadata;
}

const CUSTOM_COMPATIBLE_CREDENTIAL_ENV: Record<string, string> = {
  "compatible-endpoint": "COMPATIBLE_API_KEY",
  "compatible-anthropic-endpoint": "COMPATIBLE_ANTHROPIC_API_KEY",
};

const INFERENCE_SET_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

// Message prefix for the SSRF/DNS-pinning rejection thrown below. Keep this
// shared so finalization can append model-switch guidance only to this case.
export const ENDPOINT_URL_NOT_ALLOWED_PREFIX = "endpoint-url is not allowed:";

function isCustomCompatibleProvider(provider: string): boolean {
  return provider === "compatible-endpoint" || provider === "compatible-anthropic-endpoint";
}

function hasExplicitCustomMetadata(options: ExplicitCustomRouteOptions): boolean {
  return Boolean(options.endpointUrl || options.credentialEnv || options.inferenceApi);
}

// TRUST BOUNDARY: host.openshell.internal is the single sandbox-to-host bridge
// hostname provisioned by OpenShell. It resolves to the Docker host gateway
// only inside the sandbox network namespace. This exemption is intentionally
// limited below to HTTP, an explicit unprivileged port, and the exact hostname;
// do not extend it to HTTPS, wildcard subdomains, localhost, RFC1918 literals,
// or other internal DNS names.
const ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS = new Set(["host.openshell.internal"]);

function normalizeEndpointUrlShape(value: string): { url: URL; normalized: string } {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("unsupported URL shape");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname || "/";
  return {
    url,
    normalized: url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`,
  };
}

function normalizeCustomEndpointUrlWithoutDns(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw)
    throw new InferenceSetError("endpoint-url is required for custom-compatible metadata.", 2);
  try {
    return normalizeEndpointUrlShape(raw).normalized;
  } catch {
    throw new InferenceSetError(
      "endpoint-url must be a valid http(s) URL without userinfo, query, or fragment components.",
      2,
    );
  }
}

export async function normalizeCustomEndpointUrl(
  value: string | null | undefined,
  rewriteUrlWithDnsPinning: RewriteConfigUrlsWithDnsPinning,
  ensureHttpsPinAdapterRoute?: EnsureHttpsPinAdapterRoute,
): Promise<string> {
  const normalized = normalizeCustomEndpointUrlWithoutDns(value);
  const shaped = normalizeEndpointUrlShape(normalized);
  const hostname = shaped.url.hostname.replace(/\.$/, "").toLowerCase();
  const port = Number(shaped.url.port);
  if (
    ALLOWED_PRIVATE_CUSTOM_ENDPOINT_HOSTS.has(hostname) &&
    shaped.url.protocol === "http:" &&
    Number.isInteger(port) &&
    port >= 1024
  ) {
    // This is the single sandbox-to-host bridge name that NemoClaw itself
    // provisions for local inference. Its supported routes are explicit
    // unprivileged HTTP listeners; do not generalize this exemption to HTTPS,
    // default/privileged ports, localhost, RFC1918 addresses, or arbitrary
    // internal DNS names.
    return normalized;
  }

  // A DNS-backed HTTPS endpoint cannot be pinned by IP substitution alone: the
  // TLS certificate requires the real hostname as SNI, so OpenShell's own
  // re-resolution at request time would race the SSRF preflight (TOCTOU) if
  // it saw that hostname directly. Route it through the local HTTPS-pin
  // runtime adapter instead, which re-validates the address immediately
  // before connecting and hides the real hostname from the OpenShell runtime
  // boundary entirely.
  if (ensureHttpsPinAdapterRoute && isHttpsPinRuntimeEligible(normalized)) {
    try {
      const effectiveRoute = await ensureHttpsPinAdapterRoute(normalized);
      if (typeof effectiveRoute !== "string")
        throw new Error("HTTPS pin adapter returned a non-string value");
      // Persist only the sandbox-facing adapter route. The source hostname is
      // retained in invocation state long enough to validate and register the
      // host adapter, but must not cross into the sandbox registry/session.
      return normalizeEndpointUrlShape(effectiveRoute).normalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InferenceSetError(`${ENDPOINT_URL_NOT_ALLOWED_PREFIX} ${message}`, 2);
    }
  }

  try {
    const validated = await rewriteUrlWithDnsPinning(normalized);
    if (typeof validated !== "string") throw new Error("URL validator returned a non-string value");
    return normalizeEndpointUrlShape(validated).normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The generic DNS-pinning validator's message stays scoped to arbitrary
    // persisted config values; only this inference-set call site knows the
    // rejected field is an inference endpoint, so it adds the adapter hint.
    const hint =
      error instanceof ConfigUrlValidationError && error.reason === "dns_backed_https_unsupported"
        ? " This endpoint should have been routed through the HTTPS Pin Runtime adapter; retry, and report a bug if this persists."
        : "";
    throw new InferenceSetError(`${ENDPOINT_URL_NOT_ALLOWED_PREFIX} ${message}${hint}`, 2);
  }
}

function normalizeExplicitCredentialEnv(
  provider: string,
  value: string | null | undefined,
): string {
  const expected = CUSTOM_COMPATIBLE_CREDENTIAL_ENV[provider];
  const normalized = typeof value === "string" && value.trim() ? value.trim() : expected;
  if (normalized !== expected) {
    throw new InferenceSetError(
      `credential-env for '${provider}' must be '${expected}' so rebuild can safely reuse it.`,
      2,
    );
  }
  return normalized;
}

function allowedExplicitInferenceApis(provider: string): string[] {
  return provider === "compatible-endpoint"
    ? ["openai-completions", "openai-responses"]
    : Array.from(INFERENCE_SET_APIS);
}

function normalizeExplicitInferenceApi(provider: string, value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new InferenceSetError(
      `inference-api is required for '${provider}' so the shared gateway route can be identified safely.`,
      2,
    );
  }
  const allowed = allowedExplicitInferenceApis(provider);
  if (!allowed.includes(normalized)) {
    throw new InferenceSetError(
      `inference-api for '${provider}' must be one of: ${allowed.join(", ")}.`,
      2,
    );
  }
  return normalized;
}

function explicitCustomProviderMetadataWithoutDns(
  provider: string,
  options: ExplicitCustomRouteOptions,
  gatewayName: string,
  onboardEndpointUrl: string | null,
): {
  metadata: RegistryInferenceMetadata | null;
  sourceEndpointUrl: string | null;
} {
  if (!hasExplicitCustomMetadata(options)) return { metadata: null, sourceEndpointUrl: null };
  if (!isCustomCompatibleProvider(provider)) {
    throw new InferenceSetError(
      "endpoint-url, credential-env, and inference-api are only supported for compatible-endpoint and compatible-anthropic-endpoint.",
      2,
    );
  }

  // Source boundary: custom-compatible endpoint URLs are operator-supplied and
  // not discoverable from the gateway provider registry with a sandbox-scoped
  // trust guarantee. Treat these explicit flags as this invocation's source,
  // after URL and credential-env validation, instead of borrowing from an
  // unrelated onboard session or global OpenShell provider.
  const sourceEndpointUrl = normalizeCustomEndpointUrlWithoutDns(options.endpointUrl);
  const normalizedOnboardEndpoint = onboardEndpointUrl
    ? normalizeCustomEndpointUrlWithoutDns(onboardEndpointUrl)
    : null;
  const reusesOnboardEndpoint =
    normalizedOnboardEndpoint !== null && sourceEndpointUrl === normalizedOnboardEndpoint;
  const endpointUrl =
    !reusesOnboardEndpoint && isHttpsPinRuntimeEligible(sourceEndpointUrl)
      ? buildHttpsPinRouteBaseUrl(computeHttpsPinRouteId(gatewayName, provider, sourceEndpointUrl))
      : sourceEndpointUrl;
  return {
    metadata: {
      endpointUrl,
      endpointSource: reusesOnboardEndpoint ? "onboard" : "inference-set",
      credentialEnv: normalizeExplicitCredentialEnv(provider, options.credentialEnv),
      preferredInferenceApi: normalizeExplicitInferenceApi(provider, options.inferenceApi),
      nimContainer: null,
    },
    sourceEndpointUrl,
  };
}

function matchingSessionMetadata(options: {
  session: Session | null;
  sandboxName: string;
  provider: string;
  model: string;
}): RegistryInferenceMetadata | null {
  const { session, sandboxName, provider, model } = options;
  if (
    session?.sandboxName !== sandboxName ||
    session.provider !== provider ||
    session.model !== model ||
    !session.endpointUrl
  ) {
    return null;
  }
  return {
    endpointUrl: session.endpointUrl,
    endpointSource: null,
    credentialEnv: session.credentialEnv ?? null,
    preferredInferenceApi: session.preferredInferenceApi ?? null,
    nimContainer: session.nimContainer ?? null,
  };
}

function registryMetadataForProviderSwitch(options: {
  entry: SandboxEntry;
  provider: string;
  model: string;
  sandboxName: string;
  session: Session | null;
  explicitMetadata: RegistryInferenceMetadata | null;
}): RegistryInferenceMetadata {
  const { entry, provider, model, sandboxName, session, explicitMetadata } = options;
  if (explicitMetadata) return explicitMetadata;
  if (entry.provider === provider) {
    return {
      endpointUrl: entry.endpointUrl ?? null,
      endpointSource: entry.endpointSource ?? null,
      credentialEnv: entry.credentialEnv ?? null,
      preferredInferenceApi: entry.preferredInferenceApi ?? null,
      nimContainer: entry.nimContainer ?? null,
    };
  }
  const sessionMetadata = matchingSessionMetadata({ session, sandboxName, provider, model });
  if (sessionMetadata) return sessionMetadata;
  if (isCustomCompatibleProvider(provider)) {
    throw new InferenceSetError(
      `Cannot switch sandbox '${sandboxName}' to '${provider}' without trusted durable endpoint metadata. ` +
        `Re-run onboarding for this custom endpoint or restore a matching onboard session before using inference set.`,
      2,
    );
  }
  return {
    endpointUrl: null,
    endpointSource: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    nimContainer: null,
  };
}

function assertGatewayRouteCompatibility(options: {
  gatewayName: string;
  sandboxName: string;
  provider: string;
  model: string;
  metadata: RegistryInferenceMetadata;
  sandboxes: SandboxEntry[];
}): void {
  const compatibility = checkGatewayRouteCompatibility({
    gatewayName: options.gatewayName,
    sandboxName: options.sandboxName,
    route: { provider: options.provider, model: options.model, ...options.metadata },
    sandboxes: options.sandboxes,
  });
  if (!compatibility.ok) {
    throw new InferenceSetError(formatGatewayRouteConflict(compatibility), 2);
  }
}

export function prepareInferenceSetRoute(options: {
  entry: SandboxEntry;
  sandboxName: string;
  provider: string;
  model: string;
  customRoute: ExplicitCustomRouteOptions;
  session: Session | null;
  sandboxes: SandboxEntry[];
}): PreparedInferenceSetRoute {
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(options.entry);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InferenceSetError(
      `Cannot resolve the OpenShell gateway for sandbox '${options.sandboxName}': ${detail}`,
      2,
    );
  }

  const explicit = explicitCustomProviderMetadataWithoutDns(
    options.provider,
    options.customRoute,
    gatewayName,
    options.entry.provider === options.provider && options.entry.endpointSource === "onboard"
      ? (options.entry.endpointUrl ?? null)
      : null,
  );
  const preliminaryExplicitMetadata = explicit.metadata;
  const preliminaryRegistryMetadata = registryMetadataForProviderSwitch({
    entry: options.entry,
    provider: options.provider,
    model: options.model,
    sandboxName: options.sandboxName,
    session: options.session,
    explicitMetadata: preliminaryExplicitMetadata,
  });
  assertGatewayRouteCompatibility({
    gatewayName,
    sandboxName: options.sandboxName,
    provider: options.provider,
    model: options.model,
    metadata: preliminaryRegistryMetadata,
    sandboxes: options.sandboxes,
  });
  return {
    gatewayName,
    preliminaryExplicitMetadata,
    preliminaryExplicitSourceEndpointUrl: explicit.sourceEndpointUrl,
    preliminaryRegistryMetadata,
  };
}

export async function finalizeInferenceSetRoute(options: {
  prepared: PreparedInferenceSetRoute;
  sandboxName: string;
  provider: string;
  model: string;
  canReuseRecordedRoute: boolean;
  onboardEndpointUrl: string | null;
  getSandboxes: () => SandboxEntry[];
  rewriteUrlWithDnsPinning: RewriteConfigUrlsWithDnsPinning;
  ensureHttpsPinRuntimeAdapter: EnsureHttpsPinRuntimeAdapterFn;
  effectiveInferenceApi?: string | null;
}): Promise<{
  registryMetadata: RegistryInferenceMetadata;
  explicitPreferredInferenceApi: string | null;
  httpsPinProviderBinding: HttpsPinProviderBinding | null;
}> {
  const { prepared } = options;
  if (!prepared.preliminaryExplicitMetadata) {
    return {
      registryMetadata: prepared.preliminaryRegistryMetadata,
      explicitPreferredInferenceApi: null,
      httpsPinProviderBinding: null,
    };
  }
  // Bound once per finalize call: the credential env var name is fixed per
  // provider (normalizeExplicitCredentialEnv already enforced this), and the
  // real credential value is read directly from the host process environment
  // at invocation time, never persisted, and never returned to the caller.
  const httpsPinCredentialEnv = CUSTOM_COMPATIBLE_CREDENTIAL_ENV[options.provider];
  // Set only when the adapter route is actually used. The canonical provider
  // credential key stays stable; only its invocation-local value becomes the
  // route-scoped adapter token.
  let httpsPinProviderBinding: HttpsPinProviderBinding | null = null;
  const ensureHttpsPinAdapterRoute: EnsureHttpsPinAdapterRoute = async (endpointUrl) => {
    // The credential is held only for this invocation and handed directly
    // to the adapter. It is never persisted, returned, or copied to a shared
    // process.env slot.
    const credentialValue = process.env[httpsPinCredentialEnv] ?? "";
    const providerType: HttpsPinCredentialProviderType =
      (options.effectiveInferenceApi ??
        prepared.preliminaryExplicitMetadata?.preferredInferenceApi) === "anthropic-messages"
        ? "anthropic"
        : "openai";
    const adapter = await options.ensureHttpsPinRuntimeAdapter({
      gatewayName: prepared.gatewayName,
      provider: options.provider,
      endpointUrl,
      providerType,
      credentialValue,
    });
    httpsPinProviderBinding = {
      ...adapter,
      // Keep the provider's one canonical credential key. Only its
      // invocation-local value changes to the route-scoped token; using a
      // second key risks OpenShell merging credential bindings on an attached
      // provider instead of replacing the old key.
      credentialEnv: httpsPinCredentialEnv,
      providerType,
    };
    return adapter.baseUrl;
  };
  let endpointUrl: string;
  let endpointSource: RegistryInferenceMetadata["endpointSource"];
  try {
    const suppliedEndpoint = normalizeCustomEndpointUrlWithoutDns(
      prepared.preliminaryExplicitSourceEndpointUrl ??
        prepared.preliminaryExplicitMetadata.endpointUrl,
    );
    const onboardEndpoint = options.onboardEndpointUrl
      ? normalizeCustomEndpointUrlWithoutDns(options.onboardEndpointUrl)
      : null;
    // The recorded URL alone is not an authority boundary because inference
    // set writes it too. Bypass DNS re-resolution only when the registry also
    // carries the endpoint's onboarding source and the canonical identities
    // match exactly. Missing, inference-set, or mismatched provenance remains
    // on the full DNS-pinning SSRF path (#6321).
    if (onboardEndpoint !== null && suppliedEndpoint === onboardEndpoint) {
      endpointUrl = suppliedEndpoint;
      endpointSource = "onboard";
    } else {
      endpointUrl = await normalizeCustomEndpointUrl(
        suppliedEndpoint,
        options.rewriteUrlWithDnsPinning,
        ensureHttpsPinAdapterRoute,
      );
      endpointSource = "inference-set";
    }
  } catch (error) {
    // Only augment the SSRF/DNS-pinning rejection. Missing or malformed URLs
    // keep their original diagnostics so the guidance cannot contradict them.
    if (
      options.canReuseRecordedRoute &&
      error instanceof InferenceSetError &&
      error.message.startsWith(ENDPOINT_URL_NOT_ALLOWED_PREFIX)
    ) {
      throw new InferenceSetError(
        `${error.message} This sandbox is already configured for '${options.provider}'. ` +
          `To switch only the model, omit --endpoint-url — inference set reuses the endpoint ` +
          `onboarding already established (the gateway route is not changed by inference set). ` +
          `To point the sandbox at a different endpoint, re-run onboarding with the new endpoint ` +
          `(rebuild reuses the recorded endpoint and cannot change it).`,
        error.exitCode,
      );
    }
    throw error;
  }
  const registryMetadata: RegistryInferenceMetadata = {
    ...prepared.preliminaryExplicitMetadata,
    endpointUrl,
    endpointSource,
  };
  assertGatewayRouteCompatibility({
    gatewayName: prepared.gatewayName,
    sandboxName: options.sandboxName,
    provider: options.provider,
    model: options.model,
    metadata: registryMetadata,
    sandboxes: options.getSandboxes(),
  });
  return {
    registryMetadata,
    explicitPreferredInferenceApi: registryMetadata.preferredInferenceApi ?? null,
    httpsPinProviderBinding,
  };
}
