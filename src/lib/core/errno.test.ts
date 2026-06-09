// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { isErrnoException, isPermissionError } from "./errno";

describe("isErrnoException", () => {
  it.each([
    [
      "Error with code property",
      () => Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    ],
    ["plain object with code property", () => ({ code: "EACCES" })],
    ["object with errno property", () => ({ errno: -2 })],
    [
      "Error with both code and errno",
      () => Object.assign(new Error("fail"), { code: "ENOENT", errno: -2 }),
    ],
  ] as const)("returns true for %s", (_label, createValue) => {
    expect(isErrnoException(createValue())).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "ENOENT"],
    ["a number", 42],
    ["a plain Error without code/errno", new Error("oops")],
    ["an empty object", {}],
  ] as const)("returns false for %s", (_label, value) => {
    expect(isErrnoException(value)).toBe(false);
  });

  it("narrows the type so .code is accessible", () => {
    const err: unknown = Object.assign(new Error("fail"), { code: "EPERM" });
    if (isErrnoException(err)) {
      // TypeScript should allow this without a cast.
      expect(err.code).toBe("EPERM");
    } else {
      throw new Error("Expected isErrnoException to return true");
    }
  });
});

describe("isPermissionError", () => {
  it.each([
    [
      "EACCES",
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
      true,
    ],
    ["EPERM", Object.assign(new Error("not permitted"), { code: "EPERM" }), true],
    ["ENOENT", Object.assign(new Error("not found"), { code: "ENOENT" }), false],
    ["null", null, false],
    ["a string", "EACCES", false],
    ["a plain Error", new Error("oops"), false],
  ] as const)("classifies %s", (_label, value, expected) => {
    expect(isPermissionError(value)).toBe(expected);
  });
});
