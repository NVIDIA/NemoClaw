// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolvePolicyTierFromEnv } from "../src/lib/onboard/policy-tier-env";
import { getTier } from "../src/lib/policy/tiers";

// docs/security/best-practices.mdx labelled its preset-free Locked-Down
// posture profile as the default and told operators to keep all defaults and
// add no presets. Onboarding defaults to the Balanced tier, which applies
// package-registry, model-download, and web-search presets, so an operator
// following the security page kept a wider network posture than the page
// described.
const REPO_ROOT = path.dirname(import.meta.dirname);
const DOC = path.join(REPO_ROOT, "docs", "security", "best-practices.mdx");
const text = fs.readFileSync(DOC, "utf-8");

describe("best-practices.mdx posture profiles match the onboarding default", () => {
  it("resolves the onboarding default to a preset-bearing tier", () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "");
    const defaultTier = resolvePolicyTierFromEnv();
    vi.unstubAllEnvs();

    expect(defaultTier).toBe("balanced");
    expect(getTier(defaultTier)?.presets.map((preset) => preset.name)).toContain("brew");
  });

  it("does not label the preset-free profile as the default", () => {
    expect(text).toMatch(/^### Locked-Down$/m);
    expect(text).not.toMatch(/^### Locked-Down \(Default\)$/m);
  });

  it("routes the Locked-Down profile through the Restricted tier", () => {
    const profile = text.slice(text.indexOf("### Locked-Down"), text.indexOf("### Development"));

    expect(profile).toContain("Select the Restricted tier during onboarding.");
    expect(profile).toContain("Onboarding defaults to the Balanced tier");
  });
});
