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
    return (
      value.host === host &&
      value.port === port &&
      value.protocol === protocol
    );
  }) as Record<string, unknown> | undefined;
  if (!endpoint) throw new Error("fake Discord endpoint is missing from the base policy");

  endpoint.credential_binding = { provider: providerName };
  fs.writeFileSync(policyFile, YAML.stringify(policy));
  fs.chmodSync(policyFile, 0o600);
}

function main(): void {
  const [policyFile, providerName, host, rawPort, protocol] = process.argv.slice(2);
  if (!policyFile || !providerName || !host || !rawPort || !protocol) {
    throw new Error(
      "usage: hermes-discord-policy-binding <policy-file> <provider> <host> <port> <protocol>",
    );
  }
  bindHermesDiscordPolicyEndpoint(policyFile, providerName, host, Number(rawPort), protocol);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
