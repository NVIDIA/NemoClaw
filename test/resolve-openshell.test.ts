// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveOpenshell } from "../dist/lib/resolve-openshell";

describe("resolveOpenshell", () => {
  it("returns an absolute command -v result immediately", () => {
    expect(resolveOpenshell({ commandVResult: "/usr/local/bin/openshell" })).toBe(
      "/usr/local/bin/openshell",
    );
  });

  it("ignores non-absolute command -v output and falls back to known locations", () => {
    expect(
      resolveOpenshell({
        home: "/tmp/test-home",
        commandVResult: "openshell",
        checkExecutable: (candidate) => candidate === "/usr/local/bin/openshell",
      }),
    ).toBe("/usr/local/bin/openshell");
  });

  it("prefers the home-local fallback before system paths", () => {
    expect(
      resolveOpenshell({
        home: "/tmp/test-home",
        commandVResult: "",
        checkExecutable: (candidate) => candidate === "/tmp/test-home/.local/bin/openshell",
      }),
    ).toBe("/tmp/test-home/.local/bin/openshell");
  });

  it("skips invalid home values when checking fallback candidates", () => {
    expect(
      resolveOpenshell({
        home: "relative-home",
        commandVResult: null,
        checkExecutable: (candidate) => candidate === "/usr/bin/openshell",
      }),
    ).toBe("/usr/bin/openshell");
  });

  it("returns null when no resolved path is executable", () => {
    expect(
      resolveOpenshell({
        home: "/tmp/test-home",
        commandVResult: "",
        checkExecutable: () => false,
      }),
    ).toBe(null);
  });
});
