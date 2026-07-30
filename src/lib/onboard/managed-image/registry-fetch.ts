// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rootCertificates } from "node:tls";

import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { withLocalNoProxy } from "../../proxy/local-no-proxy";
import { resolveCorporateCa } from "../corporate-ca";
import type { ResolvedCorporateCa } from "../corporate-ca-types";

type RegistryFetch = typeof fetch;
type RegistryDispatcherOptions = NonNullable<ConstructorParameters<typeof EnvHttpProxyAgent>[0]>;
const REGISTRY_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export interface ManagedImageRegistryFetchSession {
  readonly fetchImpl: RegistryFetch;
  close(): Promise<void>;
}

export interface ManagedImageRegistryTransportOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seam; production resolves the same validated host CA policy as onboarding. */
  readonly corporateCaOverride?: ResolvedCorporateCa | null;
}

function proxyUrl(value: string | undefined, name: string): string {
  if (value === undefined) return "";
  let parsed: URL;
  try {
    parsed = new URL(value.includes("://") ? value : `http://${value}`);
  } catch (error) {
    throw new Error(`${name} is not a valid proxy URL`, { cause: error });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} is not a supported HTTP(S) proxy URL`);
  }
  return parsed.href;
}

function normalizedRegistryProxyEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const proxyEnvironment: Record<string, string> = {};
  for (const name of REGISTRY_PROXY_ENV_NAMES) {
    const value = environment[name]?.trim();
    if (value) proxyEnvironment[name] = value;
  }
  withLocalNoProxy(proxyEnvironment);
  return proxyEnvironment;
}

/**
 * Build a scoped Undici transport. This never replaces Node's global
 * dispatcher and never persists or logs credential-bearing proxy URLs.
 */
export function resolveManagedImageRegistryDispatcherOptions(
  options: ManagedImageRegistryTransportOptions = {},
): RegistryDispatcherOptions {
  const environment = options.environment ?? process.env;
  const proxy = normalizedRegistryProxyEnvironment(environment);
  const httpProxy = proxyUrl(proxy.http_proxy ?? proxy.HTTP_PROXY, "HTTP_PROXY");
  const httpsProxy = proxyUrl(
    proxy.https_proxy ?? proxy.HTTPS_PROXY ?? proxy.http_proxy ?? proxy.HTTP_PROXY,
    "HTTPS_PROXY",
  );
  const noProxy = proxy.no_proxy ?? proxy.NO_PROXY ?? "";
  const corporateCa =
    options.corporateCaOverride === undefined
      ? resolveCorporateCa(environment)
      : options.corporateCaOverride;
  if (corporateCa === null) return { httpProxy, httpsProxy, noProxy };

  const ca = [...rootCertificates, corporateCa.pem];
  return {
    httpProxy,
    httpsProxy,
    noProxy,
    connect: { ca },
    requestTls: { ca },
    proxyTls: { ca },
  };
}

export function createManagedImageRegistryFetchSession(
  options: ManagedImageRegistryTransportOptions = {},
): ManagedImageRegistryFetchSession {
  const dispatcher = new EnvHttpProxyAgent(resolveManagedImageRegistryDispatcherOptions(options));
  const fetchImpl = (async (input, init) => {
    const undiciInit = {
      ...(init as object),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1];
    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      undiciInit,
    )) as unknown as Response;
  }) as RegistryFetch;
  return {
    fetchImpl,
    close: async () => {
      await dispatcher.close();
    },
  };
}
