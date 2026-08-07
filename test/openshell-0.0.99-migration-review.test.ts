// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const review = fs.readFileSync(
  path.join(repoRoot, "docs", "security", "openshell-0.0.99-migration-review.md"),
  "utf8",
);

const ranges = [
  ["85", "86", 12, 109],
  ["86", "87", 5, 12],
  ["87", "88", 15, 169],
  ["88", "89", 9, 49],
  ["89", "90", 9, 24],
  ["90", "91", 3, 33],
  ["91", "92", 11, 55],
  ["92", "93", 7, 24],
  ["93", "94", 12, 68],
  ["94", "95", 7, 107],
  ["95", "96", 5, 38],
  ["96", "97", 12, 144],
  ["97", "98", 3, 50],
  ["98", "99", 7, 79],
] as const;

describe("OpenShell 0.0.99 migration review", () => {
  it("records every adjacent source range and the complete commit boundary (#8497)", () => {
    expect(ranges.reduce((sum, range) => sum + range[2], 0)).toBe(117);
    for (const [from, to, commits, paths] of ranges) {
      expect(review).toContain(`| \`v0.0.${from} -> v0.0.${to}\` | ${commits} | ${paths} |`);
    }
    expect(review).toContain("515 distinct changed paths");
    const commitLedger = review
      .split("The complete audited commit set")[1]
      ?.split("## Consumed release artifacts")[0];
    expect(commitLedger?.match(/\b[0-9a-f]{8}\b/gu)).toHaveLength(117);
  });

  it("keeps provenance, credential, activation, and runtime gates explicit (#8497)", () => {
    expect(review).toContain("8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032");
    expect(review).toContain(
      "sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6",
    );
    expect(review).toContain("openshell-child-visible-credentials.v0.0.99.json");
    expect(review).toContain("AttachStdout=false");
    expect(review).toContain("non-empty port binding");
    expect(review).toContain("0.0.85 -> 0.0.99");
    expect(review).toContain("without conditional skips or expected failures");
  });
});
