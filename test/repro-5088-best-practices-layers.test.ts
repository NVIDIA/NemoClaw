// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolvePolicyTierFromEnv } from "../src/lib/onboard/policy-tier-env";

// `../src/lib/onboard` is a CommonJS module (`module.exports = {}`), so it is
// loaded via `require` per the documented CJS exception for the onboard module.
const { computeSetupPresetSuggestions } = require("../src/lib/onboard") as {
  computeSetupPresetSuggestions: (
    tierName: string,
    options: {
      enabledChannels: string[];
      knownPresetNames: string[];
      webSearchConfig?: { fetchEnabled: true; provider: "brave" | "tavily" } | null;
      webSearchSupported: boolean;
    },
  ) => string[];
};

// Regression for issue #5088: docs/security/best-practices.mdx described
// "four layers" in the intro, the Mermaid diagram, and the at-a-glance table,
// but the body documents five layer sections (it adds Gateway Authentication).
// It also keeps the Sandbox Hardening link on the canonical
// manage-sandboxes/configure-sandboxes/ route rather than the retired deployment/ path.
const REPO_ROOT = path.dirname(import.meta.dirname);
const DOC = path.join(REPO_ROOT, "docs", "security", "best-practices.mdx");
const text = fs.readFileSync(DOC, "utf-8");
const KNOWN_PRESETS = ["npm", "pypi", "huggingface", "brew", "brave", "tavily"];
const BALANCED_PRESETS = ["npm", "pypi", "huggingface", "brew"];

describe("best-practices.mdx security-layer consistency (#5088)", () => {
  it("links Sandbox Hardening via the canonical manage-sandboxes path", () => {
    expect(text).toMatch(/\.\.\/manage-sandboxes\/configure-sandboxes\/review-sandbox-hardening/);
    expect(text).not.toMatch(/\.\.\/deployment\/sandbox-hardening/);
  });

  it("intro and at-a-glance agree with the body's five layer sections", () => {
    const layerHeadings = [...text.matchAll(/^## (.+?) Controls$/gm)].map((m) => m[1]);
    expect(layerHeadings).toEqual([
      "Network",
      "Filesystem",
      "Process",
      "Gateway Authentication",
      "Inference",
    ]);

    // Intro and diagram caption must not undercount the layers.
    expect(text).not.toMatch(/four layers/i);
    expect(text).toMatch(/five layers/i);

    // The "at a glance" overview (between its heading and the first layer
    // section) must surface the Gateway Authentication layer too, not just the body.
    const glance = text.slice(
      text.indexOf("## Protection Layers at a Glance"),
      text.indexOf("## Network Controls"),
    );
    expect(glance).toContain("Gateway Authentication");
  });

  it("does not present a preset-free diagram as the post-onboarding default", () => {
    const glance = text.slice(
      text.indexOf("## Protection Layers at a Glance"),
      text.indexOf("## Network Controls"),
    );

    expect(glance).toContain("does not show onboarding tier presets");
    expect(glance).not.toMatch(/default posture immediately after onboarding/i);
  });

  it("documents the complete Balanced preset default", () => {
    vi.stubEnv("NEMOCLAW_POLICY_TIER", "");
    const defaultTier = resolvePolicyTierFromEnv();
    vi.unstubAllEnvs();

    expect(defaultTier).toBe("balanced");
    expect(
      computeSetupPresetSuggestions(defaultTier, {
        enabledChannels: [],
        knownPresetNames: KNOWN_PRESETS,
        webSearchConfig: null,
        webSearchSupported: true,
      }),
    ).toEqual(BALANCED_PRESETS);
  });

  it.each(["brave", "tavily"] as const)(
    "adds only the selected %s web-search preset to Balanced",
    (provider) => {
      expect(
        computeSetupPresetSuggestions("balanced", {
          enabledChannels: [],
          knownPresetNames: KNOWN_PRESETS,
          webSearchConfig: { fetchEnabled: true, provider },
          webSearchSupported: true,
        }),
      ).toEqual([...BALANCED_PRESETS, provider]);
    },
  );

  it("routes Locked-Down through Restricted with web search disabled", () => {
    const profile = text.slice(text.indexOf("### Locked-Down"), text.indexOf("### Development"));

    expect(text).toMatch(/^### Locked-Down$/m);
    expect(text).not.toMatch(/^### Locked-Down \(Default\)$/m);
    expect(profile).toContain("Select the Restricted tier during onboarding.");
    expect(profile).toContain(
      "Onboarding defaults to the Balanced tier, which selects the `npm`, `pypi`, `huggingface`, and `brew` presets.",
    );
    expect(profile).toContain("Choose no web search when prompted.");
    expect(profile).toContain(
      "Enabling web search adds the selected `brave` or `tavily` preset even with the Restricted tier.",
    );
  });
});
