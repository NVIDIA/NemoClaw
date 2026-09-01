// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

// This standalone `node --import tsx` fixture cannot import the `.cts` source.
// Native `.cts` handling bypasses tsx and rejects the TypeScript import syntax.
// Use the compiled module. Source: nemoclaw/src/shared/openshell-policy-boundary.cts
import * as policyBoundaryModule from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

const policyBoundary = (
  "default" in policyBoundaryModule ? policyBoundaryModule.default : policyBoundaryModule
) as typeof policyBoundaryModule;
const { parseOpenShellPolicy } = policyBoundary;

export type PolicyEndpointBinding = {
  providerName: string;
  host: string;
  port: number;
  protocol: string;
};

export function bindPolicyEndpoints(
  policyFile: string,
  bindings: readonly PolicyEndpointBinding[],
): void {
  const source = fs.readFileSync(policyFile, "utf8");
  const policy = parseOpenShellPolicy(source).policy;
  const endpoints = Object.values(policy.network_policies ?? {}).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const candidateEndpoints = (entry as { endpoints?: unknown }).endpoints;
    return Array.isArray(candidateEndpoints) ? candidateEndpoints : [];
  });

  for (const binding of bindings) {
    const endpoint = endpoints.find((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return false;
      }
      const value = candidate as { host?: unknown; port?: unknown; protocol?: unknown };
      return (
        value.host === binding.host &&
        value.port === binding.port &&
        value.protocol === binding.protocol
      );
    }) as Record<string, unknown> | undefined;
    if (!endpoint) throw new Error("fake messaging endpoint is missing from the base policy");

    endpoint.credential_binding = { provider: binding.providerName };
  }

  fs.writeFileSync(policyFile, YAML.stringify(policy));
  fs.chmodSync(policyFile, 0o600);
}

function main(): void {
  const [policyFile, ...rawBindings] = process.argv.slice(2);
  if (!policyFile || rawBindings.length === 0 || rawBindings.length % 4 !== 0) {
    throw new Error(
      "usage: policy-credential-binding <policy-file> [<provider> <host> <port> <protocol>]...",
    );
  }
  const bindings: PolicyEndpointBinding[] = [];
  for (let index = 0; index < rawBindings.length; index += 4) {
    bindings.push({
      providerName: rawBindings[index]!,
      host: rawBindings[index + 1]!,
      port: Number(rawBindings[index + 2]),
      protocol: rawBindings[index + 3]!,
    });
  }
  bindPolicyEndpoints(policyFile, bindings);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
