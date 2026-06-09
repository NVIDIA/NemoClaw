// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../state/registry", () => ({
  getSandbox: vi.fn(),
  getCustomPolicies: vi.fn(() => []),
}));

vi.mock(".", () => ({
  getPresetEndpoints: vi.fn(),
  getGatewayPresets: vi.fn(() => null),
  listCustomPresets: vi.fn(),
  listPresets: vi.fn(),
  loadPreset: vi.fn(),
}));

vi.mock("./tiers", () => ({
  getTier: vi.fn(),
}));

import * as registry from "../state/registry";
import * as policies from ".";
import { getTier } from "./tiers";
import { classifyAccessFailure } from "./failure-classifier";

const SANDBOX = "alpha";

const SLACK_PRESET_YAML = `preset:
  name: slack
  description: Slack API access
network_policies:
  slack:
    endpoints:
      - host: slack.com
      - host: api.slack.com
`;

const GITHUB_PRESET_YAML = `preset:
  name: github
  description: GitHub API access
network_policies:
  github:
    endpoints:
      - host: api.github.com
`;

const PRESET_CONTENT: Record<string, string> = {
  slack: SLACK_PRESET_YAML,
  github: GITHUB_PRESET_YAML,
};

function mockBuiltinPresets() {
  vi.mocked(policies.listPresets).mockReturnValue([
    { file: "slack.yaml", name: "slack", description: "Slack API access" },
    { file: "github.yaml", name: "github", description: "GitHub API access" },
  ]);
  vi.mocked(policies.listCustomPresets).mockReturnValue([]);
  vi.mocked(policies.loadPreset).mockImplementation(
    (name: string) => PRESET_CONTENT[name] ?? null,
  );
  vi.mocked(policies.getPresetEndpoints).mockImplementation((content: string) => {
    const hosts: string[] = [];
    const regex = /host:\s*(\S+)/g;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(content)) !== null) {
      hosts.push(match[1]);
    }
    return hosts;
  });
}

function stubRegistry(entry: Partial<{ policies: string[]; policyTier: string }>) {
  vi.mocked(registry.getSandbox).mockReturnValue({
    name: SANDBOX,
    policies: entry.policies,
    policyTier: entry.policyTier ?? null,
  } as ReturnType<typeof registry.getSandbox>);
}

function stubTier() {
  vi.mocked(getTier).mockReturnValue({
    name: "balanced",
    label: "Balanced",
    description: "Full dev tooling and web search",
    presets: [],
  });
}

function resetMocks() {
  vi.mocked(registry.getSandbox).mockReset();
  vi.mocked(registry.getCustomPolicies).mockReset();
  vi.mocked(registry.getCustomPolicies).mockReturnValue([]);
  vi.mocked(policies.listPresets).mockReset();
  vi.mocked(policies.listCustomPresets).mockReset();
  vi.mocked(policies.loadPreset).mockReset();
  vi.mocked(policies.getPresetEndpoints).mockReset();
  vi.mocked(policies.getGatewayPresets).mockReset();
  vi.mocked(policies.getGatewayPresets).mockReturnValue(null);
  vi.mocked(getTier).mockReset();
}

describe("classifyAccessFailure", () => {
  it("returns high-confidence missing-approval when the host is on a gateway-verified preset and credentials return 401", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 401 },
      gatewayPresets: ["slack"],
    });

    expect(result.kind).toBe("missing-approval");
    expect(result.matchedPreset).toBe("slack");
    expect(result.confidence).toBe("high");
  });

  it("downgrades a matched 401 to low confidence when the preset is registry-only (gateway disagrees)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 401 },
      gatewayPresets: [],
    });

    expect(result.kind).toBe("missing-approval");
    expect(result.matchedPreset).toBe("slack");
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("drift");
    expect(result.nextStep).toContain("policy-list");
  });

  it("downgrades a matched 401 to low confidence when the gateway is unavailable", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 401 },
      gatewayPresets: null,
    });

    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("registry-derived");
  });

  it("returns low-confidence missing-approval when an active host returns 403 (ambiguous policy denial vs auth)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 403 },
    });

    expect(result.kind).toBe("missing-approval");
    expect(result.matchedPreset).toBe("slack");
    expect(result.confidence).toBe("low");
    expect(result.nextStep).toContain("openshell policy get");
  });

  it("returns blocked-by-policy when a known preset declares the host but is not applied", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.github.com",
      error: { code: "EHOSTUNREACH" },
    });

    expect(result.kind).toBe("blocked-by-policy");
    expect(result.matchedPreset).toBe("github");
    expect(result.nextStep).toContain("policy-add github");
  });

  it("returns blocked-by-policy when no preset declares the host and the request is refused", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "example.unknown",
      error: { status: 403 },
    });

    expect(result.kind).toBe("blocked-by-policy");
    expect(result.matchedPreset).toBeUndefined();
  });

  it("falls back to unknown when the failure is not a policy or approval signal", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { code: "ECONNRESET", status: 500 },
    });

    expect(result.kind).toBe("unknown");
    expect(result.matchedPreset).toBe("slack");
  });

  it("matches a subdomain against the preset host stem", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "edge.api.slack.com",
      error: { status: 403 },
    });

    expect(result.matchedPreset).toBe("slack");
  });

  it("returns unsupported when the caller declares the capability unavailable", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      capability: { supported: false, reason: "messaging not enabled for this agent" },
    });

    expect(result.kind).toBe("unsupported");
    expect(result.reason).toContain("messaging not enabled for this agent");
    expect(result.nextStep).toContain("Surface the limitation");
  });

  it("returns unsupported even when the host matches an applied preset", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 403 },
      capability: { supported: false },
    });

    expect(result.kind).toBe("unsupported");
  });

  it("classifies a verified-preset host hitting a network-block code as upstream-unknown, not blocked-by-policy", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { code: "EHOSTUNREACH" },
      gatewayPresets: ["slack"],
    });

    // Gateway confirms enforcement → the block code cannot mean the
    // gateway is denying the host; it must be upstream.
    expect(result.kind).toBe("unknown");
    expect(result.matchedPreset).toBe("slack");
    expect(result.confidence).toBe("high");
    expect(result.reason).toContain("EHOSTUNREACH");
    expect(result.reason).toContain("upstream");
  });

  it.each([
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ])("classifies a registry-only active-preset host hitting %s as blocked-by-policy with low confidence", (code) => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { code },
      gatewayPresets: [],
    });

    // Registry says allow but the gateway has not been confirmed to
    // enforce the preset (drift). The network-block code is the
    // strongest signal that the gateway is in fact blocking egress;
    // surface as blocked-by-policy so the agent reaches for
    // policy-list / policy-add rather than chasing an upstream issue.
    expect(result.kind).toBe("blocked-by-policy");
    expect(result.matchedPreset).toBe("slack");
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain(code);
    expect(result.nextStep).toContain("policy-list");
  });

  it("classifies a gateway-unavailable active-preset host hitting EHOSTUNREACH as blocked-by-policy advisory", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { code: "EHOSTUNREACH" },
      gatewayPresets: null,
    });

    expect(result.kind).toBe("blocked-by-policy");
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("registry-derived");
  });
});
