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

export function bindHermesDiscordPolicyEndpoint(
  policyFile: string,
  providerName: string,
  host: string,
  port: number,
  protocol: string,
): void {
  const source = fs.readFileSync(policyFile, "utf8");
  const policy = parseOpenShellPolicy(source).policy;
  const endpoints = Object.values(policy.network_policies ?? {}).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const candidateEndpoints = (entry as { endpoints?: unknown }).endpoints;
    return Array.isArray(candidateEndpoints) ? candidateEndpoints : [];
  });
  const endpoint = endpoints.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const value = candidate as { host?: unknown; port?: unknown; protocol?: unknown };
    return value.host === host && value.port === port && value.protocol === protocol;
  }) as Record<string, unknown> | undefined;
  if (!endpoint) throw new Error("fake Discord endpoint is missing from the base policy");

  endpoint.credential_binding = { provider: providerName };
  fs.writeFileSync(policyFile, YAML.stringify(policy));
  fs.chmodSync(policyFile, 0o600);
}

export function unbindProviderPolicyEndpoints(policyFile: string, providerName: string): void {
  const source = fs.readFileSync(policyFile, "utf8");
  const policy = parseOpenShellPolicy(source).policy;
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

function main(): void {
  const args = process.argv.slice(2);
  const unbind = args[0] === "--unbind-provider";
  const [policyFile, providerName, host, rawPort, protocol] = args.slice(unbind ? 1 : 0);
  if (!policyFile || !providerName || (!unbind && (!host || !rawPort || !protocol))) {
    throw new Error(
      "usage: hermes-discord-policy-binding <policy-file> <provider> <host> <port> <protocol>",
    );
  }
  unbind
    ? unbindProviderPolicyEndpoints(policyFile, providerName)
    : bindHermesDiscordPolicyEndpoint(policyFile, providerName, host!, Number(rawPort), protocol!);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
