// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import {
  applyRecreatePolicyCarryForward,
  buildFinalizedPolicyPresetsUpdate,
  persistFinalizedPolicyPresets,
  resolveRecreatePolicyPresets,
  seedReusedSandboxPolicyPresets,
} from "./policy-preset-persistence";

afterEach(() => {
  vi.restoreAllMocks();
});

function readSeededPresets(
  updateSession: ReturnType<typeof vi.spyOn>,
): string[] | null | undefined {
  const session = { policyPresets: undefined } as { policyPresets: string[] | null | undefined };
  (updateSession.mock.calls[0][0] as (s: typeof session) => unknown)(session);
  return session.policyPresets;
}

describe("buildFinalizedPolicyPresetsUpdate (#4621)", () => {
  it("keeps only built-in preset names and stamps the finalized marker", () => {
    expect(
      buildFinalizedPolicyPresetsUpdate(["github", "my-custom", "npm"], ["github", "npm", "dns"]),
    ).toEqual({ policies: ["github", "npm"], policyPresetsFinalized: true });
  });

  it("records an intentionally-empty selection as []", () => {
    expect(buildFinalizedPolicyPresetsUpdate([], ["github", "npm"])).toEqual({
      policies: [],
      policyPresetsFinalized: true,
    });
  });

  it("excludes a custom preset whose name collides with a built-in", () => {
    // A custom `brave` must not be written into the built-in `policies` list.
    expect(
      buildFinalizedPolicyPresetsUpdate(["github", "brave"], ["github", "brave"], ["brave"]),
    ).toEqual({ policies: ["github"], policyPresetsFinalized: true });
  });
});

describe("resolveRecreatePolicyPresets (#4621)", () => {
  it("carries a finalized non-empty selection forward", () => {
    expect(resolveRecreatePolicyPresets(["github"], true, false, {}, true)).toEqual({
      policyPresets: ["github"],
      overrideNote: null,
    });
  });

  it("honors a finalized empty selection instead of falling back to a tier", () => {
    expect(resolveRecreatePolicyPresets([], true, false, {}, true)).toEqual({
      policyPresets: [],
      overrideNote: null,
    });
  });

  it("does not honor an empty built-in list when custom presets were recorded", () => {
    // Recreate discards custom-preset content, so fall back to the prompt rather
    // than silently seeding [] and skipping the selector.
    expect(resolveRecreatePolicyPresets([], true, true, {}, true)).toEqual({
      policyPresets: null,
      overrideNote: null,
    });
  });

  it("treats a non-finalized empty list as no recorded selection", () => {
    // Boot-time-only presets from an interrupted run must not be carried.
    expect(resolveRecreatePolicyPresets([], false, false, {}, true)).toEqual({
      policyPresets: null,
      overrideNote: null,
    });
  });

  it("defers to an env override even for a finalized empty selection", () => {
    const result = resolveRecreatePolicyPresets(
      [],
      true,
      false,
      { NEMOCLAW_POLICY_MODE: "skip" },
      true,
    );
    expect(result.policyPresets).toBeNull();
  });

  it("surfaces the override note for a non-empty selection replaced by env", () => {
    const result = resolveRecreatePolicyPresets(
      ["npm"],
      true,
      false,
      { NEMOCLAW_POLICY_PRESETS: "pypi" },
      true,
    );
    expect(result.policyPresets).toBeNull();
    expect(result.overrideNote).toContain("NEMOCLAW_POLICY_PRESETS overrides previous presets");
  });
});

describe("seedReusedSandboxPolicyPresets (#4621)", () => {
  it("seeds the full recorded applied set when the policy step was finalized", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "sb",
      policyPresetsFinalized: true,
    } as ReturnType<typeof registry.getSandbox>);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ policyPresets: undefined } as never);
    const updateSession = vi
      .spyOn(onboardSession, "updateSession")
      .mockReturnValue(undefined as never);
    const getAppliedPresets = vi.fn(() => ["github", "my-custom"]);

    seedReusedSandboxPolicyPresets("sb", false, getAppliedPresets);

    expect(getAppliedPresets).toHaveBeenCalledWith("sb");
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(readSeededPresets(updateSession)).toEqual(["github", "my-custom"]);
  });

  it("does not seed when the prior policy step was not finalized", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "sb" } as ReturnType<
      typeof registry.getSandbox
    >);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ policyPresets: undefined } as never);
    const updateSession = vi.spyOn(onboardSession, "updateSession");
    const getAppliedPresets = vi.fn(() => ["github"]);

    seedReusedSandboxPolicyPresets("sb", false, getAppliedPresets);

    expect(updateSession).not.toHaveBeenCalled();
    expect(getAppliedPresets).not.toHaveBeenCalled();
  });

  it("does not clobber an in-progress --resume session", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "sb",
      policyPresetsFinalized: true,
    } as ReturnType<typeof registry.getSandbox>);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ policyPresets: ["dns"] } as never);
    const updateSession = vi.spyOn(onboardSession, "updateSession");

    seedReusedSandboxPolicyPresets("sb", false, vi.fn(() => ["github"]));

    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe("applyRecreatePolicyCarryForward (#4621)", () => {
  it("seeds the carried selection and prints no note when none is warranted", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "sb",
      policies: ["github"],
      policyPresetsFinalized: true,
    } as ReturnType<typeof registry.getSandbox>);
    const updateSession = vi
      .spyOn(onboardSession, "updateSession")
      .mockReturnValue(undefined as never);
    const note = vi.fn();

    applyRecreatePolicyCarryForward("sb", true, note);

    expect(readSeededPresets(updateSession)).toEqual(["github"]);
    expect(note).not.toHaveBeenCalled();
  });

  it("prints the override note when an env override clears the selection", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "sb",
      policies: ["npm"],
      policyPresetsFinalized: true,
    } as ReturnType<typeof registry.getSandbox>);
    vi.spyOn(onboardSession, "updateSession").mockReturnValue(undefined as never);
    const note = vi.fn();
    process.env.NEMOCLAW_POLICY_PRESETS = "pypi";
    try {
      applyRecreatePolicyCarryForward("sb", true, note);
    } finally {
      delete process.env.NEMOCLAW_POLICY_PRESETS;
    }

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_POLICY_PRESETS overrides previous presets"),
    );
  });
});

describe("persistFinalizedPolicyPresets (#4621)", () => {
  it("writes built-in presets only plus the finalized marker", () => {
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue([]);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    persistFinalizedPolicyPresets("sb", ["github", "my-custom"], () => ["github", "npm"]);

    expect(updateSandbox).toHaveBeenCalledWith("sb", {
      policies: ["github"],
      policyPresetsFinalized: true,
    });
  });

  it("keeps a name-colliding custom preset out of the built-in policies list", () => {
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue([
      { name: "brave", content: "" },
    ] as ReturnType<typeof registry.getCustomPolicies>);
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

    persistFinalizedPolicyPresets("sb", ["github", "brave"], () => ["github", "brave"]);

    expect(updateSandbox).toHaveBeenCalledWith("sb", {
      policies: ["github"],
      policyPresetsFinalized: true,
    });
  });
});
