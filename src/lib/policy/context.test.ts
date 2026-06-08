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
import {
  buildPolicyContext,
  renderPolicyContextMarkdown,
} from "./context";

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

describe("buildPolicyContext", () => {
  it("partitions active presets from known unapplied presets and resolves the tier", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const ctx = buildPolicyContext(SANDBOX);

    expect(ctx.sandboxName).toBe(SANDBOX);
    expect(ctx.tier).toEqual({
      name: "balanced",
      label: "Balanced",
      description: "Full dev tooling and web search",
    });
    expect(ctx.activePresets.map((p) => p.name)).toEqual(["slack"]);
    expect(ctx.activePresets[0].allowedHostCategories).toEqual([
      "api.slack.com",
      "slack.com",
    ]);
    expect(ctx.activePresets[0].source).toBe("builtin");
    expect(ctx.activePresets[0].redactedHostCount).toBe(0);
    expect(ctx.activePresets[0].verification).toBe("gateway-unavailable");
    expect(ctx.knownUnappliedPresets.map((p) => p.name)).toEqual(["github"]);
    expect(ctx.approvalPath.inspect).toBe(`nemoclaw ${SANDBOX} policy-list`);
    expect(ctx.approvalPath.add).toBe(`nemoclaw ${SANDBOX} policy-add <preset>`);
    expect(ctx.approvalPath.remove).toBe(`nemoclaw ${SANDBOX} policy-remove <preset>`);
    expect(ctx.supportBoundaries.some((b) => b.capability === "host allowlist enforcement"))
      .toBe(true);
  });

  it("marks active presets as `verified` when the gateway agrees and `registry-only` when it disagrees", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack", "github"], policyTier: "balanced" });

    const ctx = buildPolicyContext(SANDBOX, { gatewayPresets: ["slack"] });

    const slack = ctx.activePresets.find((p) => p.name === "slack");
    const github = ctx.activePresets.find((p) => p.name === "github");
    expect(slack?.verification).toBe("verified");
    expect(github?.verification).toBe("registry-only");
  });

  it("surfaces presets enforced by the gateway but missing from the registry as `gateway-only` actives", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: [], policyTier: "balanced" });

    const ctx = buildPolicyContext(SANDBOX, { gatewayPresets: ["github"] });

    const github = ctx.activePresets.find((p) => p.name === "github");
    expect(github?.verification).toBe("gateway-only");
    expect(ctx.knownUnappliedPresets.some((p) => p.name === "github")).toBe(false);
  });

  it("redacts internal hostnames and IP ranges from allowedHostCategories and counts the drop", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(policies.listCustomPresets).mockReturnValue([
      { file: "internal.yaml", name: "internal", description: "internal API" },
    ]);
    vi.mocked(registry.getCustomPolicies).mockReturnValue([
      {
        name: "internal",
        content:
          "preset:\n  name: internal\nnetwork_policies:\n  internal:\n    endpoints:\n" +
          "      - host: 10.0.0.1\n" +
          "      - host: 192.168.1.10\n" +
          "      - host: 172.20.0.1\n" +
          "      - host: 127.0.0.1\n" +
          "      - host: 169.254.169.254\n" +
          "      - host: localhost\n" +
          "      - host: api.internal\n" +
          "      - host: gateway.local\n" +
          "      - host: shared.corp\n" +
          "      - host: public.example.com\n",
      },
    ]);
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: ["internal"], policyTier: undefined });

    const ctx = buildPolicyContext(SANDBOX);
    const internal = ctx.activePresets.find((p) => p.name === "internal");
    expect(internal?.allowedHostCategories).toEqual(["public.example.com"]);
    expect(internal?.redactedHostCount).toBeGreaterThanOrEqual(9);
  });

  it("handles a sandbox with no recorded tier and no applied presets", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: [], policyTier: undefined });

    const ctx = buildPolicyContext(SANDBOX);

    expect(ctx.tier).toBeNull();
    expect(ctx.activePresets).toEqual([]);
    expect(ctx.knownUnappliedPresets.map((p) => p.name)).toEqual(["github", "slack"]);
  });

  it("includes custom presets as active and tags their source", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(policies.listCustomPresets).mockReturnValue([
      { file: "internal.yaml", name: "internal", description: "custom preset" },
    ]);
    vi.mocked(policies.loadPreset).mockImplementation(
      (name: string) => PRESET_CONTENT[name] ?? null,
    );
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: ["internal"], policyTier: undefined });

    const ctx = buildPolicyContext(SANDBOX);
    const internal = ctx.activePresets.find((p) => p.name === "internal");
    expect(internal?.source).toBe("custom");
  });

  it("derives custom preset host stems from the registry-stored content, not loadPreset", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(policies.listCustomPresets).mockReturnValue([
      { file: "internal.yaml", name: "internal", description: "internal API" },
    ]);
    vi.mocked(registry.getCustomPolicies).mockReturnValue([
      {
        name: "internal",
        content: "preset:\n  name: internal\nnetwork_policies:\n  internal:\n    endpoints:\n      - host: internal.example.com\n",
      },
    ]);
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: ["internal"], policyTier: undefined });

    const ctx = buildPolicyContext(SANDBOX);
    const internal = ctx.activePresets.find((p) => p.name === "internal");
    expect(internal?.allowedHostCategories).toEqual(["internal.example.com"]);
  });
});

describe("renderPolicyContextMarkdown", () => {
  it("emits a redacted markdown summary with only host stems and no raw policy YAML", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const md = renderPolicyContextMarkdown(buildPolicyContext(SANDBOX));

    expect(md).toContain(`# Sandbox policy context: ${SANDBOX}`);
    expect(md).toContain("## Active presets");
    expect(md).toContain("`slack`");
    expect(md).toContain("api.slack.com");
    expect(md).toContain("## Approval and remediation");
    expect(md).toContain("## Failure classification");
    expect(md).not.toMatch(/enforcement:|websocket_credential_rewrite|binaries:/);
    expect(md).not.toMatch(/network_policies:/);
  });

  it("renders the verification status alongside each active preset", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const md = renderPolicyContextMarkdown(
      buildPolicyContext(SANDBOX, { gatewayPresets: ["slack"] }),
    );
    expect(md).toContain("status: verified");
  });
});
