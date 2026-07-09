// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  extractDeniedEndpoint,
  findRecentPolicyDenial,
  isPolicyDenialLine,
} from "./exec-policy-hint";

// Real OpenShell OCSF audit lines captured from a restricted sandbox denying
// egress via the L7 proxy (the exact format the reporter's `logs --tail` shows).
const DENIED_CURL_LINE =
  "[1783046573.602] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1245) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]";
const DENIED_GIT_LINE =
  "[1783046885.833] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/lib/git-core/git-remote-http(3973) -> github.com:443 [policy:- engine:opa] [reason:endpoint github.com:443 is not allowed by any policy]";
const SSH_RELAY_INFO_LINE =
  "[1783046565.338] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] [msg:ssh relay open (channel_id=8e95bfe4, target=unix:/run/openshell/ssh.sock)]";
// Exact proxy JSON body captured alongside the OCSF lines above. Keep this
// fixture strict: speculative wording variants would widen false positives.
const PROXY_JSON_LINE =
  '{"detail":"CONNECT example.com:443 not permitted by policy","error":"policy_denied"}';
const INTERLEAVED_CURL_PROXY_JSON_LINE =
  'curl: (22) The reque{"detail":"POST host.openshell.internal:4318/v1/traces not permitted by policy","error":"policy_denied"}sted URL returned error: 403';

// A denial timestamp of 1783046573.602s parses to 1783046573602ms. Anchor the
// command-start stamps around it to exercise the recency window.
const START_BEFORE_DENIAL = 1783046573000;
const START_AFTER_DENIAL = 1783046800000;

