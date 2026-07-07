// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  normalizeRebuildWebSearchPolicyPresets,
  runRebuildBackupPhase,
} from "./rebuild-backup-phase";

describe("rebuild web-search policy normalization", () => {
  it("keeps only the durable Tavily provider and removes stale nous-web", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave", "nous-web", "tavily"],
        { name: "alpha", agent: "hermes" },
        { fetchEnabled: true, provider: "tavily" },
      ),
    ).toEqual(["npm", "tavily"]);
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave"],
        { name: "alpha", agent: "hermes" },
        { fetchEnabled: true, provider: "tavily" },
      ),
    ).toEqual(["npm", "tavily"]);
  });

  it("removes both built-in providers for an authoritative disable", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "brave", "tavily"],
        { name: "alpha", agent: "openclaw" },
        null,
      ),
    ).toEqual(["npm"]);
  });

  it("preserves DCode's standalone Tavily and excludes custom names from built-in replay", () => {
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "tavily"],
        { name: "alpha", agent: "langchain-deepagents-code" },
        null,
      ),
    ).toEqual(["npm", "tavily"]);
    expect(
      normalizeRebuildWebSearchPolicyPresets(
        ["npm", "tavily"],
        {
          name: "alpha",
          agent: "openclaw",
          customPolicies: [{ name: "tavily", content: "allow: []" }],
        },
        null,
      ),
    ).toEqual(["npm"]);
  });

  it("keeps a finalized custom-only built-in selection empty instead of resetting it", () => {
    const result = runRebuildBackupPhase({
      sandboxName: "alpha",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        policies: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
        policyPresetsFinalized: true,
      },
      staleRecovery: false,
      preparedRecoveryManifest: {
        policyPresets: ["tavily"],
        customPolicies: [{ name: "tavily", content: "allow: []" }],
      } as never,
      messagingPlan: null,
      webSearchConfig: null,
      log: vi.fn(),
      bail: (message): never => {
        throw new Error(message);
      },
      relockShieldsIfNeeded: () => true,
    });

    expect(result?.policyPresets).toEqual([]);
    expect(result?.sessionPolicyPresets).toEqual([]);
  });
});
