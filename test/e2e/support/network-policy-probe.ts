// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NETWORK_POLICY_RESULT_PREFIX = "NEMOCLAW_NETWORK_RESULT ";

/** Preserve the syscall error; curl's exit 7 also represents unrelated failures. */
export const NETWORK_POLICY_ERROR_REPORT = `console.log(${JSON.stringify(NETWORK_POLICY_RESULT_PREFIX)} + JSON.stringify({ errorCode: error.code ?? null, syscall: error.syscall ?? null }));`;

export function buildNetworkPolicyRequest(url: string): string[] {
  const script = `
const url = new URL(${JSON.stringify(url)});
const client = require(url.protocol === "https:" ? "node:https" : "node:http");
const request = client.get(url, { autoSelectFamily: false }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    body += chunk;
    if (body.length > 65536) request.destroy(new Error("response exceeded probe limit"));
  });
  response.on("end", () => console.log(${JSON.stringify(NETWORK_POLICY_RESULT_PREFIX)} + JSON.stringify({ status: response.statusCode, response: body })));
});
const deadline = setTimeout(() => request.destroy(new Error("probe deadline exceeded")), 20000);
request.on("close", () => clearTimeout(deadline));
request.on("error", (error) => { ${NETWORK_POLICY_ERROR_REPORT} });
`;
  return ["/usr/local/bin/node", "-e", script];
}

export function isNetworkPolicyDenial(result: {
  stdout: string;
  exitCode: number | null;
  timedOut?: boolean;
  signal?: string | null;
}): boolean {
  if (result.exitCode !== 0 || result.timedOut || result.signal) return false;
  const records = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(NETWORK_POLICY_RESULT_PREFIX));
  if (records.length !== 1) return false;
  try {
    const record = JSON.parse(records[0]!.slice(NETWORK_POLICY_RESULT_PREFIX.length));
    return (
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      ((record.errorCode === "EACCES" && record.syscall === "connect") ||
        (record.status === 403 &&
          typeof record.response === "string" &&
          /policy[_ ]denied|not allowed by any policy/iu.test(record.response)))
    );
  } catch {
    return false;
  }
}
