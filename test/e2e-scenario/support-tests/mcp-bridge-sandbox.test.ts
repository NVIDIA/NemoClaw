// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isExpectedMcpCurlPolicyDenial } from "../live/mcp-bridge-sandbox.ts";

function denialResult(
  overrides: {
    exitCode?: number | null;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  } = {},
) {
  return {
    exitCode: overrides.exitCode ?? 0,
    stderr: overrides.stderr ?? "",
    stdout: overrides.stdout ?? "",
    timedOut: overrides.timedOut ?? false,
  };
}

describe("MCP curl policy denial classification", () => {
  it("accepts an L7 HTTP 403 denial", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(denialResult({ stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=403\n" })),
    ).toBe(true);
  });

  it("accepts curl exit 56 only for a CONNECT proxy 403", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({
          exitCode: 56,
          stderr: "curl: (56) CONNECT tunnel failed, response 403\n",
          stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=\n",
        }),
      ),
    ).toBe(true);

    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ exitCode: 56, stderr: "curl: (56) Failure when receiving data" }),
      ),
    ).toBe(false);
  });

  it("rejects allowed, unrelated, and timed-out results", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(denialResult({ stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=200\n" })),
    ).toBe(false);
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ exitCode: 7, stderr: "curl: (7) Connection refused" }),
      ),
    ).toBe(false);
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({
          exitCode: 56,
          stderr: "curl: (56) CONNECT tunnel failed, response 403",
          timedOut: true,
        }),
      ),
    ).toBe(false);
  });
});
