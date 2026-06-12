// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

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
  /**
   * Static fixture-owned trust configuration for external HTTPS provider
   * endpoints. Do not populate this from scenario manifests or user input.
   */
  allowedHosts?: readonly string[];
}

export interface ProviderJsonRequestOptions extends ShellProbeRunOptions {
  readonly body?: string;
  readonly curlMaxTimeSeconds?: number;
  readonly headers?: readonly string[];
}

export interface ProviderJsonResponse<T = unknown> {
  readonly json: T;
  readonly result: ShellProbeResult;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

function validateCurlMaxTimeSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("provider request curlMaxTimeSeconds must be a finite positive number");
  }
  return String(value);
}

function validateCurlHeader(header: string): string {
  if (/[\r\n]/.test(header)) {
    throw new Error("provider request header must not contain CR or LF");
  }
  if (header.trimStart().startsWith("@")) {
    throw new Error("provider request header must not use curl @file syntax");
  }
  return header;
}

function validateCurlBody(body: string): string {
  if (body.trimStart().startsWith("@")) {
    throw new Error("provider request body must not use curl @file syntax");
  }
  return body;
}

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

function normalizeHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets;
}

function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  const ipv4 = parseIpv4(host);
  return Boolean(ipv4 && ipv4[0] === 127);
}

function isPrivateOrLinkLocalIp(host: string): boolean {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const ipv4 = parseIpv4(host);
    if (!ipv4) return false;
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (ipVersion === 6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("::ffff:")) {
      return isPrivateOrLinkLocalIp(host.slice("::ffff:".length));
    }
    const firstHextet = Number.parseInt(host.split(":")[0] ?? "", 16);
    if (!Number.isFinite(firstHextet)) return false;
    return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
  }
  return false;
}

export function trustedProviderEndpoint(
  rawUrl: string,
  options: TrustedProviderEndpointOptions = {},
): TrustedProviderEndpoint {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `provider endpoint URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`provider endpoint protocol must be http or https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("provider endpoint URL must not include credentials");
  }
  const host = normalizeHostname(url.hostname);
  if (!host) {
    throw new Error("provider endpoint URL must include a host");
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`provider endpoint host is blocked: ${host}`);
  }
  if (isPrivateOrLinkLocalIp(host) && !isLoopbackHost(host)) {
    throw new Error(
      `provider endpoint IP literal must not target private or link-local ranges: ${host}`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(host)) {
    throw new Error(`provider endpoint http URLs must target loopback hosts: ${host}`);
  }
  const allowedHosts = options.allowedHosts?.map(normalizeHostname);
  if (!isLoopbackHost(host) && !allowedHosts) {
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

  private curl(
    endpoint: TrustedProviderEndpoint,
    args: readonly string[],
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: "curl",
        args: [...args, endpoint.url],
        reason: "fetch trusted provider endpoint",
      }),
      {
        ...options,
        artifactName: options.artifactName ?? `curl-${endpoint.artifactLabel}`,
        redactionValues: [...(options.redactionValues ?? []), ...endpoint.redactionValues],
      },
    );
  }

  async requestJson<T = unknown>(
    endpoint: TrustedProviderEndpoint,
    options: ProviderJsonRequestOptions = {},
  ): Promise<ProviderJsonResponse<T>> {
    const { body, curlMaxTimeSeconds, headers, ...runOptions } = options;
    const args = ["-fsS"];
    if (curlMaxTimeSeconds !== undefined) {
      args.push("--max-time", validateCurlMaxTimeSeconds(curlMaxTimeSeconds));
    }
    for (const header of headers ?? []) {
      args.push("-H", validateCurlHeader(header));
    }
    if (body !== undefined) {
      args.push("--data-raw", validateCurlBody(body));
    }
    const result = await this.curl(endpoint, args, runOptions);
    assertExitZero(result, `curl ${endpoint.logLabel}`);
    try {
      return { json: JSON.parse(result.stdout) as T, result };
    } catch {
      throw new Error("provider response was not JSON");
    }
  }

  async getJson<T = unknown>(
    endpoint: TrustedProviderEndpoint,
    options: ShellProbeRunOptions = {},
  ): Promise<T> {
    const response = await this.requestJson<T>(endpoint, options);
    return response.json;
  }
}
