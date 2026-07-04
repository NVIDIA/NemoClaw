// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parsePolicyContent,
  parseTraceLines,
  renderSimulationReport,
  simulate,
  summaryNeedsAttention,
} from "./simulate";

const SLACK_PRESET = {
  name: "slack",
  endpoints: [
    {
      host: "slack.com",
      port: 443,
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "POST", path: "/**" } },
      ],
    },
    {
      host: "*.slack.com",
      port: 443,
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "POST", path: "/**" } },
      ],
    },
  ],
};

const GITHUB_PRESET = {
  name: "github",
  endpoints: [
    {
      host: "api.github.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }],
    },
    {
      host: "raw.githubusercontent.com",
      port: 443,
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/**" } }],
    },
  ],
};

describe("parseTraceLines", () => {
  it("parses valid JSONL lines", () => {
    const lines = [
      '{"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}',
      '{"host":"api.github.com","port":443}',
    ];
    const trace = parseTraceLines(lines);
    expect(trace.requests).toHaveLength(2);
    expect(trace.invalidLines).toHaveLength(0);
    expect(trace.requests[0]).toMatchObject({ host: "api.slack.com", port: 443 });
    expect(trace.requests[1]).toMatchObject({ host: "api.github.com" });
  });

  it("skips blank lines and comment lines without reporting them invalid", () => {
    const lines = ["", "# comment", '{"host":"api.slack.com"}'];
    const trace = parseTraceLines(lines);
    expect(trace.requests).toHaveLength(1);
    expect(trace.invalidLines).toHaveLength(0);
  });

  it("reports lines without a host field as invalid with their line number", () => {
    const lines = ['{"host":"ok.example.com"}', '{"port":443,"method":"GET"}'];
    const trace = parseTraceLines(lines);
    expect(trace.requests).toHaveLength(1);
    expect(trace.invalidLines).toHaveLength(1);
    expect(trace.invalidLines[0].line).toBe(2);
    expect(trace.invalidLines[0].reason).toContain("host");
  });

  it("reports invalid JSON as invalid instead of silently dropping it", () => {
    const lines = ["not-json", '{"host":"api.slack.com"}'];
    const trace = parseTraceLines(lines);
    expect(trace.requests).toHaveLength(1);
    expect(trace.invalidLines).toHaveLength(1);
    expect(trace.invalidLines[0].line).toBe(1);
    expect(trace.invalidLines[0].reason).toBe("not valid JSON");
  });

  it("reports non-object JSON rows as invalid", () => {
    const trace = parseTraceLines(['["host","api.slack.com"]', '"just-a-string"']);
    expect(trace.requests).toHaveLength(0);
    expect(trace.invalidLines).toHaveLength(2);
  });
});

describe("simulate", () => {
  it("allows a request matching an active preset", () => {
    const req = { host: "api.slack.com", port: 443, method: "POST", path: "/api/chat.postMessage" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].allowedBy).toBe("slack");
  });

  it("marks a request as uncovered when no preset matches the host", () => {
    const req = { host: "api.openai.com", port: 443, method: "POST" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("uncovered");
  });

  it("allows requests to wildcard subdomains", () => {
    const req = { host: "files.slack.com", port: 443, method: "GET", path: "/files/foo" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("allowed");
  });

  it("does not let a single-label host wildcard cross DNS labels", () => {
    const req = { host: "a.b.slack.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("uncovered");
  });

  it("lets a double-star host wildcard cross DNS labels", () => {
    const deepPreset = {
      name: "deep",
      endpoints: [
        {
          host: "**.slack.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
        },
      ],
    };
    const req = { host: "a.b.slack.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], [deepPreset]);
    expect(summary.results[0].verdict).toBe("allowed");
  });

  it("reports blocked when the endpoint covers the host but denies the method", () => {
    const presetWithGetOnly = {
      name: "restricted",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
        },
      ],
    };
    const postReq = { host: "api.example.com", port: 443, method: "POST", path: "/x" };
    const getReq = { host: "api.example.com", port: 443, method: "GET", path: "/x" };
    const postSummary = simulate([postReq], [presetWithGetOnly]);
    const getSummary = simulate([getReq], [presetWithGetOnly]);
    expect(postSummary.results[0].verdict).toBe("blocked");
    expect(postSummary.blocked).toBe(1);
    expect(getSummary.results[0].verdict).toBe("allowed");
  });

  it("prefers allowed over blocked when a later preset permits the request", () => {
    const denyPreset = {
      name: "deny-get-only",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
        },
      ],
    };
    const allowPreset = {
      name: "allow-post",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "POST", path: "/**" } }],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443, method: "POST", path: "/x" };
    const summary = simulate([req], [denyPreset, allowPreset]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].allowedBy).toBe("allow-post");
  });

  it("counts multiple verdicts correctly", () => {
    const requests = [
      { host: "api.slack.com", port: 443, method: "POST", path: "/x" },
      { host: "api.github.com", port: 443, method: "GET", path: "/y" },
      { host: "evil.example.com", port: 80, method: "GET", path: "/z" },
    ];
    const summary = simulate(requests, [SLACK_PRESET, GITHUB_PRESET]);
    expect(summary.allowed).toBe(2);
    expect(summary.uncovered).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(summary.unknown).toBe(0);
  });

  it("uses first matching preset when multiple could match", () => {
    const req = { host: "api.slack.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], [SLACK_PRESET, GITHUB_PRESET]);
    expect(summary.results[0].allowedBy).toBe("slack");
  });

  it("allows monitor-mode endpoints regardless of rules", () => {
    const monitorPreset = {
      name: "monitor",
      endpoints: [{ host: "api.example.com", port: 443, enforcement: "monitor" }],
    };
    const req = { host: "api.example.com", port: 443, method: "DELETE", path: "/x" };
    const summary = simulate([req], [monitorPreset]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].matchedRule).toContain("monitor");
  });
});

describe("simulate fail-closed semantics", () => {
  it("reports unknown when the trace row lacks a method the rule constrains", () => {
    const req = { host: "api.slack.com", port: 443, path: "/x" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("unknown");
    expect(summary.results[0].reason).toContain("method/path");
    expect(summary.unknown).toBe(1);
  });

  it("reports unknown when the trace row lacks a path the rule constrains", () => {
    const pathScoped = {
      name: "path-scoped",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/api/*" } }],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443, method: "GET" };
    const summary = simulate([req], [pathScoped]);
    expect(summary.results[0].verdict).toBe("unknown");
  });

  it("still allows when the rule is fully wildcarded even if the row lacks fields", () => {
    const wildcard = {
      name: "wildcard",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "*", path: "/**" } }],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443 };
    const summary = simulate([req], [wildcard]);
    expect(summary.results[0].verdict).toBe("allowed");
  });

  it("reports unknown when the endpoint pins a port the trace row omits", () => {
    const req = { host: "api.slack.com", method: "GET", path: "/x" };
    const summary = simulate([req], [SLACK_PRESET]);
    expect(summary.results[0].verdict).toBe("unknown");
    expect(summary.results[0].reason).toContain("port");
  });

  it("reports unknown instead of allowed for endpoints with unevaluated constraints", () => {
    const constrained = {
      name: "constrained",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
          unevaluatedConstraints: ["allowed_ips", "protocol", "tls"],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], [constrained]);
    expect(summary.results[0].verdict).toBe("unknown");
    expect(summary.results[0].reason).toContain("allowed_ips");
    expect(summary.results[0].reason).toContain("protocol");
    expect(summary.results[0].reason).toContain("tls");
  });

  it("reports unknown for monitor endpoints that carry unevaluated constraints", () => {
    const monitorConstrained = {
      name: "monitor-constrained",
      endpoints: [
        {
          host: "api.example.com",
          enforcement: "monitor",
          unevaluatedConstraints: ["ancestry"],
        },
      ],
    };
    const req = { host: "api.example.com", method: "GET", path: "/x" };
    const summary = simulate([req], [monitorConstrained]);
    expect(summary.results[0].verdict).toBe("unknown");
    expect(summary.results[0].reason).toContain("ancestry");
  });

  it("lets unknown outrank a firm block from another endpoint", () => {
    const blocking = {
      name: "blocking",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "GET", path: "/**" } }],
        },
      ],
    };
    const maybeAllowing = {
      name: "maybe-allowing",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "POST", path: "/**" } }],
          unevaluatedConstraints: ["mcp"],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443, method: "POST", path: "/x" };
    const summary = simulate([req], [blocking, maybeAllowing]);
    expect(summary.results[0].verdict).toBe("unknown");
  });

  it("lets a proven allow outrank unknown from another endpoint", () => {
    const maybe = {
      name: "maybe",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "POST", path: "/**" } }],
          unevaluatedConstraints: ["tls"],
        },
      ],
    };
    const proven = {
      name: "proven",
      endpoints: [
        {
          host: "api.example.com",
          port: 443,
          enforcement: "enforce",
          rules: [{ allow: { method: "POST", path: "/**" } }],
        },
      ],
    };
    const req = { host: "api.example.com", port: 443, method: "POST", path: "/x" };
    const summary = simulate([req], [maybe, proven]);
    expect(summary.results[0].verdict).toBe("allowed");
    expect(summary.results[0].allowedBy).toBe("proven");
  });

  it("carries invalid trace lines into the summary", () => {
    const trace = parseTraceLines(["oops", '{"host":"api.slack.com","port":443}']);
    const summary = simulate(trace.requests, [SLACK_PRESET], trace.invalidLines);
    expect(summary.invalidTraceLines).toHaveLength(1);
    expect(summaryNeedsAttention(summary)).toBe(true);
  });
});

describe("summaryNeedsAttention", () => {
  it("is false only when every request is a proven allow and no rows were invalid", () => {
    const req = { host: "api.slack.com", port: 443, method: "POST", path: "/x" };
    const clean = simulate([req], [SLACK_PRESET]);
    expect(summaryNeedsAttention(clean)).toBe(false);
  });

  it("is true for blocked, uncovered, and unknown requests", () => {
    const blocked = simulate(
      [{ host: "api.github.com", port: 443, method: "POST", path: "/x" }],
      [GITHUB_PRESET],
    );
    const uncovered = simulate(
      [{ host: "nowhere.example.com", port: 443, method: "GET", path: "/x" }],
      [GITHUB_PRESET],
    );
    const unknown = simulate([{ host: "api.github.com", port: 443 }], [GITHUB_PRESET]);
    expect(summaryNeedsAttention(blocked)).toBe(true);
    expect(summaryNeedsAttention(uncovered)).toBe(true);
    expect(summaryNeedsAttention(unknown)).toBe(true);
  });
});

describe("parsePolicyContent", () => {
  it("parses preset endpoints from policy YAML", () => {
    const yaml = [
      "network_policies:",
      "  slack:",
      "    name: slack",
      "    endpoints:",
      "      - host: api.slack.com",
      "        port: 443",
      "        rules:",
      "          - allow: { method: POST, path: '/**' }",
    ].join("\n");
    const presets = parsePolicyContent(yaml);
    expect(presets).toHaveLength(1);
    expect(presets[0].endpoints[0].host).toBe("api.slack.com");
    expect(presets[0].endpoints[0].unevaluatedConstraints).toBeUndefined();
  });

  it("throws a descriptive error on invalid YAML", () => {
    expect(() => parsePolicyContent("a: [unclosed")).toThrow(/Invalid policy YAML/);
  });

  it("returns empty for YAML without network_policies", () => {
    expect(parsePolicyContent("preset:\n  name: x")).toHaveLength(0);
  });

  it("drops endpoints whose rules are mapping-shaped instead of a list", () => {
    const yaml = [
      "network_policies:",
      "  broken:",
      "    endpoints:",
      "      - host: api.example.com",
      "        rules:",
      "          allow: { method: GET }",
      "      - host: ok.example.com",
      "        rules:",
      "          - allow: { method: GET, path: '/**' }",
    ].join("\n");
    const presets = parsePolicyContent(yaml);
    expect(presets).toHaveLength(1);
    expect(presets[0].endpoints).toHaveLength(1);
    expect(presets[0].endpoints[0].host).toBe("ok.example.com");
  });

  it("records unevaluated endpoint constraints such as protocol, allowed_ips, and tls", () => {
    const yaml = [
      "network_policies:",
      "  hardened:",
      "    endpoints:",
      "      - host: api.example.com",
      "        port: 443",
      "        protocol: https",
      "        allowed_ips: ['203.0.113.7']",
      "        tls: { min_version: '1.3' }",
      "        rules:",
      "          - allow: { method: GET, path: '/**' }",
    ].join("\n");
    const presets = parsePolicyContent(yaml);
    const constraints = presets[0].endpoints[0].unevaluatedConstraints ?? [];
    expect(constraints).toContain("protocol");
    expect(constraints).toContain("allowed_ips");
    expect(constraints).toContain("tls");
    const req = { host: "api.example.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], presets);
    expect(summary.results[0].verdict).toBe("unknown");
  });

  it("records unevaluated rule keys such as deny and ancestry", () => {
    const yaml = [
      "network_policies:",
      "  denying:",
      "    endpoints:",
      "      - host: api.example.com",
      "        port: 443",
      "        rules:",
      "          - allow: { method: GET, path: '/**' }",
      "            ancestry: sandbox-only",
      "          - deny: { method: POST }",
    ].join("\n");
    const presets = parsePolicyContent(yaml);
    const constraints = presets[0].endpoints[0].unevaluatedConstraints ?? [];
    expect(constraints).toContain("rules.ancestry");
    expect(constraints).toContain("rules.deny");
    const req = { host: "api.example.com", port: 443, method: "GET", path: "/x" };
    const summary = simulate([req], presets);
    expect(summary.results[0].verdict).toBe("unknown");
  });

  it("records unevaluated allow keys such as allow.protocol", () => {
    const yaml = [
      "network_policies:",
      "  scoped:",
      "    endpoints:",
      "      - host: api.example.com",
      "        port: 443",
      "        rules:",
      "          - allow: { method: GET, path: '/**', protocol: https }",
    ].join("\n");
    const presets = parsePolicyContent(yaml);
    const constraints = presets[0].endpoints[0].unevaluatedConstraints ?? [];
    expect(constraints).toContain("rules.allow.protocol");
  });
});

describe("renderSimulationReport", () => {
  it("renders JSON when json=true", () => {
    const summary = simulate(
      [{ host: "api.slack.com", port: 443, method: "GET", path: "/x" }],
      [SLACK_PRESET],
    );
    const report = renderSimulationReport(summary, true);
    const parsed = JSON.parse(report) as { totalRequests: number; unknown: number };
    expect(parsed.totalRequests).toBe(1);
    expect(parsed.unknown).toBe(0);
  });

  it("renders human-readable report with the static-evaluation disclaimer", () => {
    const requests = [
      { host: "api.slack.com", port: 443, method: "POST", path: "/x" },
      { host: "unknown.example.com", port: 443, method: "GET", path: "/x" },
    ];
    const summary = simulate(requests, [SLACK_PRESET]);
    const report = renderSimulationReport(summary, false);
    expect(report).toContain("ALLOWED");
    expect(report).toContain("UNCOVERED");
    expect(report).toContain("slack");
    expect(report).toContain("static evaluation");
    expect(report).toContain("drift is not detected");
  });

  it("lists invalid trace rows and unknown verdicts with reasons", () => {
    const trace = parseTraceLines(["broken-row", '{"host":"api.slack.com","port":443}']);
    const summary = simulate(trace.requests, [SLACK_PRESET], trace.invalidLines);
    const report = renderSimulationReport(summary, false);
    expect(report).toContain("INVALID TRACE ROWS");
    expect(report).toContain("line 1: not valid JSON");
    expect(report).toContain("UNKNOWN");
    expect(report).toContain("method/path");
  });
});
