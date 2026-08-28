// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

function compareVersionsDesc(left: string, right: string): number {
  const leftParts = left.slice(1).split(".").map(Number);
  const rightParts = right.slice(1).split(".").map(Number);
  return (
    rightParts
      .map((part, index) => part - leftParts[index])
      .find((difference) => difference !== 0) ?? 0
  );
}

describe("changelog version ordering", () => {
  it("sorts complete semantic versions newest first", () => {
    expect(["v0.0.99", "v0.1.0", "v1.0.0"].sort(compareVersionsDesc)).toEqual([
      "v1.0.0",
      "v0.1.0",
      "v0.0.99",
    ]);
  });
});
