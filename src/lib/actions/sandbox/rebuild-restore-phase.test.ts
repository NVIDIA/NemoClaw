// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as policies from "../../policy";
import * as sandboxState from "../../state/sandbox";
import { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
import { resolveRestoredPolicyRegistryState } from "./rebuild-post-restore-phase";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";

describe("rebuild policy restore fidelity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays custom web-policy names from exact content instead of same-name built-ins", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(sandboxState, "restoreSandboxState").mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const applyPreset = vi.spyOn(policies, "applyPreset").mockReturnValue(true);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const customPolicies = ["brave", "tavily", "nous-web"].map((name) => ({
      name,
      content: `network_policies:\n  ${name}-custom:\n    name: ${name}-custom\n`,
      sourcePath: `/tmp/${name}.yaml`,
    }));

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: {
        backupPath: "/tmp/rebuild-backup",
        customPolicies,
      } as never,
      policyPresets: ["npm", "brave", "tavily", "nous-web"],
      customPolicies,
      log: vi.fn(),
    });

    expect(applyPreset).toHaveBeenCalledOnce();
    expect(applyPreset).toHaveBeenCalledWith("alpha", "npm");
    for (const entry of customPolicies) {
      expect(applyPresetContent).toHaveBeenCalledWith("alpha", entry.name, entry.content, {
        custom: { sourcePath: entry.sourcePath },
      });
    }
    expect(result.restoredPresets).toEqual(["npm", "brave", "tavily", "nous-web"]);
    expect(result.failedPresets).toEqual([]);
  });

  it("replays captured registry custom policies during stale recovery without a backup", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(sandboxState, "restoreSandboxState").mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const customPolicies = [
      {
        name: "custom-egress",
        content: "network_policies:\n  custom-egress: {}\n",
        sourcePath: "/tmp/custom-egress.yaml",
      },
    ];

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies,
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      "custom-egress",
      customPolicies[0]!.content,
      { custom: { sourcePath: "/tmp/custom-egress.yaml" } },
    );
    expect(result.restoredPresets).toEqual(["custom-egress"]);
  });

  it("leaves generated MCP policy replay exclusively to MCP restoration", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);
    const genuineCustomPolicy = {
      name: "custom-egress",
      content: "network_policies:\n  custom-egress: {}\n",
      sourcePath: "/tmp/custom-egress.yaml",
    };
    const generatedMcpPolicy = {
      name: "mcp-bridge-search",
      content:
        "network_policies:\n  mcp-bridge-search:\n    endpoints:\n      - host: mcp.example.com\n        allowed_ips: [203.0.113.10]\n",
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      backupManifest: null,
      policyPresets: [],
      customPolicies: [genuineCustomPolicy, generatedMcpPolicy],
      log: vi.fn(),
    });

    expect(applyPresetContent).toHaveBeenCalledOnce();
    expect(applyPresetContent).toHaveBeenCalledWith(
      "alpha",
      genuineCustomPolicy.name,
      genuineCustomPolicy.content,
      { custom: { sourcePath: genuineCustomPolicy.sourcePath } },
    );
    expect(result.restoredPresets).toEqual([genuineCustomPolicy.name]);
    expect(result.failedPresets).toEqual([]);
  });

  it("keeps finalized custom-only policy state empty after exact replay", () => {
    expect(
      resolveRestoredPolicyRegistryState(
        {
          customPolicies: [{ name: "tavily", content: "allow: []" }],
          policyPresetsFinalized: true,
        },
        ["tavily"],
        [],
      ),
    ).toEqual({ policies: [], policyPresetsFinalized: true });
    expect(
      resolveRestoredPolicyRegistryState(
        {
          customPolicies: [{ name: "tavily", content: "allow: []" }],
          policyPresetsFinalized: true,
        },
        [],
        ["tavily"],
      ).policyPresetsFinalized,
    ).toBeUndefined();
  });
});
