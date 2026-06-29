// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decidePolicyCarryForward,
  decideReusePolicyPresets,
  shouldCarryPreviousPolicies,
} from "./policy-carryforward";

describe("shouldCarryPreviousPolicies (#2675)", () => {
  it("drops previous policies when NEMOCLAW_POLICY_PRESETS overrides on recreate", () => {
    expect(shouldCarryPreviousPolicies(["npm"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, true)).toBe(
      false,
    );
  });

  it("ignores env var in interactive mode (previous list still wins)", () => {
    expect(shouldCarryPreviousPolicies(["npm"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, false)).toBe(
      true,
    );
  });

  it("drops previous policies when NEMOCLAW_POLICY_MODE=skip", () => {
    expect(shouldCarryPreviousPolicies(["npm"], { NEMOCLAW_POLICY_MODE: "skip" }, true)).toBe(
      false,
    );
  });

  it("drops previous policies when NEMOCLAW_POLICY_MODE=custom forces explicit selection", () => {
    expect(shouldCarryPreviousPolicies(["npm"], { NEMOCLAW_POLICY_MODE: "custom" }, true)).toBe(
      false,
    );
  });

  it("carries previous policies when NEMOCLAW_POLICY_MODE=suggested (implicit)", () => {
    expect(shouldCarryPreviousPolicies(["npm"], { NEMOCLAW_POLICY_MODE: "suggested" }, true)).toBe(
      true,
    );
  });
});

describe("decidePolicyCarryForward (#2675)", () => {
  it("emits NEMOCLAW_POLICY_PRESETS override note when env clears previous presets", () => {
    const decision = decidePolicyCarryForward(["npm"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, true);
    expect(decision.newPresets).toBeNull();
    expect(decision.overrideNote).toContain("NEMOCLAW_POLICY_PRESETS overrides previous presets");
    expect(decision.overrideNote).toContain("was: npm");
  });

  it("emits NEMOCLAW_POLICY_MODE override note when mode forces clearing", () => {
    const decision = decidePolicyCarryForward(["npm"], { NEMOCLAW_POLICY_MODE: "skip" }, true);
    expect(decision.newPresets).toBeNull();
    expect(decision.overrideNote).toContain("NEMOCLAW_POLICY_MODE=skip");
    expect(decision.overrideNote).toContain("was: npm");
  });

  it("carries presets forward in interactive mode even when env vars are set", () => {
    const decision = decidePolicyCarryForward(["npm"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, false);
    expect(decision.newPresets).toEqual(["npm"]);
    expect(decision.overrideNote).toBeNull();
  });

  it("clears without note when there are no previous policies to override", () => {
    const decision = decidePolicyCarryForward([], { NEMOCLAW_POLICY_PRESETS: "pypi" }, true);
    expect(decision.newPresets).toBeNull();
    expect(decision.overrideNote).toBeNull();
  });

  it("carries forward without note when no env override is set", () => {
    const decision = decidePolicyCarryForward(["npm"], {}, true);
    expect(decision.newPresets).toEqual(["npm"]);
    expect(decision.overrideNote).toBeNull();
  });
});

describe("decideReusePolicyPresets (#4621)", () => {
  it("carries the recorded selection forward on reuse", () => {
    expect(decideReusePolicyPresets(["dns", "github"], {}, false)).toEqual(["dns", "github"]);
  });

  it("preserves an intentionally-empty selection (Restricted tier) as []", () => {
    // decidePolicyCarryForward would collapse this to null and re-prompt Balanced.
    expect(decideReusePolicyPresets([], {}, false)).toEqual([]);
    expect(decideReusePolicyPresets([], {}, true)).toEqual([]);
  });

  it("returns null when there is no recorded policy state", () => {
    expect(decideReusePolicyPresets(null, {}, false)).toBeNull();
    expect(decideReusePolicyPresets(undefined, {}, true)).toBeNull();
  });

  it("preserves custom preset names alongside built-ins", () => {
    expect(decideReusePolicyPresets(["github", "my-custom"], {}, false)).toEqual([
      "github",
      "my-custom",
    ]);
  });

  it("defers to a non-interactive NEMOCLAW_POLICY_PRESETS override", () => {
    expect(decideReusePolicyPresets(["dns"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, true)).toBeNull();
    expect(decideReusePolicyPresets([], { NEMOCLAW_POLICY_PRESETS: "pypi" }, true)).toBeNull();
  });

  it("defers to a non-interactive explicit NEMOCLAW_POLICY_MODE override", () => {
    expect(decideReusePolicyPresets(["dns"], { NEMOCLAW_POLICY_MODE: "skip" }, true)).toBeNull();
    expect(decideReusePolicyPresets(["dns"], { NEMOCLAW_POLICY_MODE: "custom" }, true)).toBeNull();
  });

  it("ignores env overrides in interactive mode (recorded selection wins)", () => {
    expect(decideReusePolicyPresets(["dns"], { NEMOCLAW_POLICY_PRESETS: "pypi" }, false)).toEqual([
      "dns",
    ]);
  });

  it("carries the recorded selection under implicit non-interactive modes", () => {
    expect(decideReusePolicyPresets(["dns"], { NEMOCLAW_POLICY_MODE: "suggested" }, true)).toEqual([
      "dns",
    ]);
  });
});
