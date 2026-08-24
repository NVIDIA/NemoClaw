// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { completeOrdinaryOnboardSandboxCreation } from "./created-sandbox-finalization";

describe("created sandbox DNS setup", () => {
  it("invokes registered-sandbox DNS setup through the two-argument wrapper (#9833)", () => {
    const runFile = vi.fn();

    expect(
      completeOrdinaryOnboardSandboxCreation(
        {
          liveExists: true,
          messagingProviders: [],
          runtimeFields: { openshellDriver: "kubernetes" } as never,
          sandboxName: "alpha",
          sandboxWasLiveDefault: false,
        },
        {
          applyVmDnsMonkeypatch: vi.fn(),
          armCancelRollback: vi.fn(),
          dockerInfoFormat: vi.fn() as never,
          gatewayName: "nemoclaw",
          providerExistsInGateway: vi.fn(() => true),
          revalidatePolicyAuthority: vi.fn(),
          runCapture: vi.fn() as never,
          runFile,
          scriptsDir: "/repo/scripts",
          setDefault: vi.fn(),
        },
      ),
    ).toBe("alpha");

    expect(runFile).toHaveBeenCalledWith(
      "bash",
      ["/repo/scripts/setup-dns-proxy.sh", "nemoclaw", "alpha"],
      { ignoreError: true },
    );
  });
});
