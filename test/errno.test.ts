// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { isErrnoException, isPermissionError } from "../src/lib/errno";

describe("isErrnoException", () => {
  it("returns true for Error with code property", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(isErrnoException(err)).toBe(true);
  });

  it("returns true for plain object with code property", () => {
    expect(isErrnoException({ code: "EACCES" })).toBe(true);
  });

  it("returns true for object with errno property", () => {
    expect(isErrnoException({ errno: -2 })).toBe(true);
  });

  it("returns true for Error with both code and errno", () => {
    const err = Object.assign(new Error("fail"), { code: "ENOENT", errno: -2 });
    expect(isErrnoException(err)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isErrnoException(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isErrnoException(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isErrnoException("ENOENT")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isErrnoException(42)).toBe(false);
  });

  it("returns false for a plain Error without code/errno", () => {
    expect(isErrnoException(new Error("oops"))).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isErrnoException({})).toBe(false);
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
  it("returns true for EACCES", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(isPermissionError(err)).toBe(true);
  });

  it("returns true for EPERM", () => {
    const err = Object.assign(new Error("not permitted"), { code: "EPERM" });
    expect(isPermissionError(err)).toBe(true);
  });

  it("returns false for ENOENT", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(isPermissionError(err)).toBe(false);
  });

  it("returns false for non-errno values", () => {
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError("EACCES")).toBe(false);
    expect(isPermissionError(new Error("oops"))).toBe(false);
  });
});
