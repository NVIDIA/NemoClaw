// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../state/registry", () => ({
  getSandbox: vi.fn(),
}));

vi.mock(".", () => ({
  getPresetEndpoints: vi.fn(),
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
  classifyAccessFailure,
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
  vi.mocked(policies.listPresets).mockReset();
  vi.mocked(policies.listCustomPresets).mockReset();
  vi.mocked(policies.loadPreset).mockReset();
  vi.mocked(policies.getPresetEndpoints).mockReset();
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
    expect(ctx.knownUnappliedPresets.map((p) => p.name)).toEqual(["github"]);
    expect(ctx.approvalPath.inspect).toBe(`nemoclaw ${SANDBOX} policy list`);
    expect(ctx.approvalPath.add).toBe(`nemoclaw ${SANDBOX} policy add <preset>`);
    expect(ctx.supportBoundaries.some((b) => b.capability === "host allowlist enforcement"))
      .toBe(true);
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
});

describe("classifyAccessFailure", () => {
  it("returns missing-approval when the host is allowed but credentials are refused", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const result = classifyAccessFailure({
      sandboxName: SANDBOX,
      host: "api.slack.com",
      error: { status: 401 },
    });

    expect(result.kind).toBe("missing-approval");
    expect(result.matchedPreset).toBe("slack");
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
    expect(result.nextStep).toContain("policy add github");
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
});
