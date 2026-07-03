// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPolicyDenialExecHint,
  maybeEmitPolicyDenialHint,
  POLICY_HINT_SUPPRESS_ENV,
  shouldProbePolicyDenial,
} from "./exec-policy-hint";

const DENIED_CURL_LINE =
  "[1783046573.602] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1245) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]";
const START_BEFORE_DENIAL = 1783046573000;
const START_AFTER_DENIAL = 1783046800000;

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
    "valid-lowercase",
    "valid-with-hyphens",
    "a".repeat(63),
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

describe("shouldProbePolicyDenial (#5978)", () => {
  it.each([
    ["success exit", 0, false, {}, false],
    ["genuine failure", 56, false, {}, true],
    ["failure but transport invocation error", 1, true, {}, false],
    ["failure but suppressed", 56, false, { [POLICY_HINT_SUPPRESS_ENV]: "1" }, false],
    [
      "failure with opt-out explicitly disabled",
      56,
      false,
      { [POLICY_HINT_SUPPRESS_ENV]: "0" },
      true,
    ],
  ])("decides probe-worthiness for %s", (_label, code, hadInvocationError, env, expected) => {
    expect(shouldProbePolicyDenial(code, hadInvocationError, env as NodeJS.ProcessEnv)).toBe(
      expected,
    );
  });
});

describe("maybeEmitPolicyDenialHint (#5978)", () => {
  // Base deps keep every case hermetic and instant: a no-op audit-enable and
  // log capture never touch the real openshell binary, a no-op sleep skips real
  // retry delays, and writeStderr records emitted lines. `enableCalls` proves
  // audit is enabled once regardless of retry count.
  const harness = () => {
    const lines: string[] = [];
    let enableCalls = 0;
    return {
      lines,
      enableCount: () => enableCalls,
      base: {
        env: {} as NodeJS.ProcessEnv,
        writeStderr: (line: string) => lines.push(line),
        sleep: async () => {},
        enableAudit: () => {
          enableCalls += 1;
        },
      },
    };
  };

  it("emits the breadcrumb on stderr for a failed command with a fresh denial", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toContain("nemoclaw oc-fresh logs --tail 50");
    expect(hint).toContain("example.com:443");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toBe(hint);
    expect(h.enableCount()).toBe(1);
  });

  it("emits the breadcrumb naming a bracketed IPv6 endpoint end to end", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () =>
          "[1783046573.602] [sandbox] NET:OPEN [MED] DENIED /usr/bin/curl(9) -> [2001:db8::1]:443 [reason:not allowed by any policy]",
      },
    );
    expect(hint).toContain("for [2001:db8::1]:443");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toBe(hint);
  });

  it("stays silent on a successful command", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      0,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("stays silent on an unrelated failure with no recent denial", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      2,
      false,
      START_AFTER_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("stays silent when the user sets the opt-out env", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        env: { [POLICY_HINT_SUPPRESS_ENV]: "1" },
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("degrades silently (no throw) when the log probe fails", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => {
          throw new Error("openshell logs unavailable");
        },
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("degrades silently (no throw) when the stderr sink fails", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
        writeStderr: () => {
          throw new Error("stderr unavailable");
        },
      },
    );
    expect(hint).toBeNull();
  });

  it("retries the probe until a settling denial event becomes visible", async () => {
    const h = harness();
    let calls = 0;
    const probeLogs = () => {
      calls += 1;
      return calls >= 2 ? DENIED_CURL_LINE : "";
    };
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs,
      },
    );
    expect(calls).toBe(2);
    expect(hint).toContain("example.com:443");
    expect(h.lines).toHaveLength(1);
    // Audit is enabled once up front, not re-enabled per retry.
    expect(h.enableCount()).toBe(1);
  });

  it("stops after the bounded number of attempts when no denial appears", async () => {
    const h = harness();
    let calls = 0;
    const probeLogs = () => {
      calls += 1;
      return "";
    };
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs,
        attempts: 3,
      },
    );
    expect(hint).toBeNull();
    expect(calls).toBe(3);
    expect(h.enableCount()).toBe(1);
    expect(h.lines).toHaveLength(0);
  });
});
