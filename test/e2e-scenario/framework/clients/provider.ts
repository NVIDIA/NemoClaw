// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

const trustedProviderEndpointBrand: unique symbol = Symbol("TrustedProviderEndpoint");

export interface TrustedProviderEndpoint {
  readonly url: string;
  readonly artifactLabel: string;
  readonly logLabel: string;
  readonly redactionValues: readonly string[];
  readonly [trustedProviderEndpointBrand]: true;
}

export interface TrustedProviderEndpointOptions {
  allowedHosts?: readonly string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

function queryRedactionValues(url: URL): string[] {
  const values = new Set<string>();
  if (url.search) {
    values.add(url.search.slice(1));
  }
  for (const value of url.searchParams.values()) {
    if (value) values.add(value);
  }
  return [...values];
}

function safeProviderLabels(url: URL): { artifactLabel: string; logLabel: string } {
  const withoutQuery = `${url.protocol}//${url.host}${url.pathname}`;
  return {
    artifactLabel: artifactLabel(withoutQuery),
    logLabel: withoutQuery,
  };
}

export function trustedProviderEndpoint(
  rawUrl: string,
  options: TrustedProviderEndpointOptions = {},
): TrustedProviderEndpoint {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`provider endpoint URL is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`provider endpoint protocol must be http or https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("provider endpoint URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  if (!host) {
    throw new Error("provider endpoint URL must include a host");
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`provider endpoint host is blocked: ${host}`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`provider endpoint http URLs must target loopback hosts: ${host}`);
  }
  const allowedHosts = options.allowedHosts?.map((allowed) => allowed.toLowerCase());
  if (!LOOPBACK_HOSTS.has(host) && !allowedHosts) {
    throw new Error(`provider endpoint external hosts require an allowedHosts entry: ${host}`);
  }
  if (allowedHosts && !allowedHosts.includes(host)) {
    throw new Error(`provider endpoint host is not allowed: ${host}`);
  }
  const labels = safeProviderLabels(url);
  return {
    url: url.toString(),
    artifactLabel: labels.artifactLabel,
    logLabel: labels.logLabel,
    redactionValues: queryRedactionValues(url),
    [trustedProviderEndpointBrand]: true,
  };
}

export class ProviderClient {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  private curl(endpoint: TrustedProviderEndpoint, options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: "curl",
        args: ["-fsSL", endpoint.url],
        reason: "fetch trusted provider endpoint",
      }),
      {
        ...options,
        artifactName: options.artifactName ?? `curl-${endpoint.artifactLabel}`,
        redactionValues: [...(options.redactionValues ?? []), ...endpoint.redactionValues],
      },
    );
  }

  async getJson<T = unknown>(endpoint: TrustedProviderEndpoint, options: ShellProbeRunOptions = {}): Promise<T> {
    const result = await this.curl(endpoint, options);
    assertExitZero(result, `curl ${endpoint.logLabel}`);
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error("provider response was not JSON");
    }
  }
}
