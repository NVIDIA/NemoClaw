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
const protocolVersion = "2025-11-25";
function finish(res, data, errorRecord) {
  const status = res?.statusCode;
  const record = NETWORK_POLICY_RESULT_PREFIX + JSON.stringify(errorRecord ?? { status, response: data });
  console.log(errorRecord ? record : JSON.stringify({ status, body: data }));
  const allowed = !errorRecord && status === 200 && data.includes('"result"');
  const denied = isNetworkPolicyDenial({ exitCode: 0, stdout: record });
  process.exit(expectation === "allow" ? (allowed ? 0 : 1) : (denied ? 0 : 1));
}
function send(payload, sessionHeaders, complete) {
const body = JSON.stringify(payload);
const req = https.request({
  hostname: url.hostname,
  autoSelectFamily: false,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "content-length": Buffer.byteLength(body),
    "authorization": authorization,
    ...sessionHeaders
  }
}, (res) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => complete(res, data));
});
req.on("error", (error) => {
  console.error(error.message);
  finish(undefined, undefined, { errorCode: error.code ?? null, syscall: error.syscall ?? null });
});
req.end(body);
}
send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
  protocolVersion, capabilities: {}, clientInfo: { name: "provider-rewrite-probe", version: "1" }
}}, {}, (initialized, data) => {
  let handshake;
  try { handshake = JSON.parse(data); } catch {}
  const sessionId = initialized.headers["mcp-session-id"];
  if (initialized.statusCode !== 200 || handshake?.id !== 0 || handshake?.error ||
      handshake?.result?.protocolVersion !== protocolVersion ||
      typeof sessionId !== "string" || !/^[\\x21-\\x7e]{1,512}$/.test(sessionId)) {
    finish(initialized, data, initialized.statusCode === 200 ? { errorCode: "MCP_INVALID_SESSION" } : undefined);
    return;
  }
  const sessionHeaders = { "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
  send({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders, (notified) => {
    if (notified.statusCode !== 202) {
      finish(undefined, undefined, { errorCode: "MCP_INITIALIZATION_NOT_ACKNOWLEDGED" });
      return;
    }
    send({ jsonrpc: "2.0", id: 1, method,
      ...(method === "tools/call" && toolName ? { params: { name: toolName, arguments: {} } } : {})
    }, sessionHeaders, finish);
  });
});
`;
