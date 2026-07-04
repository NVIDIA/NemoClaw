// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildPolicyDenialExecHint, POLICY_HINT_SUPPRESS_ENV } from "./exec-policy-hint";

describe("buildPolicyDenialExecHint (#5978)", () => {
  const hint = buildPolicyDenialExecHint("nemoclaw", "oc-fresh", "example.com:443");

  it.each([
    ["the denied endpoint", "example.com:443"],
    ["the sandbox name", "oc-fresh"],
    ["the logs breadcrumb", "nemoclaw oc-fresh logs --tail 50"],
    ["the policy-list review breadcrumb", "nemoclaw oc-fresh policy-list"],
    ["the policy-add allow-path breadcrumb", "nemoclaw oc-fresh policy-add <preset>"],
    ["the opt-out env", POLICY_HINT_SUPPRESS_ENV],
  ])("names %s", (_label, expected) => {
    expect(hint).toContain(expected);
  });

  it("stays generic when the endpoint cannot be safely extracted", () => {
    const generic = buildPolicyDenialExecHint("nemoclaw", "oc-fresh", null);
    expect(generic).toContain("recent network policy denial detected inside sandbox 'oc-fresh'");
    expect(generic).toContain("nemoclaw oc-fresh logs --tail 50");
  });

  it("names a bracketed IPv6 endpoint verbatim", () => {
    const ipv6 = buildPolicyDenialExecHint("nemoclaw", "oc-fresh", "[2001:db8::1]:443");
    expect(ipv6).toContain("for [2001:db8::1]:443");
  });

  it.each([
    "a",
    "a-b",
    "a1",
    "a-b-c",
    "valid-lowercase",
    "valid-with-hyphens",
    "a".repeat(63),
    `${"a".repeat(61)}-b`,
  ])("renders a valid RFC-1123 sandbox name unchanged: %s", (valid) => {
    const hint = buildPolicyDenialExecHint("nemoclaw", valid, "example.com:443");
    expect(hint).toContain(`inside sandbox '${valid}'`);
    expect(hint).toContain(`nemoclaw ${valid} logs --tail 50`);
  });

  it.each([
    ["control characters / TTY escapes", "oc[31m\ninjected"],
    ["shell metacharacters", "oc; rm -rf /"],
    ["uppercase (not an RFC-1123 label)", "OC-Fresh"],
    ["over-length label", "a".repeat(64)],
  ])("renders the <name> placeholder for an unsafe sandbox name: %s", (_label, unsafe) => {
    const hint = buildPolicyDenialExecHint("nemoclaw", unsafe, "example.com:443");
    expect(hint).toContain("nemoclaw <name> logs --tail 50");
    expect(hint).toContain("nemoclaw <name> policy-add <preset>");
    expect(hint).not.toContain(unsafe);
    expect(hint).not.toContain("");
  });
});
