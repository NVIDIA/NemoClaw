// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

// Import compiled output. Node native `.cts` handling can intercept the source
// before tsx transforms it.
// sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
import * as policyBoundaryModule from "../../../nemoclaw/dist/shared/openshell-policy-boundary.cjs";

const policyBoundary = (
  "default" in policyBoundaryModule ? policyBoundaryModule.default : policyBoundaryModule
) as typeof policyBoundaryModule;
const { parseOpenShellPolicy } = policyBoundary;

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
