// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

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

export function assertPolicyDocumentsEqual(
  expectedFile: string,
  actualFile: string,
  message: string,
): void {
  const expected = parseOpenShellPolicy(fs.readFileSync(expectedFile, "utf8")).policy;
  const actual = parseOpenShellPolicy(fs.readFileSync(actualFile, "utf8")).policy;
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
}

export function bindPolicyEndpointCredential(
  policyFile: string,
  providerName: string,
  host: string,
  port: number,
  protocol: string,
): void {
  const source = fs.readFileSync(policyFile, "utf8");
  const updated = policyDocumentWithEndpointCredentialBinding(
    source,
    providerName,
    host,
    port,
    protocol,
  );
  fs.writeFileSync(policyFile, updated);
  fs.chmodSync(policyFile, 0o600);
}

export function policyDocumentWithEndpointCredentialBinding(
  source: string,
  providerName: string,
  host: string,
  port: number,
  protocol: string,
): string {
  const policy = parseOpenShellPolicy(source).policy;
  const endpoints = Object.values(policy.network_policies ?? {}).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const candidateEndpoints = (entry as { endpoints?: unknown }).endpoints;
    return Array.isArray(candidateEndpoints) ? candidateEndpoints : [];
  });
  const matchingEndpoints = endpoints.filter((candidate): candidate is Record<string, unknown> => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const value = candidate as { host?: unknown; port?: unknown; protocol?: unknown };
    return value.host === host && value.port === port && value.protocol === protocol;
  });
  if (matchingEndpoints.length !== 1) {
    throw new Error(
      matchingEndpoints.length === 0
        ? `fake endpoint ${host}:${port}/${protocol} is missing from the base policy`
        : `fake endpoint ${host}:${port}/${protocol} matches ${matchingEndpoints.length} base policy entries; expected exactly one`,
    );
  }
  const endpoint = matchingEndpoints[0]!;
  const binding = { provider: providerName };
  if (
    Object.hasOwn(endpoint, "credential_binding") &&
    !isDeepStrictEqual(endpoint.credential_binding, binding)
  ) {
    throw new Error(
      `fake endpoint ${host}:${port}/${protocol} already has a conflicting credential binding`,
    );
  }

  endpoint.credential_binding = binding;
  return YAML.stringify(policy);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--assert-equal") {
    const [, expectedFile, actualFile, message] = args;
    if (!expectedFile || !actualFile || !message) {
      throw new Error(
        "usage: policy-credential-binding --assert-equal <expected-policy> <actual-policy> <message>",
      );
    }
    assertPolicyDocumentsEqual(expectedFile, actualFile, message);
    return;
  }
  const [policyFile, providerName, host, rawPort, protocol] = args;
  if (!policyFile || !providerName || !host || !rawPort || !protocol) {
    throw new Error(
      "usage: policy-credential-binding <policy-file> <provider> <host> <port> <protocol>",
    );
  }
  bindPolicyEndpointCredential(policyFile, providerName, host, Number(rawPort), protocol);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
