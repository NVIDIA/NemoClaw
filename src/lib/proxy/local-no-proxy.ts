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
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const parts = (env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    let changed = false;
    for (const host of LOCAL_NO_PROXY_HOSTS) {
      if (!parts.includes(host)) {
        parts.push(host);
        changed = true;
      }
    }
    if (changed) env[key] = parts.join(",");
  }
}
