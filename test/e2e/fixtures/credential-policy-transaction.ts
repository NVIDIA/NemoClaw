// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import YAML from "yaml";

import {
  captureRecordedSandboxBasePolicy,
  setPolicyDocument,
} from "../../../src/lib/policy/index.ts";

// Import the tsc-compiled output because standalone `node --import tsx`
// execution conflicts with Node's native .cts handling on newer releases.
// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
import * as policyBoundaryModule from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

const policyBoundary = (
  "default" in policyBoundaryModule ? policyBoundaryModule.default : policyBoundaryModule
) as typeof policyBoundaryModule;
const { parseOpenShellPolicy } = policyBoundary;

export function bindCredentialPolicyDocument(
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
  const endpoint = endpoints.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const value = candidate as { host?: unknown; port?: unknown; protocol?: unknown };
    return value.host === host && value.port === port && value.protocol === protocol;
  }) as Record<string, unknown> | undefined;
  if (!endpoint) throw new Error("credential-bound endpoint is missing from the base policy");

  endpoint.credential_binding = { provider: providerName };
  return YAML.stringify(policy);
}

export function applyCredentialPolicyBinding(options: {
  sandboxName: string;
  providerName: string;
  host: string;
  port: number;
  protocol: string;
}): void {
  const operation = `bind the ${options.providerName} credential policy endpoint`;
  const currentPolicy = captureRecordedSandboxBasePolicy(options.sandboxName, operation);
  const requestedPolicy = bindCredentialPolicyDocument(
    currentPolicy,
    options.providerName,
    options.host,
    options.port,
    options.protocol,
  );
  if (
    !setPolicyDocument(options.sandboxName, requestedPolicy, {
      nonFatal: true,
      operation,
    })
  ) {
    throw new Error(`failed to ${operation}`);
  }
}

function main(): void {
  const [sandboxName, providerName, host, rawPort, protocol] = process.argv.slice(2);
  const port = Number(rawPort);
  if (
    !sandboxName ||
    !providerName ||
    !host ||
    !rawPort ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !protocol
  ) {
    throw new Error(
      "usage: credential-policy-transaction <sandbox> <provider> <host> <port> <protocol>",
    );
  }
  applyCredentialPolicyBinding({ sandboxName, providerName, host, port, protocol });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
