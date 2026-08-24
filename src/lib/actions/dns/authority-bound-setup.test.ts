// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runAuthorityBoundDnsSetup } from "./authority-bound-setup";

function sandbox(policyAuthority: unknown, overrides: Record<string, unknown> = {}) {
  return {
    agent: "openclaw",
    gatewayName: "nemoclaw",
    gpuEnabled: false,
    name: "alpha",
    policies: [],
    policyAuthority,
    ...overrides,
  } as never;
}

describe("authority-bound DNS setup", () => {
  it("guards each child-process mutation and success with registered authority (#9833)", () => {
    const getSandbox = vi.fn(() => sandbox("nemoclaw-managed"));
    const inspectSandboxPolicyAuthority = vi.fn(() => ({
      authority: "nemoclaw-managed" as const,
      effectivePolicy: {},
    }));
    const mutations: string[] = [];
    const runSetupDnsProxy = vi.fn((_options, deps) => {
      deps.revalidatePolicyAuthority?.("write the DNS proxy script");
      mutations.push("write the DNS proxy script");
      deps.revalidatePolicyAuthority?.("stop the existing DNS proxy");
      mutations.push("stop the existing DNS proxy");
      deps.revalidatePolicyAuthority?.("start the DNS proxy");
      mutations.push("start the DNS proxy");
      deps.revalidatePolicyAuthority?.("back up the DNS resolver");
      mutations.push("back up the DNS resolver");
      deps.revalidatePolicyAuthority?.("add the DNS firewall rule");
      mutations.push("add the DNS firewall rule");
      deps.revalidatePolicyAuthority?.("write the DNS resolver");
      mutations.push("write the DNS resolver");
      deps.revalidatePolicyAuthority?.("report successful DNS proxy repair");
      return { exitCode: 0 };
    });

    expect(
      runAuthorityBoundDnsSetup(
        { gatewayName: "nemoclaw", sandboxName: "alpha" },
        { getSandbox, inspectSandboxPolicyAuthority, runSetupDnsProxy },
      ),
    ).toEqual({ exitCode: 0 });

    expect(mutations).toHaveLength(6);
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalledTimes(8);
    expect(runSetupDnsProxy).toHaveBeenCalledWith(
      { gatewayName: "nemoclaw", sandboxName: "alpha" },
      { revalidatePolicyAuthority: expect.any(Function) },
    );
  });

  it("uses an explicit receipt for an unregistered snapshot clone (#9833)", () => {
    const inspectSandboxPolicyAuthority = vi.fn(() => ({
      authority: "externally-managed" as const,
      effectivePolicy: {},
    }));
    const runSetupDnsProxy = vi.fn((_options, deps) => {
      deps.revalidatePolicyAuthority?.("write the DNS proxy script");
      deps.revalidatePolicyAuthority?.("report successful DNS proxy repair");
      return { exitCode: 0 };
    });

    const result = runAuthorityBoundDnsSetup(
      {
        gatewayName: "nemoclaw-9090",
        recordedPolicyAuthority: "externally-managed",
        sandboxName: "clone",
      },
      {
        getSandbox: () => null,
        inspectSandboxPolicyAuthority,
        runSetupDnsProxy,
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalledTimes(3);
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      sandboxName: "clone",
    });
  });

  it("refuses an unregistered mutation without an authority receipt (#9833)", () => {
    const inspectSandboxPolicyAuthority = vi.fn();
    const runSetupDnsProxy = vi.fn();

    expect(() =>
      runAuthorityBoundDnsSetup(
        { gatewayName: "nemoclaw", sandboxName: "clone" },
        { getSandbox: () => null, inspectSandboxPolicyAuthority, runSetupDnsProxy },
      ),
    ).toThrow(/recorded policy authority is unavailable or invalid/u);

    expect(inspectSandboxPolicyAuthority).not.toHaveBeenCalled();
    expect(runSetupDnsProxy).not.toHaveBeenCalled();
  });

  it("stops the next child-process mutation after recorded authority changes (#9833)", () => {
    let recordedAuthority = "nemoclaw-managed";
    const mutations: string[] = [];
    const runSetupDnsProxy = vi.fn((_options, deps) => {
      deps.revalidatePolicyAuthority?.("write the DNS proxy script");
      mutations.push("write the DNS proxy script");
      recordedAuthority = "externally-managed";
      deps.revalidatePolicyAuthority?.("start the DNS proxy");
      mutations.push("start the DNS proxy");
      return { exitCode: 0 };
    });

    expect(() =>
      runAuthorityBoundDnsSetup(
        { gatewayName: "nemoclaw", sandboxName: "alpha" },
        {
          getSandbox: () => sandbox(recordedAuthority),
          inspectSandboxPolicyAuthority: () => ({
            authority: "nemoclaw-managed",
            effectivePolicy: {},
          }),
          runSetupDnsProxy,
        },
      ),
    ).toThrow(/policy authority changed from nemoclaw-managed to externally-managed/u);

    expect(mutations).toEqual(["write the DNS proxy script"]);
  });

  it("refuses a registered gateway mismatch before DNS discovery (#9833)", () => {
    const inspectSandboxPolicyAuthority = vi.fn();
    const runSetupDnsProxy = vi.fn();

    expect(() =>
      runAuthorityBoundDnsSetup(
        { gatewayName: "nemoclaw-9090", sandboxName: "alpha" },
        {
          getSandbox: () => sandbox("nemoclaw-managed"),
          inspectSandboxPolicyAuthority,
          runSetupDnsProxy,
        },
      ),
    ).toThrow(/recorded OpenShell gateway changed from nemoclaw-9090 to nemoclaw/u);

    expect(inspectSandboxPolicyAuthority).not.toHaveBeenCalled();
    expect(runSetupDnsProxy).not.toHaveBeenCalled();
  });
});
