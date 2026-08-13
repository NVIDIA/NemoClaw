// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { probeSandboxNameContainers, type SandboxIdentityProbe } from "./sandbox-identity";

// Narrowing assertion helper keeps test bodies linear (no branching).
function expectOk(
  probe: SandboxIdentityProbe,
): asserts probe is Extract<SandboxIdentityProbe, { status: "ok" }> {
  expect(probe.status).toBe("ok");
}

const MANAGED_LINE = ["aaaa000000000000", "openshell", "default", "sb-real"].join("\t");

describe("probeSandboxNameContainers", () => {
  it("parses the tab-separated identity rows Docker returns", () => {
    const dockerRun = vi.fn(() => ({ status: 0, stdout: MANAGED_LINE }));
    const probe = probeSandboxNameContainers("destroytest", { dockerRun } as never);
    expectOk(probe);
    expect(probe.rows).toEqual([
      { id: "aaaa000000000000", managedBy: "openshell", workspace: "default", sandboxId: "sb-real" },
    ]);
  });

  it("ignores blank and malformed lines without inventing rows", () => {
    const dockerRun = vi.fn(() => ({ status: 0, stdout: `\n  \n${MANAGED_LINE}\n` }));
    const probe = probeSandboxNameContainers("destroytest", { dockerRun } as never);
    expectOk(probe);
    expect(probe.rows).toHaveLength(1);
  });

  it("filters ONLY on the sandbox-name label so foreign containers stay visible", () => {
    const dockerRun = vi.fn((_args: readonly string[], _opts?: unknown) => ({ status: 0, stdout: "" }));
    probeSandboxNameContainers("destroytest", { dockerRun } as never);
    const argv = dockerRun.mock.calls[0][0] as readonly string[];
    // `-a` keeps stopped containers visible: a stopped foreign container that
    // borrows the sandbox-name label must still make the identity ambiguous.
    expect(argv).toContain("-a");
    expect(argv).toContain("label=openshell.ai/sandbox-name=destroytest");
    expect(argv.some((a) => a.includes("managed-by="))).toBe(false);
  });

  it("reports a probe failure when docker ps exits non-zero", () => {
    const dockerRun = vi.fn(() => ({ status: 1, stdout: "", stderr: "Cannot connect to daemon" }));
    const probe = probeSandboxNameContainers("destroytest", { dockerRun } as never);
    expect(probe.status).toBe("probe-failed");
    expect((probe as Extract<SandboxIdentityProbe, { status: "probe-failed" }>).detail).toContain(
      "daemon",
    );
  });
});
