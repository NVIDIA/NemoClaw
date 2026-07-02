// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isProxyPolicyConnectDenial } from "../live/proxy-policy-denial.ts";

describe("isProxyPolicyConnectDenial", () => {
  it.each([
    "ERROR: ERR_PROXY_TUNNEL tunneling socket could not be established, statusCode=403",
    "ERROR: ERR_PROXY_TUNNEL tunneling socket could not be established, statusCode=407",
    "tunneling socket could not be established, statusCode=403",
    "cdn:ERROR_ERR_PROXY_TUNNEL",
  ])("treats a proxy CONNECT denial as a policy skip: %s", (output) => {
    expect(isProxyPolicyConnectDenial(output)).toBe(true);
  });

  it.each([
    "HTTP_403", // a real 403 response from the destination: reachable, not a proxy denial
    "api:HTTP_200 cdn:HTTP_403", // Discord CDN returned 403 itself; still reachable through the proxy
    "403 Forbidden", // arbitrary application body text
    "ERROR: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:443", // direct-connect refusal, not a tunnel error
    "ETIMEDOUT", // network timeout takes the unreachable path
    "socket hang up", // generic network error
    "", // no output
  ])("does not treat a non-tunnel outcome as a proxy denial: %s", (output) => {
    expect(isProxyPolicyConnectDenial(output)).toBe(false);
  });
});
