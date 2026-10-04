// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { containerPathsOverlap } from "./path-overlap";

describe("containerPathsOverlap", () => {
  it.each([
    ["/sandbox/.hermes", "/sandbox/.hermes/"],
    ["/sandbox/.hermes/", "/sandbox/.hermes/session"],
    ["/var/lib/nemoclaw", "/var/lib/nemoclaw/managed-startup/"],
    ["/", "/sandbox"],
  ])("normalizes trailing slashes before detecting overlap", (left, right) => {
    expect(containerPathsOverlap(left, right)).toBe(true);
    expect(containerPathsOverlap(right, left)).toBe(true);
  });

  it("keeps sibling paths distinct", () => {
    expect(containerPathsOverlap("/sandbox/.hermes", "/sandbox/.hermes-cache")).toBe(false);
  });
});
