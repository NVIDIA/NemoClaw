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

export type NativeProfileBoundary = Readonly<{
  id: string;
  credentialEnv: string;
  authStyle: string;
  headerName: string;
  host: string;
  port: number;
  allowedIps: readonly string[];
  path: string;
  modelsPath: string;
  operationPath: string;
  binaries: readonly string[];
}>;

function nativeCredential(value: unknown, boundary: NativeProfileBoundary): boolean {
  const credential = record(value);
  return (
    credential !== null &&
    credential.name === "api_key" &&
    stringArrayEquals(credential.envVars, [boundary.credentialEnv]) &&
    credential.required === true &&
    credential.authStyle === boundary.authStyle &&
    credential.headerName === boundary.headerName &&
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

function nativeEndpoint(value: unknown, boundary: NativeProfileBoundary): boolean {
  const endpoint = record(value);
  const rules = endpoint?.rules;
  return (
    endpoint !== null &&
    endpoint.host === boundary.host &&
    endpoint.port === boundary.port &&
    emptyArray(endpoint.ports) &&
    endpoint.protocol === "rest" &&
    endpoint.tls === "" &&
    endpoint.enforcement === "enforce" &&
    endpoint.access === "" &&
    Array.isArray(rules) &&
    rules.length === 2 &&
    nativeRule(rules[0], "GET", boundary.modelsPath) &&
    nativeRule(rules[1], "POST", boundary.operationPath) &&
    stringArrayEquals(endpoint.allowedIps, boundary.allowedIps) &&
    emptyArray(endpoint.denyRules) &&
    endpoint.allowEncodedSlash === false &&
    endpoint.persistedQueries === "" &&
    emptyRecord(endpoint.graphqlPersistedQueries) &&
    endpoint.graphqlMaxBodyBytes === 0 &&
    endpoint.path === boundary.path &&
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

function nativeBinaries(value: unknown, boundary: NativeProfileBoundary): boolean {
  return (
    Array.isArray(value) &&
    stringArrayEquals(
      value.map((item) => record(item)?.path),
      boundary.binaries,
    )
  );
}

/** Verify the live custom profile at the credential, egress, and binary security boundary. */
export function isManagedNativeProfileResponse(
  value: unknown,
  boundary: NativeProfileBoundary,
): value is {
  profile: {
    id: string;
    source: "user";
    scope: "platform" | "workspace";
    resourceVersion: bigint | string;
  };
} {
  const response = record(value);
  const profile = record(response?.profile);
  const revision = profile?.resourceVersion;
  const credentials = profile?.credentials;
  const endpoints = profile?.endpoints;
  return (
    profile !== null &&
    profile.id === boundary.id &&
    profile.source === "user" &&
    (profile.scope === "platform" || profile.scope === "workspace") &&
    (typeof revision === "bigint" || typeof revision === "string") &&
    /^[1-9][0-9]*$/u.test(String(revision)) &&
    profile.inferenceCapable === true &&
    profile.discovery === undefined &&
    Array.isArray(credentials) &&
    credentials.length === 1 &&
    nativeCredential(credentials[0], boundary) &&
    Array.isArray(endpoints) &&
    endpoints.length === 1 &&
    nativeEndpoint(endpoints[0], boundary) &&
    nativeBinaries(profile.binaries, boundary)
  );
}

export function isManagedNativeNvidiaProfileResponse(
  value: unknown,
): value is NativeNvidiaProfileResponse {
  return isManagedNativeProfileResponse(value, {
    id: "nemoclaw-nvidia-inference-v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    authStyle: "bearer",
    headerName: "authorization",
    host: "integrate.api.nvidia.com",
    port: 443,
    allowedIps: [],
    path: "",
    modelsPath: "/v1/models",
    operationPath: "/v1/chat/completions",
    binaries: [
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/opt/hermes/.venv/bin/python",
      "/opt/hermes/.venv/bin/python3",
      "/opt/venv/bin/python3",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ],
  });
}
