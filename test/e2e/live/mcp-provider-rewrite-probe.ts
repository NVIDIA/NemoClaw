// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function buildMcpProviderRewriteAuthorization(
  credentialKey: string,
  runtimeValue: string | undefined,
): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(credentialKey) || runtimeValue === undefined) {
    return null;
  }
  const escapedCredentialKey = credentialKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const placeholderPattern = new RegExp(
    `^openshell:resolve:env:(?:v[0-9]{1,20}_)?${escapedCredentialKey}$`,
    "u",
  );
  return placeholderPattern.test(runtimeValue) ? `Bearer ${runtimeValue}` : null;
}

export const MCP_PROVIDER_REWRITE_PROBE_SOURCE = `const https = require("node:https");
const buildMcpProviderRewriteAuthorization = ${buildMcpProviderRewriteAuthorization.toString()};
const url = new URL(process.argv[2]);
const method = process.argv[3];
const expectation = process.argv[4];
const credentialKey = process.argv[5] || "FAKE_MCP_SECRET";
const authorization = buildMcpProviderRewriteAuthorization(credentialKey, process.env[credentialKey]);
if (authorization === null) {
  console.error("OpenShell did not project the expected revisioned MCP credential placeholder");
  process.exit(2);
}
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method });
const req = https.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "authorization": authorization
  }
}, (res) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    console.log(JSON.stringify({ status: res.statusCode, body: data }));
    const allowed = res.statusCode === 200 && data.includes("fake_echo");
    const denied = res.statusCode === 403;
    process.exit(expectation === "allow" ? (allowed ? 0 : 1) : (denied ? 0 : 1));
  });
});
req.on("error", (error) => {
  console.error(error.message);
  const strictDenied = expectation === "deny-strict" && /HTTP\\/1\\.[01] 403 Forbidden/.test(error.message);
  strictDenied && console.log(JSON.stringify({ status: 403, error: error.message }));
  process.exit(expectation === "deny" || strictDenied ? 0 : 1);
});
req.end(body);
`;
