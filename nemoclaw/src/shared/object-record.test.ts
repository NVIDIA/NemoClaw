// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isObjectRecord, isPlainObject } from "./object-record.js";

class ExampleInstance {}

describe("object record guards", () => {
  describe("isObjectRecord", () => {
    it("accepts every non-null, non-array object as a shallow record", () => {
      expect(isObjectRecord({})).toBe(true);
      expect(isObjectRecord(Object.create(null))).toBe(true);
      expect(isObjectRecord(new Date())).toBe(true);
      expect(isObjectRecord(new ExampleInstance())).toBe(true);
    });

    it("rejects arrays, null, and primitive values", () => {
      expect(isObjectRecord([])).toBe(false);
      expect(isObjectRecord(null)).toBe(false);
      expect(isObjectRecord(undefined)).toBe(false);
      expect(isObjectRecord("value")).toBe(false);
      expect(isObjectRecord(1)).toBe(false);
      expect(isObjectRecord(true)).toBe(false);
    });
  });

  describe("isPlainObject", () => {
    it("accepts objects with Object.prototype or a null prototype", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject(Object.create(null))).toBe(true);
    });

    it("rejects built-in and class instances as well as non-objects", () => {
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(new Map())).toBe(false);
      expect(isPlainObject(new ExampleInstance())).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject("value")).toBe(false);
    });
  });
});
