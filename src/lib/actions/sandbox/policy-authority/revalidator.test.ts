// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSandboxPolicyAuthorityRevalidator } from "./revalidator";

describe("sandbox policy authority revalidator", () => {
  it("checks recorded and live authority at one mutation edge (#9833)", () => {
    const readRecordedPolicyAuthority = vi.fn(() => "nemoclaw-managed");
    const inspectSandboxPolicyAuthority = vi.fn(() => ({
      authority: "nemoclaw-managed" as const,
      effectivePolicy: {},
    }));
    const revalidate = createSandboxPolicyAuthorityRevalidator(
      {
        gatewayName: "nemoclaw-9090",
        readRecordedPolicyAuthority,
        recordedPolicyAuthority: "nemoclaw-managed",
        sandboxName: "alpha",
      },
      { inspectSandboxPolicyAuthority },
    );

    revalidate("write the DNS resolver");

    expect(readRecordedPolicyAuthority).toHaveBeenCalledTimes(2);
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      sandboxName: "alpha",
    });
  });

  it("refuses a recorded authority change during the live query (#9833)", () => {
    let recordedAuthority = "nemoclaw-managed";
    const inspectSandboxPolicyAuthority = vi.fn(() => {
      recordedAuthority = "externally-managed";
      return { authority: "nemoclaw-managed" as const, effectivePolicy: {} };
    });
    const revalidate = createSandboxPolicyAuthorityRevalidator(
      {
        gatewayName: "nemoclaw",
        readRecordedPolicyAuthority: () => recordedAuthority,
        recordedPolicyAuthority: "nemoclaw-managed",
        sandboxName: "alpha",
      },
      { inspectSandboxPolicyAuthority },
    );

    expect(() => revalidate("start the DNS proxy")).toThrow(
      /policy authority changed from nemoclaw-managed to externally-managed/u,
    );
  });
});
