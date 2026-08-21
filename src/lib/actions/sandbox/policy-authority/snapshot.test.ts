// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as registry from "../../../state/registry";
import { qualifySnapshotPolicyAuthority } from "./snapshot";

describe("snapshot policy authority qualification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains only agreed legacy authority when a requirement is missing (#9833)", () => {
    const sourceEntry = { name: "alpha" };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: { network_policies: {} },
    };

    expect(() =>
      qualifySnapshotPolicyAuthority(
        {
          gatewayName: "nemoclaw",
          managedMcpPolicies: [],
          operation: "clone snapshot 'alpha' into sandbox 'beta'",
          requiredPolicies: [{ network_policies: { required_api: {} } }],
          sourceEntry,
          sourceLive: true,
          verifyGlobalCreatePolicy: true,
        },
        {
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
          inspectGlobalPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).toThrow(/missing entries "required_api"/);

    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(sourceEntry).toEqual({ name: "alpha", policyAuthority: "externally-managed" });
  });
});
