// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPolicyDenialExecHint,
  buildScopeUpgradeExecHint,
  hasPendingDeviceRequest,
  POLICY_HINT_SUPPRESS_ENV,
  SCOPE_UPGRADE_REQUEST_PLACEHOLDER,
  shouldProbeScopeUpgrade,
} from "./exec-policy-hint";

const REQUEST_ID = "4899d110-911f-4bc7-ac1a-85d76c7b366f";

describe("buildPolicyDenialExecHint (#5978)", () => {
  const hint = buildPolicyDenialExecHint("nemoclaw", "oc-fresh", "example.com:443");

  it.each([
    ["the denied endpoint", "example.com:443"],
    ["the sandbox name", "oc-fresh"],
    ["the logs breadcrumb", "nemoclaw oc-fresh logs --tail 50"],
    ["the policy-list review breadcrumb", "nemoclaw oc-fresh policy list"],
    ["the policy-add allow-path breadcrumb", "nemoclaw oc-fresh policy add <preset>"],
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
    "a".repeat(19),
    `${"a".repeat(17)}-b`,
  ])("renders a valid RFC-1123 sandbox name unchanged: %s", (valid) => {
    const hint = buildPolicyDenialExecHint("nemoclaw", valid, "example.com:443");
    expect(hint).toContain(`inside sandbox '${valid}'`);
    expect(hint).toContain(`nemoclaw ${valid} logs --tail 50`);
  });

  it.each([
    ["control characters / TTY escapes", "oc[31m\ninjected"],
    ["shell metacharacters", "oc; rm -rf /"],
    ["uppercase (not an RFC-1123 label)", "OC-Fresh"],
    ["over-length label", "a".repeat(20)],
  ])("renders the <name> placeholder for an unsafe sandbox name: %s", (_label, unsafe) => {
    const hint = buildPolicyDenialExecHint("nemoclaw", unsafe, "example.com:443");
    expect(hint).toContain("nemoclaw <name> logs --tail 50");
    expect(hint).toContain("nemoclaw <name> policy add <preset>");
    expect(buildScopeUpgradeExecHint("nemoclaw", unsafe)).toContain(
      "nemoclaw <name> exec -- openclaw devices list",
    );
    expect(hint).not.toContain(unsafe);
    expect(hint).not.toContain("");
  });
});

describe("buildScopeUpgradeExecHint (#9744)", () => {
  const hint = buildScopeUpgradeExecHint("nemoclaw", "my-assistant");

  it.each([
    ["the sandbox name", "waiting for approval inside sandbox 'my-assistant'"],
    ["the devices-list review breadcrumb", "nemoclaw my-assistant exec -- openclaw devices list"],
    [
      "the devices-approve remedy with the literal placeholder",
      `nemoclaw my-assistant exec -- openclaw devices approve ${SCOPE_UPGRADE_REQUEST_PLACEHOLDER}`,
    ],
    ["the review-before-approve instruction", "Approve the one you recognize"],
    ["the opt-out env", POLICY_HINT_SUPPRESS_ENV],
  ])("names %s", (_label, expected) => {
    expect(hint).toContain(expected);
  });

  it("never resolves the placeholder to a concrete request id", () => {
    expect(hint).not.toContain(REQUEST_ID);
    expect(buildScopeUpgradeExecHint("nemoclaw", "my-assistant")).toBe(hint);
  });
});

describe("hasPendingDeviceRequest (#9744)", () => {
  it.each([
    ["one pending request", JSON.stringify({ pending: [{ requestId: REQUEST_ID }] }), true],
    [
      "an unrelated admin-scope pending request",
      JSON.stringify({
        pending: [{ requestId: REQUEST_ID, device: "other", scopes: ["operator.admin"] }],
      }),
      true,
    ],
    ["several pending requests", JSON.stringify({ pending: [{}, {}] }), true],
    ["no pending requests", JSON.stringify({ pending: [] }), false],
    ["no pending key", JSON.stringify({ paired: [{ requestId: REQUEST_ID }] }), false],
    ["a non-array pending value", JSON.stringify({ pending: { requestId: REQUEST_ID } }), false],
    ["unparseable table output", "Pending (1)\nRequest  Device", false],
    ["a non-object payload", JSON.stringify([{ requestId: REQUEST_ID }]), false],
  ])("reports the expected presence for %s", (_label, output, expected) => {
    expect(hasPendingDeviceRequest(output)).toBe(expected);
  });
});

describe("shouldProbeScopeUpgrade (#9744)", () => {
  it.each([
    ["a failed openclaw command", 1, false, ["openclaw", "cron", "add"], {}, true],
    ["an absolute openclaw path", 1, false, ["/usr/bin/openclaw", "agent"], {}, true],
    ["a successful openclaw command", 0, false, ["openclaw", "cron", "add"], {}, false],
    ["a failed non-openclaw command", 1, false, ["curl", "example.com"], {}, false],
    ["an empty command", 1, false, [], {}, false],
    ["a transport invocation error", 1, true, ["openclaw", "cron", "add"], {}, false],
    [
      "a suppressed hint",
      1,
      false,
      ["openclaw", "cron", "add"],
      { [POLICY_HINT_SUPPRESS_ENV]: "1" },
      false,
    ],
  ])("decides %s", (_label, code, invocationError, command, env, expected) => {
    expect(shouldProbeScopeUpgrade(code, invocationError, command, env)).toBe(expected);
  });
});
