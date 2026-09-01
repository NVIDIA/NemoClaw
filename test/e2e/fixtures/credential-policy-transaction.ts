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

type CredentialRewrite = "request-body-credential-rewrite" | "websocket-credential-rewrite";

export type CredentialPolicyEndpointExpectation = {
  readonly providerName: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: "rest" | "websocket";
  readonly enforcement: "enforce";
  readonly credentialRewrite: CredentialRewrite;
  readonly methods: readonly string[];
  readonly allowedIps: readonly string[];
  readonly binaries: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactStrings(observed: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(observed) &&
    observed.every((value) => typeof value === "string") &&
    [...observed].sort().join("\n") === [...expected].sort().join("\n")
  );
}

function hasExactAllowRules(
  endpoint: Record<string, unknown>,
  methods: readonly string[],
): boolean {
  const rules = endpoint.rules;
  return (
    Array.isArray(rules) &&
    rules.length === methods.length &&
    methods.every((method) =>
      rules.some(
        (rule) =>
          isRecord(rule) &&
          isRecord(rule.allow) &&
          rule.allow.method === method &&
          rule.allow.path === "/**",
      ),
    )
  );
}

function hasExpectedCredentialRewrite(
  endpoint: Record<string, unknown>,
  expected: CredentialRewrite,
): boolean {
  if (endpoint.credential_rewrite !== undefined) {
    return endpoint.credential_rewrite === expected;
  }
  return expected === "request-body-credential-rewrite"
    ? endpoint.request_body_credential_rewrite === true &&
        endpoint.websocket_credential_rewrite !== true
    : endpoint.websocket_credential_rewrite === true &&
        endpoint.request_body_credential_rewrite !== true;
}

function hasExactBinaries(owner: Record<string, unknown>, expected: readonly string[]): boolean {
  const binaries = owner.binaries;
  return (
    Array.isArray(binaries) &&
    hasExactStrings(
      binaries.flatMap((binary) =>
        isRecord(binary) && typeof binary.path === "string" ? [binary.path] : [],
      ),
      expected,
    ) &&
    binaries.length === expected.length
  );
}

export function bindCredentialPolicyDocument(
  source: string,
  expected: CredentialPolicyEndpointExpectation,
): string {
  const policy = parseOpenShellPolicy(source).policy;
  const matches = Object.values(policy.network_policies ?? {}).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.endpoints)) return [];
    return entry.endpoints.flatMap((candidate) =>
      isRecord(candidate) &&
      candidate.host === expected.host &&
      candidate.port === expected.port &&
      candidate.protocol === expected.protocol
        ? [{ endpoint: candidate, owner: entry }]
        : [],
    );
  });
  if (matches.length !== 1) {
    throw new Error("credential-bound endpoint must have exactly one owner in the base policy");
  }
  const { endpoint, owner } = matches[0]!;
  const binding = endpoint.credential_binding;
  if (
    endpoint.enforcement !== expected.enforcement ||
    !hasExpectedCredentialRewrite(endpoint, expected.credentialRewrite) ||
    !hasExactAllowRules(endpoint, expected.methods) ||
    !hasExactStrings(endpoint.allowed_ips, expected.allowedIps) ||
    !hasExactBinaries(owner, expected.binaries) ||
    (binding !== undefined && (!isRecord(binding) || binding.provider !== expected.providerName))
  ) {
    throw new Error("credential-bound endpoint no longer matches the required policy controls");
  }

  endpoint.credential_binding = { provider: expected.providerName };
  return YAML.stringify(policy);
}

export function applyCredentialPolicyBinding(options: {
  sandboxName: string;
  endpoint: CredentialPolicyEndpointExpectation;
}): void {
  const operation = `bind the ${options.endpoint.providerName} credential policy endpoint`;
  const currentPolicy = captureRecordedSandboxBasePolicy(options.sandboxName, operation);
  const requestedPolicy = bindCredentialPolicyDocument(currentPolicy, options.endpoint);
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
  const [
    sandboxName,
    providerName,
    host,
    rawPort,
    protocol,
    enforcement,
    credentialRewrite,
    rawMethods,
    rawAllowedIps,
    ...binaries
  ] = process.argv.slice(2);
  const port = Number(rawPort);
  const methods = rawMethods?.split(",").filter(Boolean) ?? [];
  const allowedIps = rawAllowedIps?.split(",").filter(Boolean) ?? [];
  if (
    !sandboxName ||
    !providerName ||
    !host ||
    !rawPort ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (protocol !== "rest" && protocol !== "websocket") ||
    enforcement !== "enforce" ||
    (credentialRewrite !== "request-body-credential-rewrite" &&
      credentialRewrite !== "websocket-credential-rewrite") ||
    methods.length === 0 ||
    allowedIps.length === 0 ||
    binaries.length === 0
  ) {
    throw new Error(
      "usage: credential-policy-transaction <sandbox> <provider> <host> <port> <protocol> <enforcement> <credential-rewrite> <methods> <allowed-ips> <binary>...",
    );
  }
  applyCredentialPolicyBinding({
    sandboxName,
    endpoint: {
      providerName,
      host,
      port,
      protocol,
      enforcement,
      credentialRewrite,
      methods,
      allowedIps,
      binaries,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
