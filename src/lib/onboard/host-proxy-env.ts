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
const HOST_PROXY_URL_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
] as const;
const MAX_HOST_PROXY_URL_BYTES = 4096;
const MAX_HOST_NO_PROXY_BYTES = 8192;
const MAX_HOST_PROXY_ENV_BYTES = 24 * 1024;

type HostProxyEnvOptions = {
  dropCredentialBearingProxyUrls?: boolean;
};

type HostProxyEnvironment = Record<string, string>;

export class HostProxyEnvironmentError extends Error {
  constructor(message: string) {
    super(`Invalid host proxy environment: ${message}`);
    this.name = "HostProxyEnvironmentError";
  }
}

export function isCredentialBearingProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return /[^/@:]+:[^/@]*@/.test(value);
  }
}

function maximumBytes(name: (typeof HOST_PROXY_ENV_NAMES)[number]): number {
  return name === "NO_PROXY" || name === "no_proxy"
    ? MAX_HOST_NO_PROXY_BYTES
    : MAX_HOST_PROXY_URL_BYTES;
}

export function resolveHostProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: HostProxyEnvOptions = {},
): HostProxyEnvironment {
  const proxyEnv: HostProxyEnvironment = {};
  let totalBytes = 0;
  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      // Filter on the trimmed value but ALSO store the trimmed value —
      // forwarding the surrounding whitespace would break consumers that
      // don't re-trim.
      if (
        trimmed !== "" &&
        !(options.dropCredentialBearingProxyUrls && isCredentialBearingProxyUrl(trimmed))
      ) {
        const valueBytes = Buffer.byteLength(trimmed, "utf8");
        if (
          valueBytes > maximumBytes(name) ||
          /[\u0000-\u001f\u007f]/u.test(trimmed) ||
          totalBytes + valueBytes > MAX_HOST_PROXY_ENV_BYTES
        ) {
          throw new HostProxyEnvironmentError(`${name} is malformed or exceeds its size limit`);
        }
        proxyEnv[name] = trimmed;
        totalBytes += valueBytes;
      }
    }
  }

  const hasProxy = HOST_PROXY_URL_ENV_NAMES.some((name) => proxyEnv[name] !== undefined);
  if (!hasProxy) return {};

  withLocalNoProxy(proxyEnv);
  for (const name of ["NO_PROXY", "no_proxy"] as const) {
    const value = proxyEnv[name];
    if (value && Buffer.byteLength(value, "utf8") > MAX_HOST_NO_PROXY_BYTES) {
      throw new HostProxyEnvironmentError(`${name} exceeds its size limit after normalization`);
    }
  }
  const normalizedBytes = Object.values(proxyEnv).reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  );
  if (normalizedBytes > MAX_HOST_PROXY_ENV_BYTES) {
    throw new HostProxyEnvironmentError("the normalized proxy environment exceeds its size limit");
  }
  return proxyEnv;
}

export function hasCredentialBearingHostProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const proxyEnv = resolveHostProxyEnvironment(env);
  return HOST_PROXY_URL_ENV_NAMES.some((name) => {
    const value = proxyEnv[name];
    return value !== undefined && isCredentialBearingProxyUrl(value);
  });
}

export function credentialHostProxyReplayEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const proxyEnv = resolveHostProxyEnvironment(env);
  if (
    !HOST_PROXY_URL_ENV_NAMES.some((name) => {
      const value = proxyEnv[name];
      return value !== undefined && isCredentialBearingProxyUrl(value);
    })
  ) {
    throw new HostProxyEnvironmentError(
      "the source requires a credential-bearing proxy, but this command has none to replay",
    );
  }
  return HOST_PROXY_ENV_NAMES.flatMap((name) => {
    const value = proxyEnv[name];
    return value === undefined ? [] : [formatEnvAssignment(name, value)];
  });
}

export function appendHostProxyEnvArgs(
  envArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: HostProxyEnvOptions = {},
): void {
  const proxyEnv = resolveHostProxyEnvironment(env, options);

  // #2598: NEMOCLAW_MINIMAL_BOOTSTRAP is a host-side opt-in flag (set to
  // "1") that the sandbox's nemoclaw-start.sh:seed_default_workspace_templates
  // reads to skip default workspace template seeding for new/pristine
  // workspaces (does NOT delete files already present), knocking ~3k tokens
  // off OpenClaw's per-turn bootstrap context injection. Partial #2598
  // mitigation: addresses the project-context contribution from NemoClaw's
  // seeded templates; the remaining OpenClaw framework/non-project context
  // is tracked upstream. Bundled here with the proxy propagation because
  // both are env vars forwarded from the host into `openshell sandbox
  // create -- env ... nemoclaw-start`, and the top-level onboard.ts
  // entrypoint is line-budget-constrained per codebase-growth-guardrails.
  if (env.NEMOCLAW_MINIMAL_BOOTSTRAP === "1") {
    envArgs.push(formatEnvAssignment("NEMOCLAW_MINIMAL_BOOTSTRAP", "1"));
  }

  const hasProxy = HOST_PROXY_URL_ENV_NAMES.some((name) => proxyEnv[name] !== undefined);
  if (!hasProxy) return;

  for (const name of HOST_PROXY_ENV_NAMES) {
    const value = proxyEnv[name];
    if (value) envArgs.push(formatEnvAssignment(name, value));
  }
}
