// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type NativeNvidiaProfileResponse = Readonly<{
  profile: Readonly<{
    id: "nemoclaw-nvidia-inference-v1";
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

function nativeCredential(value: unknown): boolean {
  const credential = record(value);
  return (
    credential !== null &&
    credential.name === "api_key" &&
    stringArrayEquals(credential.envVars, ["NVIDIA_INFERENCE_API_KEY"]) &&
    credential.required === true &&
    credential.authStyle === "bearer" &&
    credential.headerName === "authorization" &&
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

function nativeEndpoint(value: unknown): boolean {
  const endpoint = record(value);
  const rules = endpoint?.rules;
  return (
    endpoint !== null &&
    endpoint.host === "integrate.api.nvidia.com" &&
    endpoint.port === 443 &&
    emptyArray(endpoint.ports) &&
    endpoint.protocol === "rest" &&
    endpoint.tls === "" &&
    endpoint.enforcement === "enforce" &&
    endpoint.access === "" &&
    Array.isArray(rules) &&
    rules.length === 2 &&
    nativeRule(rules[0], "GET", "/v1/models") &&
    nativeRule(rules[1], "POST", "/v1/chat/completions") &&
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
export function isManagedNativeNvidiaProfileResponse(
  value: unknown,
): value is NativeNvidiaProfileResponse {
  const response = record(value);
  const profile = record(response?.profile);
  const revision = profile?.resourceVersion;
  const credentials = profile?.credentials;
  const endpoints = profile?.endpoints;
  return (
    profile !== null &&
    profile.id === "nemoclaw-nvidia-inference-v1" &&
    profile.source === "user" &&
    (profile.scope === "platform" || profile.scope === "workspace") &&
    (typeof revision === "bigint" || typeof revision === "string") &&
    /^[1-9][0-9]*$/u.test(String(revision)) &&
    profile.inferenceCapable === true &&
    profile.discovery === undefined &&
    Array.isArray(credentials) &&
    credentials.length === 1 &&
    nativeCredential(credentials[0]) &&
    Array.isArray(endpoints) &&
    endpoints.length === 1 &&
    nativeEndpoint(endpoints[0]) &&
    nativeBinaries(profile.binaries)
  );
}
