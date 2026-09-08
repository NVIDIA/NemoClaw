// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildNetworkPolicyCurlProbe,
  parseNetworkPolicyCurlOutput,
} from "./network-policy-probe.ts";

describe("network-policy curl probe", () => {
  it("keeps the status format with its parser", () => {
    expect(buildNetworkPolicyCurlProbe("http://host.openshell.internal:1234/")).toContain(
      String.raw`-w '\nSTATUS_%{http_code}\n'`,
    );
  });

  it("quotes a URL as one shell argument", () => {
    expect(buildNetworkPolicyCurlProbe("http://host.openshell.internal:1234/'; echo UNSAFE")).toBe(
      String.raw`curl -sS --connect-timeout 10 --max-time 20 -w '\nSTATUS_%{http_code}\n' 'http://host.openshell.internal:1234/'\''; echo UNSAFE' 2>&1`,
    );
  });

  it.each([
    [
      "a terminal LF record",
      '{"detail":"policy_denied"}\nSTATUS_403\n',
      { response: '{"detail":"policy_denied"}', status: 403 },
    ],
    ["a terminal CRLF record", "denied\r\nSTATUS_403\r\n", { response: "denied", status: 403 }],
    [
      "response whitespace",
      "\n denied \n\nSTATUS_403\n",
      { response: "\n denied \n", status: 403 },
    ],
    [
      "status-like response text",
      '{"detail":"STATUS_403"}\nSTATUS_000\n',
      { response: '{"detail":"STATUS_403"}', status: 0 },
    ],
    ["no terminal record", '{"detail":"STATUS_403"}', null],
  ])("separates response and status from %s", (_label, output, expected) => {
    expect(parseNetworkPolicyCurlOutput(output)).toEqual(expected);
  });
});
