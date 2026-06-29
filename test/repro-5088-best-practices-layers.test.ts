// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression for issue #5088: docs/security/best-practices.mdx described
// "four layers" in the intro, the Mermaid diagram, and the at-a-glance table,
// but the body documents five layer sections (it adds Gateway Authentication).
// It also linked Sandbox Hardening through the wrong directory
// (manage-sandboxes/ rather than the canonical deployment/ path).
const REPO_ROOT = path.dirname(import.meta.dirname);
const DOC = path.join(REPO_ROOT, "docs", "security", "best-practices.mdx");
const text = fs.readFileSync(DOC, "utf-8");

describe("best-practices.mdx security-layer consistency (#5088)", () => {
  it("links Sandbox Hardening via the canonical deployment path", () => {
    expect(text).not.toMatch(/manage-sandboxes\/sandbox-hardening/);
    expect(text).toMatch(/\.\.\/deployment\/sandbox-hardening/);
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
});
