// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NATIVE_HOSTED_PROFILES,
  type NativeHostedProfile,
} from "../../inference/native-hosted/profiles";

type NativeHostedProfileResponse = Readonly<{
  profile: Readonly<{
    id: NativeHostedProfile["profileId"];
    source: "user";
    scope: "platform" | "workspace";
    resourceVersion: bigint | string;
  }>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function emptyRecord(value: unknown): boolean {
  const row = record(value);
  return row !== null && Object.keys(row).length === 0;
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function nativeCredential(value: unknown, expected: NativeHostedProfile): boolean {
  const credential = record(value);
  return (
    credential !== null &&
    credential.name === "api_key" &&
    stringArrayEquals(credential.envVars, [expected.credentialEnv]) &&
    credential.required === true &&
    credential.authStyle ===
      (expected.logicalProvider === "anthropic-prod" ? "header" : "bearer") &&
    credential.headerName ===
      (expected.logicalProvider === "anthropic-prod" ? "x-api-key" : "authorization") &&
    credential.queryParam === "" &&
    credential.pathTemplate === "" &&
    credential.refresh === undefined &&
    credential.tokenGrant === undefined
  );
}

function nativeRule(value: unknown, method: "GET" | "POST", path: string): boolean {
  const rule = record(value);
  const allow = record(rule?.allow);
  return (
    rule !== null &&
    allow !== null &&
    allow.method === method &&
    allow.path === path &&
    allow.command === "" &&
    emptyRecord(allow.query) &&
    allow.operationType === "" &&
    allow.operationName === "" &&
    emptyArray(allow.fields) &&
    emptyRecord(allow.params)
  );
}

function nativeEndpoint(value: unknown, expected: NativeHostedProfile): boolean {
  const url = new URL(expected.endpoint);
  const prefix = url.pathname === "/" ? "/v1" : url.pathname;
  const expectedRules: ReadonlyArray<readonly ["GET" | "POST", string]> = [
    ["GET", `${prefix}/models`],
    [
      "POST",
      `${prefix}/${expected.logicalProvider === "anthropic-prod" ? "messages" : "chat/completions"}`,
    ],
    ...(["openai-api", "hermes-provider"].includes(expected.logicalProvider)
      ? [["POST", `${prefix}/responses`] as const]
      : []),
  ];
  const endpoint = record(value);
  const rules = endpoint?.rules;
  return (
    endpoint !== null &&
    endpoint.host === url.hostname &&
    endpoint.port === 443 &&
    emptyArray(endpoint.ports) &&
    endpoint.protocol === "rest" &&
    endpoint.tls === "" &&
    endpoint.enforcement === "enforce" &&
    endpoint.access === "" &&
    Array.isArray(rules) &&
    rules.length === expectedRules.length &&
    expectedRules.every(([method, path], index) => nativeRule(rules[index], method, path)) &&
    emptyArray(endpoint.allowedIps) &&
    emptyArray(endpoint.denyRules) &&
    endpoint.allowEncodedSlash === false &&
    endpoint.persistedQueries === "" &&
    emptyRecord(endpoint.graphqlPersistedQueries) &&
    endpoint.graphqlMaxBodyBytes === 0 &&
    endpoint.path === "" &&
    endpoint.websocketCredentialRewrite === false &&
    endpoint.requestBodyCredentialRewrite === false &&
    endpoint.advisorProposed === false &&
    endpoint.credentialSigning === "" &&
    endpoint.signingService === "" &&
    endpoint.signingRegion === "" &&
    endpoint.jsonRpcMaxBodyBytes === 0 &&
    endpoint.mcp === undefined &&
    endpoint.credentialBinding === undefined
  );
}

function nativeBinaries(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const paths = value.map((item) => record(item)?.path);
  return stringArrayEquals(paths, [
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/hermes/.venv/bin/python",
    "/opt/hermes/.venv/bin/python3",
    "/opt/venv/bin/python3",
    "/usr/local/bin/curl",
    "/usr/bin/curl",
  ]);
}

/** Verify the live custom profile at the credential, egress, and binary security boundary. */
export function isManagedNativeHostedProfileResponse(
  value: unknown,
  expected: NativeHostedProfile,
): value is NativeHostedProfileResponse {
  const response = record(value);
  const profile = record(response?.profile);
  const revision = profile?.resourceVersion;
  const credentials = profile?.credentials;
  const endpoints = profile?.endpoints;
  return (
    NATIVE_HOSTED_PROFILES.includes(expected) &&
    profile !== null &&
    profile.id === expected.profileId &&
    profile.source === "user" &&
    (profile.scope === "platform" || profile.scope === "workspace") &&
    (typeof revision === "bigint" || typeof revision === "string") &&
    /^[1-9][0-9]*$/u.test(String(revision)) &&
    profile.inferenceCapable === true &&
    profile.discovery === undefined &&
    Array.isArray(credentials) &&
    credentials.length === 1 &&
    nativeCredential(credentials[0], expected) &&
    Array.isArray(endpoints) &&
    endpoints.length === 1 &&
    nativeEndpoint(endpoints[0], expected) &&
    nativeBinaries(profile.binaries)
  );
}
