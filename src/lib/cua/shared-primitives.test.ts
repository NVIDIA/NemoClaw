// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_DOMAIN_COORDINATE,
  CUA_HOST_COORDINATE,
  canonicalizeCuaJson,
  canonicalJsonSha256,
} from "./shared-primitives";

describe("CUA shared credential-free value primitives", () => {
  it("rejects IPv6 and arbitrary-domain host coordinates (#7755)", () => {
    expect(CUA_HOST_COORDINATE.test("2001:db8::1")).toBe(true);
    expect(CUA_DOMAIN_COORDINATE.test("provider.example.xyz")).toBe(true);
    expect(CUA_HOST_COORDINATE.test("agents-nemocua.yaml")).toBe(false);
    expect(CUA_HOST_COORDINATE.test("nvidia-provider")).toBe(false);
  });

  it("serializes numeric property names in code-unit order (#7755)", () => {
    const value = { "2": "two", "10": "ten", nested: { z: 1, a: 2 } };

    expect(canonicalizeCuaJson(value)).toBe('{"10":"ten","2":"two","nested":{"a":2,"z":1}}');
    expect(canonicalJsonSha256(value)).toBe(
      "83906dec6494e0c5b8791aaf0b84a3aa9d718c74154ccde98c48ca49c96d398e",
    );
  });

  it("rejects circular values and accepts repeated acyclic references (#7755)", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => canonicalizeCuaJson(circular)).toThrow(
      new TypeError("CUA canonical JSON value contains a circular reference"),
    );

    const shared = { value: 1 };
    expect(canonicalizeCuaJson({ left: shared, right: shared })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );
  });
});