describe("isPolicyDenialLine (#5978)", () => {
  it.each([
    ["OCSF NET:OPEN DENIED audit line", DENIED_CURL_LINE, true],
    [
      "bracketed OCSF NET:OPEN DENIED audit line",
      "[policy:-] [NET:OPEN] DENIED [reason:example.com:443 is not allowed by any policy]",
      true,
    ],
    [
      "OCSF NET:OPEN DENIED audit line for a bracketed IPv6 target",
      "[1783046573.602] [sandbox] NET:OPEN [MED] DENIED /usr/bin/curl(9) -> [2001:db8::1]:443 [reason:not allowed by any policy]",
      true,
    ],
    ["proxy JSON policy_denied body", PROXY_JSON_LINE, true],
    ["proxy JSON interleaved with curl stderr", INTERLEAVED_CURL_PROXY_JSON_LINE, true],
    [
      "forward proxy host denial body",
      '{"error":"policy_denied","detail":"POST example.com:4318/v1/traces not permitted by policy"}',
      true,
    ],
    [
      "forward proxy unmatched endpoint path body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/not-traces did not match an L7 endpoint path"}',
      true,
    ],
    [
      "forward proxy L7 method denial body",
      '{"error":"policy_denied","detail":"GET host.openshell.internal:4318/v1/traces denied by L7 policy: GET /v1/traces not permitted by policy"}',
      true,
    ],
    [
      "forward proxy L7 path denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/not-traces denied by L7 policy: POST /not-traces not permitted by policy"}',
      true,
    ],
    [
      "forward proxy explicit deny-rule body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/v1/traces denied by L7 policy: POST /v1/traces blocked by deny rule"}',
      true,
    ],
    [
      "forward proxy GraphQL policy denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/graphql denied by L7 policy: GraphQL operation blocked by endpoint policy"}',
      true,
    ],
    [
      "forward proxy unregistered GraphQL persisted-query denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/graphql denied by L7 policy: GraphQL persisted query is not registered"}',
      true,
    ],
    [
      "forward proxy GraphQL allow-policy denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/graphql denied by L7 policy: GraphQL operation not permitted by policy"}',
      true,
    ],
    [
      "forward proxy GraphQL parse denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/graphql denied by L7 policy: GraphQL request rejected: missing operation document"}',
      true,
    ],
    [
      "forward proxy JSON-RPC parse denial body",
      `{"error":"policy_denied","detail":"POST host.openshell.internal:4318/rpc denied by L7 policy: JSON-RPC request rejected: missing or non-string 'jsonrpc' field"}`,
      true,
    ],
    [
      "forward proxy JSON-RPC response-frame denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/rpc denied by L7 policy: JSON-RPC response frames are not permitted from client to server"}',
      true,
    ],
    [
      "forward proxy policy-engine fallback denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/rpc denied by L7 policy: request denied by policy"}',
      true,
    ],
    [
      "forward proxy policy-evaluation failure body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4318/rpc denied by L7 policy: L7 evaluation error: policy engine unavailable"}',
      true,
    ],
    [
      "forward proxy extension method denial body",
      '{"error":"policy_denied","detail":"PROPFIND host.openshell.internal:4318/resource not permitted by policy"}',
      true,
    ],
    [
      "forward proxy port denial body",
      '{"error":"policy_denied","detail":"POST host.openshell.internal:4319/v1/traces not permitted by policy"}',
      true,
    ],
    [
      "timestamp-prefixed proxy JSON policy_denied body",
      `[1783046573.602] [gateway] ${PROXY_JSON_LINE}`,
      true,
    ],
    ["NET:OPEN INFO ssh relay (not a denial)", SSH_RELAY_INFO_LINE, false],
    [
      "allowed NET:OPEN event with unrelated DENIED text",
      "[1000.500] NET:OPEN [INFO] ALLOWED -> example.com:443 [message=DENIED count 0]",
      false,
    ],
    [
      "config key containing the old policy_denied substring",
      "[1000.500] [config] policy_denied_threshold=5",
      false,
    ],
    [
      "unstructured policy prose",
      "[1000.500] [app] request not allowed by policy text in documentation",
      false,
    ],
    ["unstructured policy-cache prose", "[1000.500] [app] route not in policy cache key", false],
    [
      "JSON detail without the exact denial error code",
      '{"detail":"policy_denied is documented here","error":"configuration_notice"}',
      false,
    ],
    [
      "exact JSON error code without a structured proxy denial detail",
      '{"detail":"policy_denied is configured here","error":"policy_denied"}',
      false,
    ],
    [
      "forward proxy detail with an invalid endpoint",
      '{"error":"policy_denied","detail":"POST bad/host:4318/v1/traces not permitted by policy"}',
      false,
    ],
    [
      "forward proxy detail with a lowercase method",
      '{"error":"policy_denied","detail":"post example.com:4318/v1/traces not permitted by policy"}',
      false,
    ],
    [
      "forward proxy detail with an unsupported suffix",
      '{"error":"policy_denied","detail":"POST example.com:4318/v1/traces access denied"}',
      false,
    ],
    [
      "forward proxy L7 detail whose reason does not match its method",
      '{"error":"policy_denied","detail":"GET example.com:4318/v1/traces denied by L7 policy: POST /v1/traces not permitted by policy"}',
      false,
    ],
    [
      "forward proxy L7 detail whose reason does not match its path",
      '{"error":"policy_denied","detail":"GET example.com:4318/v1/traces denied by L7 policy: GET /other not permitted by policy"}',
      false,
    ],
    [
      "forward proxy L7 detail with an unknown policy reason",
      '{"error":"policy_denied","detail":"POST example.com:4318/v1/traces denied by L7 policy: arbitrary denial prose"}',
      false,
    ],
    [
      "forward proxy L7 evaluation detail with an empty error",
      '{"error":"policy_denied","detail":"POST example.com:4318/v1/traces denied by L7 policy: L7 evaluation error: "}',
      false,
    ],
    [
      "forward proxy L7 detail with control text in a dynamic reason",
      JSON.stringify({
        detail:
          "POST example.com:4318/graphql denied by L7 policy: GraphQL request rejected: bad\noperation",
        error: "policy_denied",
      }),
      false,
    ],
    [
      "proxy denial body with extra JSON fields",
      '{"error":"policy_denied","detail":"POST example.com:4318/v1/traces not permitted by policy","extra":true}',
      false,
    ],
    ["oversized structured proxy line", `${"x".repeat(4097)}${PROXY_JSON_LINE}`, false],
    [
      "oversized structured proxy detail",
      JSON.stringify({
        detail: `POST example.com:4318/${"a".repeat(1100)} not permitted by policy`,
        error: "policy_denied",
      }),
      false,
    ],
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
    [
      "bracketed IPv6 arrow target (kept whole, not split on its colons)",
      "NET:OPEN DENIED /usr/bin/curl(7) -> [2001:db8::1]:443 [reason:blocked]",
      "[2001:db8::1]:443",
    ],
    [
      "compressed IPv6 loopback arrow target",
      "NET:OPEN DENIED x -> [::1]:8080 [reason:blocked]",
      "[::1]:8080",
    ],
    [
      "bracketed IPv6 in a timestamped proxy fallback (no arrow)",
      "2026-07-03T04:00:00Z proxy CONNECT [2001:db8::1]:443 policy_denied",
      "[2001:db8::1]:443",
    ],
  ])("extracts the safe host:port from %s", (_label, line, expected) => {
    expect(extractDeniedEndpoint(line)).toBe(expected);
  });

  it("accepts a DNS endpoint at the 253-character hostname boundary", () => {
    const hostname = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(hostname).toHaveLength(253);
    expect(extractDeniedEndpoint(`NET:OPEN DENIED -> ${hostname}:443`)).toBe(`${hostname}:443`);
  });

  it("rejects a DNS endpoint beyond the 253-character hostname boundary", () => {
    const hostname = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63)].join(".");
    expect(hostname.length).toBeGreaterThan(253);
    expect(extractDeniedEndpoint(`NET:OPEN DENIED -> ${hostname}:443`)).toBeNull();
  });

  it("rejects an endpoint whose port is outside the network port range", () => {
    expect(extractDeniedEndpoint("NET:OPEN DENIED -> example.com:99999")).toBeNull();
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

  it("returns a bracketed IPv6 endpoint for a fresh IPv6 denial", () => {
    const ipv6Denial =
      "[1783046573.602] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(9) -> [2001:db8::1]:443 [reason:not allowed by any policy]";
    expect(findRecentPolicyDenial(ipv6Denial, START_BEFORE_DENIAL)).toEqual({
      endpoint: "[2001:db8::1]:443",
    });
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

  it("excludes a denial one millisecond before the command start (no backward skew)", () => {
    expect(findRecentPolicyDenial(DENIED_CURL_LINE, 1783046573603)).toBeNull();
  });

  it("includes a denial at the exact command-start millisecond", () => {
    expect(findRecentPolicyDenial(DENIED_CURL_LINE, 1783046573602)).toEqual({
      endpoint: "example.com:443",
    });
  });

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

  const ISO_SECOND_BASE = Date.parse("2026-07-03T04:00:00Z");
  const ISO_SECOND_DENIAL =
    '2026-07-03T04:00:00Z [gateway] {"detail":"CONNECT example.com:443 not permitted by policy","error":"policy_denied"}';

  it("keeps a second-precision ISO denial when the command started mid-second", () => {
    expect(findRecentPolicyDenial(ISO_SECOND_DENIAL, ISO_SECOND_BASE + 500)).toEqual({
      endpoint: "example.com:443",
    });
  });

  it("drops a second-precision ISO denial once the whole second predates the start", () => {
    expect(findRecentPolicyDenial(ISO_SECOND_DENIAL, ISO_SECOND_BASE + 1000)).toBeNull();
  });
});
