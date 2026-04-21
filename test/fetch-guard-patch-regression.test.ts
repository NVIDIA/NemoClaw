// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfileSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "Dockerfile"),
  "utf-8",
);

describe("fetch-guard patch regression guard", () => {
  it("Dockerfile upgrades stale OpenClaw in base image before patching", () => {
    // Must read min version from blueprint
    expect(dockerfileSrc).toContain("min_openclaw_version");
    // Must check installed version against minimum
    expect(dockerfileSrc).toContain("openclaw --version");
    // Must upgrade when stale (any npm flags between `-g` and the target
    // are fine — we've needed to add --no-audit/--no-fund/--no-progress
    // for memory/IO reasons and may need more).
    expect(dockerfileSrc).toMatch(/npm install -g .*"openclaw@\$\{MIN_VER\}"/);
    // The "current" branch must fire when MIN_VER is the smallest (= not !=)
    expect(dockerfileSrc).toContain('| sort -V | head -n1)" = "$MIN_VER" ]; then');
  });

  it("Patch 1 rewrites withStrictGuardedFetchMode export with fail-close", () => {
    expect(dockerfileSrc).toContain("withStrictGuardedFetchMode as [a-z]");
    expect(dockerfileSrc).toContain("withTrustedEnvProxyGuardedFetchMode");
    expect(dockerfileSrc).toContain("Patch 1 left strict-mode export alias");
  });

  it("Patch 2 injects env-gated bypass for assertExplicitProxyAllowed", () => {
    expect(dockerfileSrc).toContain("assertExplicitProxyAllowed");
    expect(dockerfileSrc).toContain('OPENSHELL_SANDBOX === "1"');
  });
});
