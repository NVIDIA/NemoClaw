// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MCP_PROVIDER_REWRITE_PROBE_SOURCE = `const https = require("node:https");
const url = new URL(process.argv[2]);
const method = process.argv[3];
const expectation = process.argv[4];
const credentialKey = process.argv[5] || "FAKE_MCP_SECRET";
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method });
const req = https.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "authorization": "Bearer openshell:resolve:env:" + credentialKey
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
