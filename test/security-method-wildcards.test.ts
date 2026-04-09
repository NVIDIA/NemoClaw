// @ts-nocheck
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

describe("method wildcards: baseline policy", () => {
  it('no endpoint uses method: "*" wildcard', () => {
    // method: "*" permits DELETE, PUT, PATCH which inference APIs do not
    // require. All endpoints should use explicit method rules (GET, POST).
    const yaml = fs.readFileSync(BASELINE, "utf-8");
    const lines = yaml.split("\n");
    const violations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/method:\s*["']\*["']/.test(line)) {
        violations.push({ line: i + 1, content: line.trim() });
      }
    }

    expect(violations).toEqual([]);
  });
});
