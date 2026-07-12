// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveHostPathFromCwd } from "./host-path";

describe("resolveHostPathFromCwd", () => {
  it("resolves '.' to the current working directory", () => {
    expect(resolveHostPathFromCwd(".")).toBe(process.cwd());
  });

  it("resolves a relative path against the current working directory", () => {
    expect(resolveHostPathFromCwd("./out")).toBe(path.resolve(process.cwd(), "out"));
    expect(resolveHostPathFromCwd("out/sub")).toBe(path.resolve(process.cwd(), "out", "sub"));
    expect(resolveHostPathFromCwd("../sibling")).toBe(path.resolve(process.cwd(), "..", "sibling"));
  });

  it("returns absolute paths normalised but unmoved", () => {
    expect(resolveHostPathFromCwd("/tmp/out")).toBe("/tmp/out");
    expect(resolveHostPathFromCwd("/tmp//redundant/../out")).toBe("/tmp/out");
  });

  it("preserves a trailing separator on relative directory destinations", () => {
    const resolved = resolveHostPathFromCwd("./out/");
    expect(resolved.endsWith(path.sep) || resolved.endsWith("/")).toBe(true);
    expect(resolved.slice(0, -1)).toBe(path.resolve(process.cwd(), "out"));
  });

  it("preserves a trailing separator on absolute directory destinations", () => {
    expect(resolveHostPathFromCwd("/tmp/out/")).toBe(`/tmp/out${path.sep}`);
  });

  it("passes empty input through unchanged", () => {
    expect(resolveHostPathFromCwd("")).toBe("");
  });
});
