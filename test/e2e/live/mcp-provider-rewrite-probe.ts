// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isNetworkPolicyDenial,
  NETWORK_POLICY_RESULT_PREFIX,
} from "../support/network-policy-probe.ts";

export function buildMcpProviderRewriteAuthorization(
  credentialKey: string,
  runtimeValue: string | undefined,
): string | null {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(credentialKey) ||
    runtimeValue === undefined ||
    /[\r\n]/u.test(runtimeValue)
  ) {
    return null;
  }
  const escapedCredentialKey = credentialKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const placeholderPattern = new RegExp(
    `^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${escapedCredentialKey}$`,
    "u",
  );
  return placeholderPattern.test(runtimeValue) ? `Bearer ${runtimeValue}` : null;
}

export function buildMcpCredentialHandleAuthorizationPattern(credentialKey: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(credentialKey)) {
    throw new Error("Unsafe MCP credential key");
  }
  const escapedCredentialKey = credentialKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return `^Bearer openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${escapedCredentialKey}$`;
}

export const MCP_PROVIDER_REWRITE_PROBE_SOURCE = `const https = require("node:https");
const buildMcpProviderRewriteAuthorization = ${buildMcpProviderRewriteAuthorization.toString()};
const NETWORK_POLICY_RESULT_PREFIX = ${JSON.stringify(NETWORK_POLICY_RESULT_PREFIX)};
const isNetworkPolicyDenial = ${isNetworkPolicyDenial.toString()};
const url = new URL(process.argv[2]);
const method = process.argv[3];
const expectation = process.argv[4];
const credentialKey = process.argv[5] || "FAKE_MCP_SECRET";
const toolName = process.argv[6] || "";
const authorization = buildMcpProviderRewriteAuthorization(credentialKey, process.env[credentialKey]);
if (authorization === null) {
  console.error("OpenShell did not project the expected endpoint-bound MCP credential placeholder");
  process.exit(2);
}
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(method === "tools/call" && toolName ? { params: { name: toolName, arguments: {} } } : {})
});
const req = https.request({
  hostname: url.hostname,
  autoSelectFamily: false,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    "content-length": Buffer.byteLength(body),
    "authorization": authorization
  }
}, (res) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    console.log(JSON.stringify({ status: res.statusCode, body: data }));
    const allowed = res.statusCode === 200 && data.includes('"result"');
    const denied = isNetworkPolicyDenial({ exitCode: 0, stdout: NETWORK_POLICY_RESULT_PREFIX + JSON.stringify({ status: res.statusCode, response: data }) });
    process.exit(expectation === "allow" ? (allowed ? 0 : 1) : (denied ? 0 : 1));
  });
});
req.on("error", (error) => {
  console.error(error.message);
  const record = NETWORK_POLICY_RESULT_PREFIX + JSON.stringify({ errorCode: error.code ?? null, syscall: error.syscall ?? null });
  console.log(record);
  process.exit(expectation !== "allow" && isNetworkPolicyDenial({ exitCode: 0, stdout: record }) ? 0 : 1);
});
req.end(body);
`;
