// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

// Import the tsc-compiled output, not the .cts source: a standalone `node
// --import tsx` child process (this fixture's execution mode) hits a Node/tsx
// loader conflict on newer Node versions where Node's own native .cts
// handling intercepts the file before tsx's transform runs, producing
// "Cannot use import statement outside a module". Every other consumer in
// this repo already imports the compiled .cjs for the same reason.
// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
import * as policyBoundaryModule from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

const policyBoundary = (
  "default" in policyBoundaryModule ? policyBoundaryModule.default : policyBoundaryModule
) as typeof policyBoundaryModule;
const { parseOpenShellPolicy } = policyBoundary;

function findFixturePolicyEndpoint(
  policy: { network_policies?: Record<string, unknown> },
  host: string,
  port: number,
  protocol: string,
): { endpoint: Record<string, unknown>; policyEntry: Record<string, unknown> } {
  for (const candidate of Object.values(policy.network_policies ?? {})) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const policyEntry = candidate as Record<string, unknown>;
    if (!Array.isArray(policyEntry.endpoints)) continue;
    const endpoint = policyEntry.endpoints.find((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const value = entry as { host?: unknown; port?: unknown; protocol?: unknown };
      return value.host === host && value.port === port && value.protocol === protocol;
    });
    if (typeof endpoint === "object" && endpoint !== null && !Array.isArray(endpoint)) {
      return { endpoint: endpoint as Record<string, unknown>, policyEntry };
    }
  }
  throw new Error("fixture endpoint is missing from the base policy");
}

function readPolicy(policyFile: string) {
  const source = fs.readFileSync(policyFile, "utf8");
  return parseOpenShellPolicy(source).policy;
}

export function bindFixtureProviderPolicyEndpoint(
  policyFile: string,
  providerName: string,
  host: string,
  port: number,
  protocol: string,
): void {
  const policy = readPolicy(policyFile);
  const { endpoint } = findFixturePolicyEndpoint(policy, host, port, protocol);
  endpoint.credential_binding = { provider: providerName };
  fs.writeFileSync(policyFile, YAML.stringify(policy));
  fs.chmodSync(policyFile, 0o600);
}

export function unbindProviderPolicyEndpoints(policyFile: string, providerName: string): void {
  const policy = readPolicy(policyFile);
  Object.values(policy.network_policies ?? {})
    .map((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? ((entry as { endpoints?: unknown }).endpoints ?? [])
        : [],
    )
    .filter((endpoints): endpoints is unknown[] => Array.isArray(endpoints))
    .flat()
    .filter(
      (endpoint): endpoint is Record<string, unknown> =>
        typeof endpoint === "object" && endpoint !== null && !Array.isArray(endpoint),
    )
    .filter(
      (endpoint) =>
        typeof endpoint.credential_binding === "object" &&
        endpoint.credential_binding !== null &&
        !Array.isArray(endpoint.credential_binding) &&
        (endpoint.credential_binding as { provider?: unknown }).provider === providerName,
    )
    .forEach((endpoint) => delete endpoint.credential_binding);
  fs.writeFileSync(policyFile, YAML.stringify(policy));
  fs.chmodSync(policyFile, 0o600);
}

export function assertFixtureProviderPolicyEndpointBinaries(
  policyFile: string,
  host: string,
  port: number,
  protocol: string,
  expectedBinaries: readonly string[],
): void {
  const { policyEntry } = findFixturePolicyEndpoint(readPolicy(policyFile), host, port, protocol);
  if (!Array.isArray(policyEntry.binaries)) {
    throw new Error("fixture endpoint policy has no binary restrictions");
  }
  const binaries = policyEntry.binaries.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("fixture endpoint policy has an invalid binary restriction");
    }
    const binaryPath = (candidate as { path?: unknown }).path;
    if (typeof binaryPath !== "string") {
      throw new Error("fixture endpoint policy has an invalid binary path");
    }
    return binaryPath;
  });
  if (JSON.stringify(binaries) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      `fixture endpoint policy binaries ${JSON.stringify(binaries)} did not match ${JSON.stringify(expectedBinaries)}`,
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--assert-binaries") {
    const [, policyFile, host, rawPort, protocol, ...expectedBinaries] = args;
    if (!policyFile || !host || !rawPort || !protocol || expectedBinaries.length === 0) {
      throw new Error(
        "usage: gateway-provider-policy-binding --assert-binaries <policy-file> <host> <port> <protocol> <binary>...",
      );
    }
    assertFixtureProviderPolicyEndpointBinaries(
      policyFile,
      host,
      Number(rawPort),
      protocol,
      expectedBinaries,
    );
    return;
  }

  const unbind = args[0] === "--unbind-provider";
  const [policyFile, providerName, host, rawPort, protocol] = args.slice(unbind ? 1 : 0);
  if (!policyFile || !providerName || (!unbind && (!host || !rawPort || !protocol))) {
    throw new Error(
      "usage: gateway-provider-policy-binding <policy-file> <provider> <host> <port> <protocol>",
    );
  }
  unbind
    ? unbindProviderPolicyEndpoints(policyFile, providerName)
    : bindFixtureProviderPolicyEndpoint(
        policyFile,
        providerName,
        host!,
        Number(rawPort),
        protocol!,
      );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
