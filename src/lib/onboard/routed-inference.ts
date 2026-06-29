// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for wiring the routed (Model Router) inference provider into the
 * OpenShell gateway.
 *
 * Model Router runs on the host (default port 4000), but sandboxes reach it
 * through the OpenShell gateway. On Linux Docker-driver hosts `localhost:4000`
 * is the sandbox/proxy loopback, not the host router, so the gateway provider
 * base URL must use the `host.openshell.internal` alias. These helpers
 * normalize the blueprint endpoint to that sandbox-facing alias and upsert the
 * provider, so both fresh setup and resume repair a stale `localhost` base URL
 * left behind by an earlier run (#4564).
 */

import { HOST_GATEWAY_URL } from "../inference/local";
import { DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV, loadBlueprintProfile } from "./model-router";

export type UpsertProviderResult = {
  ok: boolean;
  message?: string;
  status?: number;
};

export type RoutedProviderDeps = {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv,
  ) => UpsertProviderResult;
  hydrateCredentialEnv: (credentialEnv: string) => string | null | undefined;
};

export type RoutedProviderUpsert = {
  ok: boolean;
  endpointUrl: string;
  resolvedCredentialEnv: string;
  result: UpsertProviderResult;
};

/**
 * Rewrite a routed-provider endpoint to the sandbox-facing host alias.
 *
 * `localhost`/`127.0.0.1` endpoints are rewritten to
 * `http://host.openshell.internal:<port><path>`. A missing endpoint falls back
 * to the routed blueprint profile so a resume with no recorded endpoint still
 * repairs to the correct alias rather than leaving the gateway pointed at a
 * stale loopback URL.
 */
export function normalizeRoutedEndpointUrl(
  endpointUrl: string | null | undefined,
  loadProfile: typeof loadBlueprintProfile = loadBlueprintProfile,
): string {
  let url = (endpointUrl || "").trim();
  if (!url) {
    url = (loadProfile("routed")?.endpoint || "").trim();
  }
  if (!url) return url;
  if (/localhost|127\.0\.0\.1/.test(url)) {
    try {
      const parsed = new URL(url);
      const port = parsed.port ? `:${parsed.port}` : "";
      return `${HOST_GATEWAY_URL}${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  }
  return url;
}

/**
 * Resolve the credential env for the routed provider.
 *
 * Mirrors `reconcileModelRouter()`'s resolution order so the gateway provider
 * is bound to the same key the router process reads: an explicit recorded env
 * first, then the routed blueprint profile's credential env, and only then the
 * `NVIDIA_INFERENCE_API_KEY` default. Without the profile step a resume with no recorded
 * credential env would re-upsert the provider against `NVIDIA_INFERENCE_API_KEY` even
 * when the routed profile defines a custom `credential_env`, breaking
 * inference.local (#4564).
 */
export function resolveRoutedCredentialEnv(
  credentialEnv: string | null,
  loadProfile: typeof loadBlueprintProfile = loadBlueprintProfile,
): string {
  if (credentialEnv) return credentialEnv;
  const profile = loadProfile("routed");
  return (
    profile?.router?.credential_env ||
    profile?.credential_env ||
    DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV
  );
}

/**
 * Upsert the routed provider into the gateway with a normalized, sandbox-facing
 * base URL. Used by both fresh routed setup and resume repair.
 */
export function upsertRoutedProvider(
  provider: string,
  endpointUrl: string | null,
  credentialEnv: string | null,
  deps: RoutedProviderDeps,
): RoutedProviderUpsert {
  const resolvedCredentialEnv = resolveRoutedCredentialEnv(credentialEnv);
  const normalizedEndpoint = normalizeRoutedEndpointUrl(endpointUrl);
  const credentialValue = deps.hydrateCredentialEnv(resolvedCredentialEnv);
  const env = credentialValue ? { [resolvedCredentialEnv]: credentialValue } : {};
  const result = deps.upsertProvider(
    provider,
    "openai",
    resolvedCredentialEnv,
    normalizedEndpoint,
    env,
  );
  return {
    ok: result.ok,
    endpointUrl: normalizedEndpoint,
    resolvedCredentialEnv,
    result,
  };
}
