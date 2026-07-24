// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const fernConfig = JSON.parse(
  readFileSync(path.join(repoRoot, "fern", "fern.config.json"), "utf8"),
) as { version: string };
const review = readFileSync(
  path.join(repoRoot, "docs", "security", "fern-5.80.1-dependency-review.md"),
  "utf8",
);

describe("Fern dependency review", () => {
  it("binds the production pin to the reviewed target artifact", () => {
    expect(fernConfig.version).toBe("5.80.1");
    expect(review).toContain("`fern-api@5.80.1`");
    expect(review).toContain("`76de91e1216afbdb56a36d3389ee6b91d3e59a9e`");
    expect(review).toContain(
      "`sha512-1GZglZnA8T1JogREverqNwIY5G9e3e6uRHv1bpMjX0iIJVr+Dh+5MMPSBq6NegTmBjppqRHF6PVNbnuuO9VfRA==`",
    );
    expect(review).toContain("`a06a295390f91b8bbd42de56d0d481f545642595`");
  });

  it("records complete range, closure, and concern dispositions", () => {
    expect(review).toContain("21 adjacent published versions and 225 source commits");
    expect(review).toContain("`behind_by=0`");
    expect(review).toMatch(/Each\s+graph contains 11 packages/);
    expect(review).toContain("zero info, low, moderate, high, or critical findings");
    expect(review).toContain("Unresolved high-severity concerns: `0`");

    for (let concern = 1; concern <= 10; concern += 1) {
      expect(review).toContain(`\`FERN-${concern}\``);
    }
  });
});
