// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  ManagedPolicyBinding,
  type ManagedPolicyBindingRuntime,
  type ManagedPolicyContentState,
} from "./managed-policy-binding";

const CONTENT = "network_policies:\n  managed-key:\n    name: managed-key\n";

function runtime(states: ManagedPolicyContentState[] = ["match", "absent"]) {
  const stateQueue = [...states];
  return {
    getPresetContentGatewayState: vi.fn(() => stateQueue.shift() ?? null),
    loadPresetForSandbox: vi.fn(() => CONTENT),
    removePreset: vi.fn(() => true),
  } as unknown as ManagedPolicyBindingRuntime;
}

describe("managed policy binding", () => {
  const binding = new ManagedPolicyBinding({
    presetName: "managed-preset",
    policyKey: "managed-key",
  });

  it("normalizes preset identity and registry attribution", () => {
    expect(binding.matchesPreset(" Managed-Preset ")).toBe(true);
    expect(binding.setAttribution(["npm", "MANAGED-PRESET"], true)).toEqual([
      "npm",
      "managed-preset",
    ]);
    expect(binding.setAttribution(["npm", "managed-preset"], false)).toEqual(["npm"]);
  });

  it("requires matching policy keys and exact live content for custom ownership", () => {
    const deps = runtime(["drift", "match"]);
    expect(binding.hasLiveCustomOwner("alpha", [CONTENT, CONTENT], deps)).toBe(true);
    expect(deps.getPresetContentGatewayState).toHaveBeenNthCalledWith(
      1,
      "alpha",
      CONTENT,
      "managed-key",
    );
    expect(binding.hasLiveCustomOwner("alpha", ["network_policies:\n  other: {}\n"], deps)).toBe(
      false,
    );
  });

  it("aborts managed reconciliation when custom ownership is indeterminate", () => {
    const deps = runtime([null]);
    expect(() => binding.hasLiveCustomOwner("alpha", [CONTENT], deps)).toThrow(
      /Could not determine live policy ownership.*refusing to reconcile/,
    );
  });

  it("aborts before inspection when registered custom content is malformed", () => {
    const deps = runtime();
    expect(() =>
      binding.hasLiveCustomOwner("alpha", ["network_policies:\n  managed-key: [invalid"], deps),
    ).toThrow(/Could not determine live policy ownership.*refusing to reconcile/);
    expect(deps.getPresetContentGatewayState).not.toHaveBeenCalled();
  });

  it("loads and inspects managed content without exposing policy read failures", () => {
    const deps = runtime(["match"]);
    expect(binding.load("alpha", deps)).toEqual({ content: CONTENT, state: "match" });
    vi.mocked(deps.loadPresetForSandbox).mockImplementation(() => {
      throw new Error("gateway unavailable");
    });
    expect(binding.load("alpha", deps)).toEqual({ content: null, state: null });
  });

  it("removes only exact managed content and verifies absence afterward", () => {
    const deps = runtime(["match", "absent"]);
    expect(binding.removeExact("alpha", CONTENT, deps)).toMatchObject({
      before: "match",
      after: "absent",
      attempted: true,
      reportedSuccess: true,
      failureDetail: null,
      verifiedAbsent: true,
    });
    expect(deps.removePreset).toHaveBeenCalledWith("alpha", "managed-preset");
  });

  it("retains an actionable failure when removal cannot prove absence", () => {
    const deps = runtime(["match", "drift"]);
    vi.mocked(deps.removePreset).mockReturnValue(false);
    expect(binding.removeExact("alpha", CONTENT, deps)).toMatchObject({
      after: "drift",
      reportedSuccess: false,
      failureDetail: "remove failed; post-remove content drifted",
      verifiedAbsent: false,
    });
  });
});
