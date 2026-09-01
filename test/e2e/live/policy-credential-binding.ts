// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { inspectPolicyMutationContext, setPolicyDocument } from "../../../src/lib/policy/index.ts";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";

type PolicyCredentialBindingOptions = {
  sandboxName: string;
  providerName: string;
  endpointHost: string;
  endpointPort: string | number;
  protocol: "rest" | "websocket";
};

export function policyDocumentWithEndpointCredentialBinding(
  source: string,
  providerName: string,
  host: string,
  port: number,
  protocol: "rest" | "websocket",
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
  if (endpoint.enforcement !== "enforce") {
    throw new Error(`fake endpoint ${host}:${port}/${protocol} must use enforcement: enforce`);
  }
  const rewriteControl =
    protocol === "rest" ? "request_body_credential_rewrite" : "websocket_credential_rewrite";
  if (endpoint[rewriteControl] !== true) {
    throw new Error(`fake endpoint ${host}:${port}/${protocol} must enable ${rewriteControl}`);
  }
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

function policyDocumentsMatch(left: string, right: string): boolean {
  return isDeepStrictEqual(parseOpenShellPolicy(left).policy, parseOpenShellPolicy(right).policy);
}

function policyDocumentHasRequestedBinding(
  document: string,
  options: PolicyCredentialBindingOptions,
): boolean {
  try {
    const boundDocument = policyDocumentWithEndpointCredentialBinding(
      document,
      options.providerName,
      options.endpointHost,
      Number(options.endpointPort),
      options.protocol,
    );
    return policyDocumentsMatch(boundDocument, document);
  } catch {
    return false;
  }
}

export function applyPolicyCredentialBinding(options: PolicyCredentialBindingOptions): void {
  const operation = `bind the ${options.providerName} credential provider`;
  const context = inspectPolicyMutationContext(options.sandboxName, operation);
  if (context.basePolicyDocument === undefined) {
    throw new Error(`sandbox base policy is unavailable while attempting to ${operation}`);
  }
  const requestedDocument = policyDocumentWithEndpointCredentialBinding(
    context.basePolicyDocument,
    options.providerName,
    options.endpointHost,
    Number(options.endpointPort),
    options.protocol,
  );
  const applied = setPolicyDocument(options.sandboxName, requestedDocument, {
    context,
    nonFatal: true,
    operation,
    reconciledDocumentIsAcceptable: (document) =>
      policyDocumentHasRequestedBinding(document, options),
  });
  if (!applied) {
    throw new Error(`failed to ${operation} for sandbox '${options.sandboxName}'`);
  }
}
