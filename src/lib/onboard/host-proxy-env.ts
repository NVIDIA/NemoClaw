// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatEnvAssignment } from "../core/url-utils";
import { withLocalNoProxy } from "../subprocess-env";

const HOST_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function appendHostProxyEnvArgs(
  envArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const proxyEnv: Record<string, string> = {};
  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      proxyEnv[name] = value;
    }
  }

  const hasProxy =
    proxyEnv.HTTP_PROXY || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.https_proxy;
  if (!hasProxy) return;

  withLocalNoProxy(proxyEnv);
  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = proxyEnv[name];
    if (value) envArgs.push(formatEnvAssignment(name, value));
  }
}
