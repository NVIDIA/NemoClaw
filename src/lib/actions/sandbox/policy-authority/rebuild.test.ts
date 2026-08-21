// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as policies from "../../../policy";
import * as onboardSession from "../../../state/onboard-session";
import * as registry from "../../../state/registry";
import type { RebuildSandboxEntry } from "../rebuild-flow-helpers";
import { qualifyRebuildPolicyAuthority } from "./rebuild";

const CUSTOM_POLICY = `
network_policies:
  custom-api:
    endpoints:
      - host: custom.example.com
        port: 443
`;

function externalEffectivePolicy(includeCustom = true): Record<string, unknown> {
  const baseline = policies.resolveAgentBaselinePolicy("openclaw")!;
  const parsedBaseline = YAML.parse(baseline.content) as Record<string, unknown> & {
    network_policies: Record<string, unknown>;
  };
  const parsedCustom = YAML.parse(CUSTOM_POLICY) as {
    network_policies: Record<string, unknown>;
  };
  return {
    ...parsedBaseline,
    network_policies: {
      ...parsedBaseline.network_policies,
      ...(includeCustom ? parsedCustom.network_policies : {}),
    },
  };
}

function sandboxEntry(
  policyAuthority: RebuildSandboxEntry["policyAuthority"],
): RebuildSandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority,
    policies: [],
    policyTier: "restricted",
    customPolicies: [{ name: "custom-api", content: CUSTOM_POLICY, sourcePath: "/tmp/policy" }],
  } as RebuildSandboxEntry;
}

describe("rebuild policy authority preflight", () => {
  beforeEach(() => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifies every rebuild policy requirement before accepting external authority (#9833)", async () => {
    const entry = sandboxEntry("externally-managed");
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox");

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(receipt.authority).toBe("externally-managed");
    expect(receipt.requiredPolicies).toHaveLength(2);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("retains only agreed legacy authority when an external requirement is missing (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(false),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    await expect(
      qualifyRebuildPolicyAuthority(
        { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
        {
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectGlobalPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).rejects.toThrow(/missing entries "custom-api"/);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(entry.policyAuthority).toBe("externally-managed");
  });

  it("backfills legacy rebuild authority after live and global requirements match (#9833)", async () => {
    const entry = sandboxEntry(undefined);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: externalEffectivePolicy(),
    };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    const receipt = await qualifyRebuildPolicyAuthority(
      { sandboxName: "alpha", sandboxEntry: entry, manifest: null },
      {
        inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        inspectGlobalPolicyAuthority: vi.fn(() => inspection),
      },
    );

    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(entry.policyAuthority).toBe("externally-managed");
    expect(receipt.authority).toBe("externally-managed");
  });
});
