// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the GPU-passthrough mismatch recovery hint (#3456 sub-bug #3).
 *
 * The hint replaces a hard-coded line that printed a literal `<name>`
 * placeholder and assumed at least one sandbox was registered — which broke
 * the install-loop recovery flow when the registry was empty (the State A /
 * State B dead loop the reporter hit on six Linux hosts).
 */

import { describe, expect, it, vi } from "vitest";
import { gpuPassthroughRecoveryLines, reportGpuPassthroughRecovery } from "./gpu-recovery";

describe("gpuPassthroughRecoveryLines", () => {
  it("never emits a literal `<name>` placeholder for any input", () => {
    for (const names of [null, [], ["alpha"], ["alpha", "beta"], ["alpha", "beta", "gamma"]]) {
      const lines = gpuPassthroughRecoveryLines(names);
      expect(lines.join("\n")).not.toMatch(/<name>/);
    }
  });

  it("suggests `nemoclaw uninstall` when no sandboxes are registered (null input)", () => {
    const lines = gpuPassthroughRecoveryLines(null);
    const joined = lines.join("\n");
    expect(joined).toContain("Existing gateway was started without GPU passthrough");
    expect(joined).toContain("nemoclaw uninstall");
    expect(joined).toContain("nemoclaw onboard --gpu");
    // Must NOT suggest the destroy form — there is nothing to destroy.
    expect(joined).not.toMatch(/nemoclaw [a-z-]+ destroy/);
  });

  it("suggests `nemoclaw uninstall` when no sandboxes are registered (empty array)", () => {
    const lines = gpuPassthroughRecoveryLines([]);
    expect(lines.join("\n")).toContain("nemoclaw uninstall");
    expect(lines.join("\n")).not.toMatch(/nemoclaw [a-z-]+ destroy/);
  });

  it("suggests destroy for a single registered sandbox with --cleanup-gateway", () => {
    const lines = gpuPassthroughRecoveryLines(["my-assistant"]);
    const joined = lines.join("\n");
    expect(joined).toContain("nemoclaw my-assistant destroy --yes --cleanup-gateway");
    expect(joined).toContain("nemoclaw onboard --gpu");
    // The single-sandbox form must not suggest uninstall — destroy is enough.
    expect(joined).not.toContain("nemoclaw uninstall");
  });

  it("lists every registered sandbox and only appends --cleanup-gateway to the last", () => {
    const lines = gpuPassthroughRecoveryLines(["alpha", "beta", "gamma"]);
    const joined = lines.join("\n");
    expect(joined).toContain("nemoclaw alpha destroy --yes");
    expect(joined).toContain("nemoclaw beta destroy --yes");
    expect(joined).toContain("nemoclaw gamma destroy --yes --cleanup-gateway");
    // Only one --cleanup-gateway across all rows.
    expect(joined.match(/--cleanup-gateway/g) ?? []).toHaveLength(1);
    // alpha/beta lines must NOT have --cleanup-gateway.
    const alphaLine = lines.find((line) => line.includes("nemoclaw alpha destroy"));
    const betaLine = lines.find((line) => line.includes("nemoclaw beta destroy"));
    expect(alphaLine).not.toContain("--cleanup-gateway");
    expect(betaLine).not.toContain("--cleanup-gateway");
  });

  it("filters out empty/whitespace names defensively", () => {
    // Belt-and-suspenders: if registry.listSandboxes() ever returns a row with
    // an empty name, we shouldn't render `nemoclaw  destroy --yes` (the very
    // bug shape this fix exists to prevent).
    const lines = gpuPassthroughRecoveryLines(["", "  ", "real"]);
    const joined = lines.join("\n");
    expect(joined).toContain("nemoclaw real destroy --yes --cleanup-gateway");
    // No double-spaced "nemoclaw  destroy" rendering.
    expect(joined).not.toMatch(/nemoclaw\s{2,}destroy/);
  });
});

describe("reportGpuPassthroughRecovery", () => {
  it("emits the empty-registry path when loadNames returns no names", () => {
    const emit = vi.fn();
    reportGpuPassthroughRecovery(emit, () => []);
    const joined = emit.mock.calls.map((c) => c[0]).join("\n");
    expect(joined).toContain("nemoclaw uninstall");
    expect(joined).not.toMatch(/<name>/);
  });

  it("emits the multi-sandbox path when loadNames returns several names", () => {
    const emit = vi.fn();
    reportGpuPassthroughRecovery(emit, () => ["alpha", "beta"]);
    const joined = emit.mock.calls.map((c) => c[0]).join("\n");
    expect(joined).toContain("nemoclaw alpha destroy --yes");
    expect(joined).toContain("nemoclaw beta destroy --yes --cleanup-gateway");
  });
});
