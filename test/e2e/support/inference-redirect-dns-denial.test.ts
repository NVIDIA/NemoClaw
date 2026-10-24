// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  INFERENCE_CURL_HTTP_CODE_MARKER as marker,
  isExpectedMcpDnsPolicyDenial,
  waitForMcpCurlPolicyDenial,
} from "../fixtures/curl-policy-denial.ts";

const hostname = "host.openshell.internal";
const probe = {
  exitCode: 6,
  stdout: `HTTP/1.1 302 Found\r\nLocation: http://${hostname}:8000/v1/chat/completions\r\n\r\n${marker}302\n`,
  stderr: `curl: (6) Could not resolve host: ${hostname}\n`,
  timedOut: false,
  signal: null,
};
const before = { ...probe, exitCode: 0, stdout: "", stderr: "" };
const event = `[2.0] [sandbox] NET:REFUSE [MED] DENIED ${hostname} [reason:policy_dns_ineligible]`;
const after = { ...before, stdout: event };

describe("Native inference redirect DNS denial", () => {
  it.each(["policy_dns_ineligible", "policy_dns_no_valid_address"])(
    "accepts a matching redirect and fresh %s audit event",
    async (reason) => {
      expect(
        await waitForMcpCurlPolicyDenial(
          probe,
          before,
          async () => ({ ...after, stdout: event.replace("policy_dns_ineligible", reason) }),
          hostname,
          marker,
          "302",
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["stale event", probe, after, after],
    ["absent audit", probe, before, before],
    ["wrong host", probe, before, { ...after, stdout: event.replace(hostname, "other.test") }],
    [
      "resolver outage",
      probe,
      before,
      { ...after, stdout: event.replace("policy_dns_ineligible", "policy_dns_upstream_nxdomain") },
    ],
    [
      "different redirect",
      { ...probe, stdout: probe.stdout.replace(hostname, "other.test") },
      before,
      after,
    ],
    ["missing redirect response", { ...probe, stdout: `${marker}302\n` }, before, after],
    ["duplicate marker", { ...probe, stdout: `${probe.stdout}${marker}302\n` }, before, after],
    ["successful request", { ...probe, exitCode: 0 }, before, after],
    ["timeout", { ...probe, timedOut: true }, before, after],
    ["failed audit read", probe, before, { ...after, exitCode: 1 }],
  ] as const)("rejects %s", (_label, result, previous, current) => {
    expect(isExpectedMcpDnsPolicyDenial(result, previous, current, hostname, marker, "302")).toBe(
      false,
    );
  });
});
