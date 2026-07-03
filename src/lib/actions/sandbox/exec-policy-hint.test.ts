// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPolicyDenialExecHint,
  extractDeniedEndpoint,
  findRecentPolicyDenial,
  isPolicyDenialLine,
  maybeEmitPolicyDenialHint,
  POLICY_HINT_SUPPRESS_ENV,
  shouldProbePolicyDenial,
} from "./exec-policy-hint";

// Real OpenShell OCSF audit lines captured from a restricted sandbox denying
// egress via the L7 proxy (the exact format the reporter's `logs --tail` shows).
const DENIED_CURL_LINE =
  "[1783046573.602] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1245) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]";
const DENIED_GIT_LINE =
  "[1783046885.833] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/lib/git-core/git-remote-http(3973) -> github.com:443 [policy:- engine:opa] [reason:endpoint github.com:443 is not allowed by any policy]";
const SSH_RELAY_INFO_LINE =
  "[1783046565.338] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] [msg:ssh relay open (channel_id=8e95bfe4, target=unix:/run/openshell/ssh.sock)]";
const PROXY_JSON_LINE =
  '{"detail":"CONNECT example.com:443 not permitted by policy","error":"policy_denied"}';

// A denial timestamp of 1783046573.602s parses to 1783046573602ms. Anchor the
// command-start stamps around it to exercise the recency window.
const START_BEFORE_DENIAL = 1783046573000;
const START_AFTER_DENIAL = 1783046800000;

describe("isPolicyDenialLine (#5978)", () => {
  it.each([
    ["OCSF NET:OPEN DENIED audit line", DENIED_CURL_LINE, true],
    ["proxy JSON policy_denied body", PROXY_JSON_LINE, true],
    ["bare reason phrasing", "endpoint host:443 is not allowed by any policy", true],
    ["NET:OPEN INFO ssh relay (not a denial)", SSH_RELAY_INFO_LINE, false],
    ["unrelated log line", "[123.0] [sandbox] [INFO ] flushed activity summary", false],
    ["empty line", "", false],
  ])("classifies %s", (_label, line, expected) => {
    expect(isPolicyDenialLine(line)).toBe(expected);
  });
});

describe("extractDeniedEndpoint (#5978)", () => {
  it.each([
    ["arrow target of a curl denial", DENIED_CURL_LINE, "example.com:443"],
    ["arrow target of a git denial", DENIED_GIT_LINE, "github.com:443"],
    [
      "ipv4 endpoint",
      "NET:OPEN DENIED x -> 93.184.216.34:443 [reason:blocked]",
      "93.184.216.34:443",
    ],
    [
      "ISO-timestamped proxy line (not the timestamp's HH:MM)",
      "2026-07-03T04:00:00Z proxy CONNECT example.com:443 policy_denied",
      "example.com:443",
    ],
  ])("extracts the safe host:port from %s", (_label, line, expected) => {
    expect(extractDeniedEndpoint(line)).toBe(expected);
  });

  it("returns null when no safe host:port token is present", () => {
    expect(extractDeniedEndpoint("NET:OPEN DENIED with no endpoint token")).toBeNull();
  });

  it("never renders a crafted control/newline payload as an endpoint", () => {
    const crafted = "NET:OPEN DENIED -> evil[31m.com:443\nINJECTED:1 [reason:x]";
    const endpoint = extractDeniedEndpoint(crafted) ?? "";
    expect(endpoint).not.toContain("");
    expect(endpoint).not.toContain("INJECTED");
    expect(endpoint).not.toContain("\n");
  });
});

describe("findRecentPolicyDenial (#5978)", () => {
  it("matches a denial logged after the command started and returns its endpoint", () => {
    const match = findRecentPolicyDenial(
      [SSH_RELAY_INFO_LINE, DENIED_CURL_LINE].join("\n"),
      START_BEFORE_DENIAL,
    );
    expect(match).toEqual({ endpoint: "example.com:443" });
  });

  it("ignores a denial that predates the command start (no spam on unrelated failures)", () => {
    expect(findRecentPolicyDenial(DENIED_CURL_LINE, START_AFTER_DENIAL)).toBeNull();
  });

  it("ignores non-denial NET:OPEN INFO lines even when recent", () => {
    expect(findRecentPolicyDenial(SSH_RELAY_INFO_LINE, START_BEFORE_DENIAL)).toBeNull();
  });

  it("returns the most recent denial when several are within the window", () => {
    const match = findRecentPolicyDenial(
      [DENIED_CURL_LINE, DENIED_GIT_LINE].join("\n"),
      START_BEFORE_DENIAL,
    );
    expect(match).toEqual({ endpoint: "github.com:443" });
  });

  it("returns null for empty log output", () => {
    expect(findRecentPolicyDenial("", START_BEFORE_DENIAL)).toBeNull();
  });

  // The DENIED_CURL_LINE timestamp 1783046573.602s parses to 1783046573602ms.
  // The cutoff is exact (no backward tolerance): a denial one millisecond before
  // the command started is a stale denial from a prior command and must not
  // trigger a hint, while one at the exact start millisecond counts.
  it("excludes a denial one millisecond before the command start (no backward skew)", () => {
    expect(findRecentPolicyDenial(DENIED_CURL_LINE, 1783046573603)).toBeNull();
  });

  it("includes a denial at the exact command-start millisecond", () => {
    expect(findRecentPolicyDenial(DENIED_CURL_LINE, 1783046573602)).toEqual({
      endpoint: "example.com:443",
    });
  });

  // A second-precision epoch stamp ([1783046573], no fraction) floors to
  // ...000ms; a command started mid-second must not filter out a denial that
  // truly happened later in that same second.
  const EPOCH_SECOND_DENIAL =
    "[1783046573] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";

  it("keeps a second-precision epoch denial when the command started mid-second", () => {
    expect(findRecentPolicyDenial(EPOCH_SECOND_DENIAL, 1783046573500)).toEqual({
      endpoint: "example.com:443",
    });
  });

  it("drops a second-precision epoch denial once the whole second predates the start", () => {
    expect(findRecentPolicyDenial(EPOCH_SECOND_DENIAL, 1783046574000)).toBeNull();
  });

  // Same granularity slack for a second-precision ISO gateway stamp.
  const ISO_SECOND_BASE = Date.parse("2026-07-03T04:00:00Z");
  const ISO_SECOND_DENIAL =
    "2026-07-03T04:00:00Z [gateway] policy_denied CONNECT example.com:443 not allowed by policy";

  it("keeps a second-precision ISO denial when the command started mid-second", () => {
    expect(findRecentPolicyDenial(ISO_SECOND_DENIAL, ISO_SECOND_BASE + 500)).toEqual({
      endpoint: "example.com:443",
    });
  });

  it("drops a second-precision ISO denial once the whole second predates the start", () => {
    expect(findRecentPolicyDenial(ISO_SECOND_DENIAL, ISO_SECOND_BASE + 1000)).toBeNull();
  });
});

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
    expect(calls).toBeGreaterThanOrEqual(2);
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
