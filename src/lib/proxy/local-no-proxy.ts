// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const LOCAL_NO_PROXY_HOSTS = [
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
  "host.containers.internal",
  "::1",
  "0.0.0.0",
  "inference.local",
] as const;

/**
 * Keep host loopback, container-host aliases, and OpenShell-managed inference
 * off any forwarded host proxy chain.
 */
export function withLocalNoProxy(env: Record<string, string>): void {
  const hasProxy = env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy;
  if (!hasProxy) return;

  const parts: string[] = [];
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    for (const value of (env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (!parts.includes(value)) parts.push(value);
    }
  }
  for (const host of LOCAL_NO_PROXY_HOSTS) {
    if (!parts.includes(host)) parts.push(host);
  }

  // Keep both spellings identical so a consumer's case precedence cannot
  // discard exclusions configured through the other spelling.
  const noProxy = parts.join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
}
