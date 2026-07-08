// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type PresetInfo = {
  name: string;
  description?: string;
};

const moduleMocks = vi.hoisted(() => ({
  getSandbox: vi.fn<(sandboxName: string) => Record<string, unknown> | null>(),
  getCustomPolicies: vi.fn<(sandboxName: string) => PresetInfo[]>(),
  listPresets: vi.fn<(options?: { agent?: string | null }) => PresetInfo[]>(),
  listCustomPresets: vi.fn<(sandboxName: string) => PresetInfo[]>(),
  getAppliedPresets: vi.fn<(sandboxName: string) => string[]>(),
  getGatewayPresets: vi.fn<(sandboxName: string) => string[] | null>(),
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: moduleMocks.getSandbox,
  getCustomPolicies: moduleMocks.getCustomPolicies,
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  listPresets: moduleMocks.listPresets,
  listCustomPresets: moduleMocks.listCustomPresets,
  getAppliedPresets: moduleMocks.getAppliedPresets,
  getGatewayPresets: moduleMocks.getGatewayPresets,
}));

import { listSandboxPolicies } from "./policy-channel";

const POLICY_PRESETS: PresetInfo[] = [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index access" },
  { name: "discord", description: "Discord API access" },
  { name: "openclaw-pricing", description: "OpenClaw pricing lookup" },
  { name: "nous-web", description: "Nous Portal managed web search gateway" },
];

let logSpy: MockInstance;
let errSpy: MockInstance;

function printedText(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
}

function arrangeListing({
  appliedNames,
  gatewayNames,
  tier,
  agent,
}: {
  appliedNames: string[];
  gatewayNames: string[] | null;
  tier: string | null;
  agent: string | null;
}): void {
  moduleMocks.getSandbox.mockReturnValue({
    name: "test-sandbox",
    agent,
    policyTier: tier,
    policies: appliedNames,
  });
  moduleMocks.getAppliedPresets.mockReturnValue(appliedNames);
  moduleMocks.getGatewayPresets.mockReturnValue(gatewayNames);
}

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  moduleMocks.getCustomPolicies.mockReturnValue([]);
  moduleMocks.listPresets.mockReturnValue(POLICY_PRESETS);
  moduleMocks.listCustomPresets.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listSandboxPolicies provenance", () => {
  it("tags active tier-default presets with their tier provenance (#5774)", () => {
    arrangeListing({
      appliedNames: ["npm", "pypi"],
      gatewayNames: ["npm", "pypi"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).toContain("● npm [from balanced tier]");
    expect(output).toContain("● pypi [from balanced tier]");
  });

  it("keeps tier attribution when a custom registry entry shadows a tier preset (#5774)", () => {
    moduleMocks.getCustomPolicies.mockReturnValue([
      { name: "npm", description: "sandbox-scoped custom npm policy" },
    ]);
    arrangeListing({
      appliedNames: ["npm"],
      gatewayNames: ["npm"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).toContain("● npm [from balanced tier]");
    expect(output).not.toContain("● npm [user-added]");
  });

  it("tags openclaw-pricing as an OpenClaw agent preset (#5774)", () => {
    arrangeListing({
      appliedNames: ["openclaw-pricing"],
      gatewayNames: ["openclaw-pricing"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    expect(printedText()).toContain("● openclaw-pricing [from openclaw agent]");
  });

  it("tags nous-* presets as Hermes agent presets on Hermes (#5774)", () => {
    arrangeListing({
      appliedNames: ["nous-web"],
      gatewayNames: ["nous-web"],
      tier: "open",
      agent: "hermes",
    });

    listSandboxPolicies("test-sandbox");

    expect(printedText()).toContain("● nous-web [from hermes agent]");
  });

  it("tags presets outside the tier and agent defaults as user-added (#5774)", () => {
    arrangeListing({
      appliedNames: ["discord"],
      gatewayNames: ["discord"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    expect(printedText()).toContain("● discord [user-added]");
  });

  it("omits the provenance tag for inactive presets (#5774)", () => {
    arrangeListing({
      appliedNames: ["npm"],
      gatewayNames: ["npm"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).toMatch(/○ pypi —/);
    expect(output).not.toMatch(/○ pypi \[/);
  });

  it("omits channel policy presets that are not available for the sandbox agent (#6185)", () => {
    arrangeListing({
      appliedNames: [],
      gatewayNames: [],
      tier: "balanced",
      agent: "langchain-deepagents-code",
    });
    moduleMocks.listPresets.mockImplementation((options) =>
      options?.agent === "langchain-deepagents-code"
        ? [
            { name: "npm", description: "npm and Yarn registry access" },
            { name: "pypi", description: "Python Package Index access" },
          ]
        : POLICY_PRESETS,
    );

    listSandboxPolicies("test-sandbox");

    expect(moduleMocks.listPresets).toHaveBeenCalledWith({
      agent: "langchain-deepagents-code",
    });
    const output = printedText();
    expect(output).toContain("○ npm");
    expect(output).not.toContain("discord");
    expect(output).not.toContain("telegram");
  });

  it.each([
    {
      agent: "hermes",
      preset: "openclaw-pricing",
      forbidden: "[from openclaw agent]",
    },
    { agent: "openclaw", preset: "nous-web", forbidden: "[from hermes agent]" },
  ])("does not use another agent's provenance for $preset (#5774)", ({
    agent,
    preset,
    forbidden,
  }) => {
    arrangeListing({
      appliedNames: [preset],
      gatewayNames: [preset],
      tier: "balanced",
      agent,
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).toContain(`● ${preset} [user-added]`);
    expect(output).not.toContain(forbidden);
  });

  it("falls back to user-added when policyTier is missing (#5774)", () => {
    arrangeListing({
      appliedNames: ["npm"],
      gatewayNames: ["npm"],
      tier: null,
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).toContain("● npm [user-added]");
    expect(output).not.toContain("[from balanced tier]");
  });

  it("does not trust tier provenance for gateway-only desync (#5774)", () => {
    arrangeListing({
      appliedNames: [],
      gatewayNames: ["npm"],
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).not.toContain("● npm [from balanced tier]");
    expect(output).toContain(
      "● npm [source unverified] — npm and Yarn registry access (active on gateway, missing from local state)",
    );
  });

  it("marks registry-only provenance as gateway-unreachable (#5774)", () => {
    arrangeListing({
      appliedNames: ["npm"],
      gatewayNames: null,
      tier: "balanced",
      agent: "openclaw",
    });

    listSandboxPolicies("test-sandbox");

    const output = printedText();
    expect(output).not.toContain("● npm [from balanced tier]");
    expect(output).toContain("● npm [source unverified (gateway unreachable)]");
  });
});
