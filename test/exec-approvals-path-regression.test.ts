// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("exec approvals path regression guard", () => {
  it("Dockerfile.base patches and validates OpenClaw exec approvals path across dist bundles", () => {
    const dockerfileBase = path.join(import.meta.dirname, "..", "Dockerfile.base");
    const src = fs.readFileSync(dockerfileBase, "utf-8");

    expect(src).toContain("--include='*.js'");
    expect(src).toContain("~/.openclaw/exec-approvals.json");
    expect(src).toContain("~/.openclaw-data/exec-approvals.json");
    expect(src).toContain("Unable to verify OpenClaw exec approvals path in dist");
  });

  it("Dockerfile applies a runtime compatibility patch for stale base images", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain('[ ! -d "$OPENCLAW_DIST_DIR" ]');
    expect(src).toContain("--include='*.js'");
    expect(src).toContain("~/.openclaw/exec-approvals.json");
    expect(src).toContain("~/.openclaw-data/exec-approvals.json");
    expect(src).toContain("Unable to verify OpenClaw exec approvals path in dist");
    expect(src).toContain("OpenClaw dist directory not found:");
    expect(src).toContain("OpenClaw exec approvals path patch failed");
  });
});
