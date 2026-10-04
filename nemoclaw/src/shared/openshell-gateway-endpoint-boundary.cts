// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const ENDPOINT_RE = /^\s*(?:Gateway endpoint|Server):(.*)$/gimu;

export type ManagedGatewayEndpointBinding = "match" | "mismatch" | "not-applicable" | "unknown";

export interface ManagedGatewayEndpoint {
  host: "127.0.0.1" | "localhost" | "[::1]";
  port: number;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export function isManagedGatewayEndpointHost(
  value: unknown,
): value is ManagedGatewayEndpoint["host"] {
  return value === "127.0.0.1" || value === "localhost" || value === "[::1]";
}

function parseLoopbackEndpoint(value: string): URL | null {
  if (!value || /\s/u.test(value)) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return null;
  }
  const localProtocol = endpoint.protocol === "https:" || endpoint.protocol === "http:";
  const localHost = isManagedGatewayEndpointHost(endpoint.hostname);
  if (
    !localProtocol ||
    !localHost ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    return null;
  }
  return endpoint;
}

function endpointPort(endpoint: URL): number | null {
  const value = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function classifyManagedGatewayEndpointBinding(
  outputs: readonly string[],
  expectedGatewayPort: number,
): Exclude<ManagedGatewayEndpointBinding, "not-applicable"> {
  let observedEndpoint = false;
  for (const output of outputs) {
    for (const match of stripAnsi(output).matchAll(ENDPOINT_RE)) {
      observedEndpoint = true;
      const endpoint = parseLoopbackEndpoint(match[1]?.trim() ?? "");
      if (!endpoint || endpointPort(endpoint) !== expectedGatewayPort) return "mismatch";
    }
  }
  return observedEndpoint ? "match" : "unknown";
}

export function parseSingleManagedGatewayEndpoint(output: string): ManagedGatewayEndpoint {
  const endpointValues = [...stripAnsi(output).matchAll(ENDPOINT_RE)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (endpointValues.length !== 1) {
    throw new Error("OpenShell gateway info did not report one gateway endpoint");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpointValues[0]);
  } catch {
    throw new Error("OpenShell gateway info reported an invalid gateway endpoint");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenShell gateway info reported an unsupported gateway endpoint protocol");
  }
  const endpoint = parseLoopbackEndpoint(endpointValues[0]);
  if (!endpoint) {
    throw new Error("OpenShell gateway info reported an unsupported local gateway endpoint");
  }
  const port = endpointPort(endpoint);
  if (port === null) {
    throw new Error("OpenShell gateway info reported an invalid gateway port");
  }
  return {
    host: endpoint.hostname as ManagedGatewayEndpoint["host"],
    port,
  };
}

export function parseSingleManagedGatewayEndpointPort(output: string): number {
  return parseSingleManagedGatewayEndpoint(output).port;
}
