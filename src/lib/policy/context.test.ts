// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../state/registry", () => ({
  getSandbox: vi.fn(),
  getCustomPolicies: vi.fn(() => []),
  getBaselineExclusions: vi.fn(() => []),
}));

vi.mock(".", () => ({
  getBaselineExclusionRuntimeStatus: vi.fn(() => "excluded"),
  getPresetEndpoints: vi.fn(),
  getGatewayPresets: vi.fn(() => null),
  inspectPolicyMutationAuthority: vi.fn(() => ({ authority: "nemoclaw-managed" })),
  isAgentBasePreset: vi.fn(() => false),
  listCustomPresets: vi.fn(),
  listPresets: vi.fn(),
  loadPreset: vi.fn(),
  loadPresetForSandbox: vi.fn(),
}));

vi.mock("./tiers", () => ({
  getTier: vi.fn(),
}));

import * as registry from "../state/registry";
import * as policies from ".";
import { buildPolicyContext, renderPolicyContextMarkdown } from "./context";
import { getTier } from "./tiers";

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
  vi.mocked(policies.loadPreset).mockImplementation((name: string) => PRESET_CONTENT[name] ?? null);
  vi.mocked(policies.loadPresetForSandbox).mockImplementation(
    (_sandboxName: string, name: string) => PRESET_CONTENT[name] ?? null,
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

function stubRegistry(
  entry: Partial<{
    policies: string[];
    policyTier: string;
    policyAuthority: "nemoclaw-managed" | "externally-managed";
  }>,
) {
  vi.mocked(registry.getSandbox).mockReturnValue({
    name: SANDBOX,
    policies: entry.policies,
    policyTier: entry.policyTier ?? null,
    policyAuthority: entry.policyAuthority,
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
  vi.mocked(policies.loadPresetForSandbox).mockReset();
  vi.mocked(policies.getPresetEndpoints).mockReset();
  vi.mocked(policies.getGatewayPresets).mockReset();
  vi.mocked(policies.getGatewayPresets).mockReturnValue(null);
  vi.mocked(policies.inspectPolicyMutationAuthority).mockReset();
  vi.mocked(policies.inspectPolicyMutationAuthority).mockReturnValue({
    authority: "nemoclaw-managed",
  } as ReturnType<typeof policies.inspectPolicyMutationAuthority>);
  vi.mocked(policies.isAgentBasePreset).mockReset();
  vi.mocked(policies.isAgentBasePreset).mockReturnValue(false);
  vi.mocked(registry.getBaselineExclusions).mockReset();
  vi.mocked(registry.getBaselineExclusions).mockReturnValue([]);
  vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockReset();
  vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockReturnValue("excluded");
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
    expect(ctx.activePresets[0].allowedHostCategories).toEqual(["api.slack.com", "slack.com"]);
    expect(ctx.activePresets[0].source).toBe("builtin");
    expect(ctx.activePresets[0].redactedHostCount).toBe(0);
    expect(ctx.activePresets[0].verification).toBe("gateway-unavailable");
    expect(ctx.knownUnappliedPresets.map((p) => p.name)).toEqual(["github"]);
    expect(ctx.approvalPath.inspect).toBe(`nemoclaw ${SANDBOX} policy list`);
    expect(ctx.approvalPath.add).toBe(`nemoclaw ${SANDBOX} policy add <preset>`);
    expect(ctx.approvalPath.remove).toBe(`nemoclaw ${SANDBOX} policy remove <preset>`);
    expect(ctx.approvalPath.excludeBaseline).toBe(
      `nemoclaw ${SANDBOX} policy exclude <key> --dry-run`,
    );
    expect(ctx.approvalPath.restoreBaseline).toBe(`nemoclaw ${SANDBOX} policy restore <key>`);
    expect(ctx.supportBoundaries.some((b) => b.capability === "host allowlist enforcement")).toBe(
      true,
    );
    expect(ctx.supportBoundaries).toContainEqual({
      capability: "Shields transition",
      owner: "nemoclaw",
      note: "Shields up locks down mutable configuration",
    });
  });

  it("attributes externally managed policy changes only to the external authority (#9833)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({
      policies: [],
      policyTier: "balanced",
      policyAuthority: "externally-managed",
    });
    vi.mocked(policies.inspectPolicyMutationAuthority).mockReturnValue({
      authority: "externally-managed",
    } as ReturnType<typeof policies.inspectPolicyMutationAuthority>);
    vi.mocked(registry.getBaselineExclusions).mockReturnValue([
      {
        version: 1,
        agent: "openclaw",
        key: "nous_research",
        digest: "digest-1",
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
      },
    ]);
    vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockReturnValue("excluded");

    const context = buildPolicyContext(SANDBOX);
    const markdown = renderPolicyContextMarkdown(context);

    expect(context.tier).toBeNull();
    expect(getTier).not.toHaveBeenCalled();
    expect(context.supportBoundaries).toContainEqual({
      capability: "policy requirement selection and verification",
      owner: "nemoclaw",
      note: "NemoClaw selects preset and baseline requirements and verifies the live policy",
    });
    expect(context.supportBoundaries).toContainEqual({
      capability: "policy mutation",
      owner: "external",
      note: "the external policy authority applies each required add, remove, restore, or baseline exclusion to the live policy",
    });
    expect(context.supportBoundaries).toContainEqual({
      capability: "Shields state and configuration lock",
      owner: "nemoclaw",
      note: "NemoClaw retains Shields state and locks configuration after it verifies restrictive policy",
    });
    expect(context.approvalPath).toEqual({
      inspect: "nemoclaw alpha policy list",
      add: "Ask the external policy authority to add or replace the policy entries required by `<preset>`.",
      remove:
        "Ask the external policy authority to remove the policy entries supplied by `<preset>`.",
      excludeBaseline:
        "Run `nemoclaw alpha policy exclude <key> --dry-run`, then ask the external policy authority to remove baseline policy entry `<key>`.",
      restoreBaseline:
        "Ask the external policy authority to restore baseline policy entry `<key>`.",
      documentation: "docs/network-policy/customize-network-policy.mdx",
    });
    expect(markdown).toContain(
      "restore: Ask the external policy authority to restore baseline policy entry `<key>`.",
    );
    expect(markdown).toContain(
      "- restore a baseline entry: Ask the external policy authority to restore baseline policy entry `<key>`.",
    );
    expect(markdown).toContain(
      "- policy mutation (owner: external) — the external policy authority applies each required add, remove, restore, or baseline exclusion to the live policy",
    );
    expect(markdown).toContain(
      "- Shields state and configuration lock (owner: nemoclaw) — NemoClaw retains Shields state and locks configuration after it verifies restrictive policy",
    );
    expect(markdown).toContain(
      "- preview a baseline exclusion: Run `nemoclaw alpha policy exclude <key> --dry-run`, then ask the external policy authority to remove baseline policy entry `<key>`.",
    );
    expect(markdown).not.toContain(
      "- preview a baseline exclusion: `Run `nemoclaw alpha policy exclude <key> --dry-run`",
    );
    expect(markdown).not.toMatch(/nemoclaw alpha policy (?:add|remove|restore)(?:\s|`)/u);
  });

  it("does not advertise mutation commands when policy ownership is unknown (#9833)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });
    vi.mocked(policies.inspectPolicyMutationAuthority).mockImplementation(() => {
      throw new Error("receipt unavailable");
    });

    const context = buildPolicyContext(SANDBOX);

    expect(context.tier).toBeNull();
    expect(context.approvalPath.add).not.toContain("policy add");
    expect(context.approvalPath.remove).not.toContain("policy remove");
    expect(context.approvalPath.excludeBaseline).not.toContain("policy exclude");
    expect(context.approvalPath.restoreBaseline).not.toContain("policy restore");
    expect(context.supportBoundaries).toContainEqual({
      capability: "policy and Shields mutation",
      owner: "unknown",
      note: "NemoClaw refuses policy and Shields changes until it verifies policy ownership",
    });
  });

  it("does not inspect live policy authority when gateway probes are disabled (#9833)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const context = buildPolicyContext(SANDBOX, { skipGatewayProbe: true });

    expect(policies.inspectPolicyMutationAuthority).not.toHaveBeenCalled();
    expect(policies.getGatewayPresets).not.toHaveBeenCalled();
    expect(context.tier).toBeNull();
    expect(context.approvalPath.add).not.toContain("policy add");
    expect(context.supportBoundaries).toContainEqual({
      capability: "policy and Shields mutation",
      owner: "unknown",
      note: "NemoClaw refuses policy and Shields changes until it verifies policy ownership",
    });
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

  it("classifies a gateway-enforced agent-base preset as `agent-base`, not gateway-only drift (#9079)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    // Neither preset applied by the user; both enforced by the gateway. Only
    // `github` is an agent base-policy addition. The other must stay
    // gateway-only so genuine drift is still reported.
    stubRegistry({ policies: [], policyTier: "restricted" });
    vi.mocked(policies.isAgentBasePreset).mockImplementation(
      (_sandboxName: string, name: string) => name === "github",
    );

    const ctx = buildPolicyContext(SANDBOX, { gatewayPresets: ["slack", "github"] });

    const github = ctx.activePresets.find((p) => p.name === "github");
    const slack = ctx.activePresets.find((p) => p.name === "slack");
    expect(github?.verification).toBe("agent-base");
    expect(slack?.verification).toBe("gateway-only");
    // Agent-base preset is active (enforced), never suggested for `policy add`.
    expect(ctx.knownUnappliedPresets.some((p) => p.name === "github")).toBe(false);
  });

  it("does not reclassify an applied preset as agent-base even when the agent defines it (#9079)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    // `github` is both user-applied and an agent base addition; the user
    // intent (applied + enforced) must remain `verified`, not `agent-base`.
    stubRegistry({ policies: ["github"], policyTier: "restricted" });
    vi.mocked(policies.isAgentBasePreset).mockReturnValue(true);

    const ctx = buildPolicyContext(SANDBOX, { gatewayPresets: ["github"] });

    const github = ctx.activePresets.find((p) => p.name === "github");
    expect(github?.verification).toBe("verified");
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
        content:
          "preset:\n  name: internal\nnetwork_policies:\n  internal:\n    endpoints:\n      - host: internal.example.com\n",
      },
    ]);
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: ["internal"], policyTier: undefined });

    const ctx = buildPolicyContext(SANDBOX);
    const internal = ctx.activePresets.find((p) => p.name === "internal");
    expect(internal?.allowedHostCategories).toEqual(["internal.example.com"]);
  });

  it("reports baseline exclusions with a status per current digest agreement (#7194)", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(getTier).mockReturnValue(null);
    stubRegistry({ policies: [], policyTier: undefined });
    vi.mocked(registry.getBaselineExclusions).mockReturnValue([
      {
        version: 1,
        agent: "openclaw",
        key: "nous_research",
        digest: "digest-1",
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
      },
      {
        version: 1,
        agent: "openclaw",
        key: "changed_entry",
        digest: "digest-stale",
        acknowledgedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        version: 1,
        agent: "openclaw",
        key: "dropped_entry",
        digest: "digest-2",
        acknowledgedAt: "2026-07-17T00:00:00.000Z",
      },
    ]);
    const statuses: Record<string, "excluded" | "content-changed" | "no-longer-in-baseline"> = {
      nous_research: "excluded",
      changed_entry: "content-changed",
      dropped_entry: "no-longer-in-baseline",
    };
    vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockImplementation(
      (_sandbox, entry) => statuses[entry.key],
    );

    const ctx = buildPolicyContext(SANDBOX);

    expect(ctx.baselineExclusions).toEqual([
      {
        key: "changed_entry",
        digest: "digest-stale",
        acknowledgedAt: "2026-07-18T00:00:00.000Z",
        status: "content-changed",
        supportImpact:
          "Excluded egress leaves dependent agent features unsupported for this sandbox.",
      },
      {
        key: "dropped_entry",
        digest: "digest-2",
        acknowledgedAt: "2026-07-17T00:00:00.000Z",
        status: "no-longer-in-baseline",
        supportImpact:
          "Excluded egress leaves dependent agent features unsupported for this sandbox.",
      },
      {
        key: "nous_research",
        digest: "digest-1",
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
        status: "excluded",
        supportImpact:
          "Excluded egress leaves dependent agent features unsupported for this sandbox.",
      },
    ]);
  });

  it("surfaces an interrupted live-policy transaction as repair-required (#7178)", () => {
    resetMocks();
    mockBuiltinPresets();
    vi.mocked(getTier).mockReturnValue(null);
    vi.mocked(registry.getSandbox).mockReturnValue({
      name: SANDBOX,
      policies: [],
      baselineExclusionTransition: {
        id: "tx-1",
        operation: "exclude",
        exclusion: {
          version: 1,
          agent: "openclaw",
          key: "nous_research",
          digest: "digest-1",
          acknowledgedAt: "2026-07-19T00:00:00.000Z",
        },
        targetLiveDigest: null,
        startedAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const ctx = buildPolicyContext(SANDBOX);

    expect(ctx.baselineExclusions).toEqual([
      expect.objectContaining({
        key: "nous_research",
        status: "pending-exclude-repair",
      }),
    ]);
    const markdown = renderPolicyContextMarkdown(ctx);
    expect(markdown).toContain("repair-required");
    expect(markdown).toContain("exclude transaction was interrupted");
    expect(markdown).toContain("rebuild blocked");
  });

  it.each(["exclude", "restore"] as const)(
    "surfaces pending %s repair even when the release baseline is unreadable (#7194)",
    (operation) => {
      resetMocks();
      mockBuiltinPresets();
      vi.mocked(getTier).mockReturnValue(null);
      vi.mocked(registry.getBaselineExclusions).mockReturnValue([
        {
          version: 1,
          agent: "openclaw",
          key: "another_entry",
          digest: "c".repeat(64),
          acknowledgedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          version: 1,
          agent: "openclaw",
          key: "nous_research",
          digest: "a".repeat(64),
          acknowledgedAt: "2026-07-19T00:00:00.000Z",
        },
      ]);
      vi.mocked(registry.getSandbox).mockReturnValue({
        name: SANDBOX,
        policies: [],
        baselineExclusionTransition: {
          id: "00000000-0000-4000-8000-000000000001",
          operation,
          exclusion: {
            version: 1,
            agent: "openclaw",
            key: "nous_research",
            digest: "a".repeat(64),
            acknowledgedAt: "2026-07-19T00:00:00.000Z",
          },
          targetLiveDigest: operation === "restore" ? "b".repeat(64) : null,
          startedAt: "2026-07-19T00:00:00.000Z",
        },
      });
      vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockReturnValue("baseline-unreadable");

      const ctx = buildPolicyContext(SANDBOX);

      expect(ctx.baselineExclusions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "another_entry", status: "baseline-unreadable" }),
          expect.objectContaining({
            key: "nous_research",
            status: operation === "exclude" ? "pending-exclude-repair" : "pending-restore-repair",
          }),
        ]),
      );
      expect(ctx.baselineExclusions).toHaveLength(2);
      expect(policies.getBaselineExclusionRuntimeStatus).toHaveBeenCalledOnce();
      expect(policies.getBaselineExclusionRuntimeStatus).toHaveBeenCalledWith(
        SANDBOX,
        expect.objectContaining({ key: "another_entry" }),
      );
    },
  );
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

  it.each([
    {
      status: "verified",
      applied: ["slack"],
      gatewayPresets: ["slack"],
      agentBase: false,
    },
    {
      status: "registry-only",
      applied: ["slack"],
      gatewayPresets: [],
      agentBase: false,
    },
    {
      status: "gateway-only",
      applied: [],
      gatewayPresets: ["slack"],
      agentBase: false,
    },
    {
      status: "agent-base",
      applied: [],
      gatewayPresets: ["slack"],
      agentBase: true,
    },
    {
      status: "gateway-unavailable",
      applied: ["slack"],
      gatewayPresets: null,
      agentBase: false,
    },
  ])(
    "renders the $status verification status (#9079)",
    ({ status, applied, gatewayPresets, agentBase }) => {
      resetMocks();
      mockBuiltinPresets();
      stubTier();
      stubRegistry({ policies: applied, policyTier: "balanced" });
      vi.mocked(policies.isAgentBasePreset).mockReturnValue(agentBase);

      const md = renderPolicyContextMarkdown(buildPolicyContext(SANDBOX, { gatewayPresets }));

      expect(md).toContain(`status: ${status}`);
    },
  );

  it("states which verification statuses confirm gateway enforcement (#9079)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const md = renderPolicyContextMarkdown(
      buildPolicyContext(SANDBOX, { gatewayPresets: ["slack"] }),
    );

    expect(md).toContain(
      "`verified`, `gateway-only`, and `agent-base` mean the gateway confirms enforcement",
    );
    expect(md).toContain(
      "Treat `registry-only` and `gateway-unavailable` as advisory because the gateway has not confirmed the listed hosts",
    );
  });

  it("discloses excluded baseline entries and their support impact (#7194)", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });
    vi.mocked(registry.getBaselineExclusions).mockReturnValue([
      {
        version: 1,
        agent: "openclaw",
        key: "nous_research",
        digest: "digest-1",
        acknowledgedAt: "2026-07-19T00:00:00.000Z",
      },
    ]);
    vi.mocked(policies.getBaselineExclusionRuntimeStatus).mockReturnValue("excluded");

    const md = renderPolicyContextMarkdown(buildPolicyContext(SANDBOX));

    expect(md).toContain("## Baseline exclusions");
    expect(md).toContain("`nous_research`");
    expect(md).toContain("status: excluded");
    expect(md).toContain("Excluded egress leaves dependent agent features unsupported");
    expect(md).toContain("policy restore nous_research");
  });

  it("reports no baseline exclusions when none are recorded", () => {
    resetMocks();
    mockBuiltinPresets();
    stubTier();
    stubRegistry({ policies: ["slack"], policyTier: "balanced" });

    const md = renderPolicyContextMarkdown(buildPolicyContext(SANDBOX));

    expect(md).toContain("## Baseline exclusions");
    expect(md).toMatch(/## Baseline exclusions\n- none/);
  });
});
