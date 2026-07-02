// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression for #5967: `nemoclaw <sandbox> policy-list` must render `● discord`
// (and any enabled messaging channel preset) once it is recorded in the registry
// and active on the gateway. This is the reporter's observation step — the
// rendered marker the operator actually reads — complementing the merge/persist
// tests that cover the upstream state policy-list consumes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../policy")>();
  return {
    ...actual,
    listPresets: vi.fn(),
    listCustomPresets: vi.fn(),
    getAppliedPresets: vi.fn(),
    getGatewayPresets: vi.fn(),
  };
});

import * as policies from "../../policy";
import { listSandboxPolicies } from "./policy-channel";

const mocked = vi.mocked(policies);

describe("listSandboxPolicies rendering (#5967)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    mocked.listPresets.mockReturnValue([
      {
        name: "discord",
        description: "Discord API, gateway, and CDN access",
        file: "discord.yaml",
      },
      {
        name: "slack",
        description: "Slack API, Socket Mode, and webhooks access",
        file: "slack.yaml",
      },
      { name: "npm", description: "npm and Yarn registry access", file: "npm.yaml" },
    ]);
    mocked.listCustomPresets.mockReturnValue([]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  // Match the rendered marker + preset name directly. The row may carry a
  // provenance tag (e.g. `● discord [user-added] — …`) between the name and the
  // description, so keying off the marker+name is robust to that suffix.
  const lineFor = (preset: string) =>
    lines.find((line) => new RegExp(`[●○] ${preset}\\b`).test(line)) ?? "";

  it("marks an enabled Discord preset applied (●) when it is in both registry and gateway", () => {
    // The #5967 fix persists `discord` to registry.policies AND applies it to the
    // gateway, so policy-list must render it as applied.
    mocked.getAppliedPresets.mockReturnValue(["discord", "npm"]);
    mocked.getGatewayPresets.mockReturnValue(["discord", "npm"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("● discord");
    expect(lineFor("npm")).toContain("● npm");
    // A channel that was never configured stays unapplied.
    expect(lineFor("slack")).toContain("○ slack");
    expect(lineFor("slack")).not.toContain("● slack");
  });

  it("renders the pre-fix regression (○ discord) when Discord is dropped from registry and gateway", () => {
    // Before the fix the explicit-selection path dropped discord from both the
    // persisted registry list and the reconciled gateway set.
    mocked.getAppliedPresets.mockReturnValue(["npm", "pypi"]);
    mocked.getGatewayPresets.mockReturnValue(["npm", "pypi"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("○ discord");
    expect(lineFor("discord")).not.toContain("● discord");
  });

  it("flags a registry/gateway mismatch when Discord is recorded but not active on the gateway", () => {
    mocked.getAppliedPresets.mockReturnValue(["discord", "npm"]);
    mocked.getGatewayPresets.mockReturnValue(["npm"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("○ discord");
    expect(lineFor("discord")).toContain("recorded locally, not active on gateway");
  });
});
