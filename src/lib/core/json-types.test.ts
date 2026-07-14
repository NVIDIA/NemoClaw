// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isObjectRecord, isPlainObject } from "./json-types";

describe("isObjectRecord", () => {
  it("returns true for a plain object", () => {
    expect(isObjectRecord({ key: "value" })).toBe(true);
  });

  it("returns true for an empty object", () => {
    expect(isObjectRecord({})).toBe(true);
  });

  it("returns true for a nested object", () => {
    expect(isObjectRecord({ a: { b: 1 } })).toBe(true);
  });

  it("stays shallow by accepting objects with non-plain prototypes", () => {
    expect(isObjectRecord(new Date(0))).toBe(true);
    expect(isObjectRecord(new Map())).toBe(true);
  });

  it("returns false for null", () => {
    expect(isObjectRecord(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isObjectRecord(undefined)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isObjectRecord([])).toBe(false);
    expect(isObjectRecord([1, 2, 3])).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isObjectRecord("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isObjectRecord(42)).toBe(false);
  });

  it("returns false for a boolean", () => {
    expect(isObjectRecord(true)).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("accepts object literals and null-prototype objects", () => {
    expect(isPlainObject({ key: "value" })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects non-plain object prototypes", () => {
    class Example {}

    expect(isPlainObject(new Example())).toBe(false);
    expect(isPlainObject(new Date(0))).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
  });

  it("rejects arrays, null, and primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("value")).toBe(false);
  });
});
