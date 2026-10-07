// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { prepareNativeLocalProfile } from "../../inference/native-local/profile";
type NativeLocalBinding = Parameters<typeof prepareNativeLocalProfile>[0];

type NativeBoundary = {
  id: string;
  credentialEnv: string;
  endpointUrl: string;
  allowedIps: readonly string[];
  binaries: readonly string[];
};

type NativeProfileResponse = Readonly<{
  profile: Readonly<{
    id: string;
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

function nativeCredential(value: unknown, credentialEnv: string): boolean {
  const credential = record(value);
  return (
    credential !== null &&
    credential.name === "api_key" &&
    stringArrayEquals(credential.envVars, [credentialEnv]) &&
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

function nativeEndpoint(value: unknown, expected: NativeBoundary): boolean {
  const url = new URL(expected.endpointUrl);
  const endpoint = record(value);
  const rules = endpoint?.rules;
  return (
    endpoint !== null &&
    endpoint.host === url.hostname &&
    endpoint.port === Number(url.port || (url.protocol === "https:" ? 443 : 80)) &&
    emptyArray(endpoint.ports) &&
    endpoint.protocol === "rest" &&
    endpoint.tls === "" &&
    endpoint.enforcement === "enforce" &&
    endpoint.access === "" &&
    Array.isArray(rules) &&
    rules.length === 2 &&
    nativeRule(rules[0], "GET", `${url.pathname}/models`) &&
    nativeRule(rules[1], "POST", `${url.pathname}/chat/completions`) &&
    stringArrayEquals(endpoint.allowedIps, expected.allowedIps) &&
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

function nativeBinaries(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  return stringArrayEquals(
    value.map((item) => record(item)?.path),
    expected,
  );
}

/** Verify the live custom profile at the credential, egress, and binary security boundary. */
function isManagedNativeProfileResponse(
  value: unknown,
  expected: NativeBoundary,
): value is NativeProfileResponse {
  const response = record(value);
  const profile = record(response?.profile);
  const revision = profile?.resourceVersion;
  const credentials = profile?.credentials;
  const endpoints = profile?.endpoints;
  return (
    profile !== null &&
    profile.id === expected.id &&
    profile.source === "user" &&
    (profile.scope === "platform" || profile.scope === "workspace") &&
    (typeof revision === "bigint" || typeof revision === "string") &&
    /^[1-9][0-9]*$/u.test(String(revision)) &&
    profile.inferenceCapable === true &&
    profile.discovery === undefined &&
    Array.isArray(credentials) &&
    credentials.length === 1 &&
    nativeCredential(credentials[0], expected.credentialEnv) &&
    Array.isArray(endpoints) &&
    endpoints.length === 1 &&
    nativeEndpoint(endpoints[0], expected) &&
    nativeBinaries(profile.binaries, expected.binaries)
  );
}

export function isManagedNativeNvidiaProfileResponse(
  value: unknown,
): value is NativeProfileResponse {
  return isManagedNativeProfileResponse(value, {
    id: "nemoclaw-nvidia-inference-v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    allowedIps: [],
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

export function isManagedNativeLocalProfileResponse(
  value: unknown,
  binding: NativeLocalBinding,
): value is NativeProfileResponse {
  const expected = prepareNativeLocalProfile(binding);
  const endpoint = expected.document.endpoints[0];
  if (!endpoint) return false;
  return isManagedNativeProfileResponse(value, {
    id: expected.profileId,
    credentialEnv: binding.credentialEnv,
    endpointUrl: binding.endpointUrl,
    allowedIps: endpoint.allowed_ips,
    binaries: expected.document.binaries,
  });
}
