// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { cloneAndDeepFreeze } from "./immutable";

describe("cloneAndDeepFreeze", () => {
  it("owns and recursively freezes plain data", () => {
    const source = {
      nested: { enabled: true },
      entries: ["one", { value: 2 }],
      optional: undefined,
    };

    const result = cloneAndDeepFreeze(source);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[1])).toBe(true);
  });

  it.each([
    ["Map", () => new Map([["key", "value"]])],
    ["Set", () => new Set(["value"])],
    ["Date", () => new Date(0)],
    ["ArrayBuffer", () => new ArrayBuffer(8)],
    ["typed array", () => new Uint8Array([1, 2, 3])],
    ["Buffer", () => Buffer.from("binary", "utf8")],
    ["function", () => () => undefined],
  ] as const)("rejects %s input outside the plain-data contract", (_label, createValue) => {
    expect(() => cloneAndDeepFreeze(createValue())).toThrow(/plain|stateful|binary/u);
  });

  it("rejects accessor and symbol-keyed properties", () => {
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "computed",
    });
    const symbolKeyed = { [Symbol("authority")]: "hidden" };

    expect(() => cloneAndDeepFreeze(accessor)).toThrow(/data properties/u);
    expect(() => cloneAndDeepFreeze(symbolKeyed)).toThrow(/symbol-keyed/u);
  });
});
