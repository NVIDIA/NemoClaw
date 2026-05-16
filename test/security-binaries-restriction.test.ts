// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const BASELINE = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox.yaml",
);
const PRESETS_DIR = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "policies",
  "presets",
);

describe("binaries restriction: baseline policy", () => {
  it("every network_policies entry has a binaries section", () => {
    // Parse YAML manually (no yaml dependency) — find all top-level keys under network_policies
    // and verify each has a "binaries:" line within its block
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    const lines = yaml.split("\n");
    let inNetworkPolicies = false;
    let currentBlock = null;
    const blocks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^network_policies:/.test(line)) {
        inNetworkPolicies = true;
        continue;
      }
      if (inNetworkPolicies && /^\S/.test(line) && line.trim() !== "") {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
        inNetworkPolicies = false;
        continue;
      }
      if (!inNetworkPolicies) continue;
      // Top-level entry under network_policies (2-space indent, not a comment)
      if (/^ {2}(?!#)\S.*:\s*$/.test(line)) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { name: line.trim().replace(/:$/, ""), startLine: i + 1, lines: [line] };
        continue;
      }
      if (currentBlock) currentBlock.lines.push(line);
    }
    if (currentBlock) blocks.push(currentBlock);

    expect(blocks.length).toBeGreaterThan(0);

    const violators = blocks.filter((b) => !b.lines.some((l) => /^\s+binaries:/.test(l)));

    expect(violators.map((b) => b.name)).toEqual([]);
  });
});

describe("binaries restriction: policy presets", () => {
  it("every preset YAML has a binaries section", () => {
    const presets = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(presets.length).toBeGreaterThan(0);

    const missing = [];
    for (const file of presets) {
      const content = fs.readFileSync(path.join(PRESETS_DIR, file), "utf-8");
      if (!/^\s+binaries:\s*$/m.test(content)) {
        missing.push(file);
      }
    }

    expect(missing).toEqual([]);
  });
});
