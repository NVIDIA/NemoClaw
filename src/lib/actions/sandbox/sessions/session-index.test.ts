// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseSessionIndex } from "./session-index";

describe("parseSessionIndex", () => {
  it("accepts a plain JSON array of entries", () => {
    const output = '[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("accepts an object wrapper with a sessions array", () => {
    const output = '{"sessions":[{"key":"agent:main:main","sessionId":"sid-1"}]}';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("treats id as an alias for sessionId", () => {
    const output = '[{"key":"agent:main:main","id":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("tolerates log noise preceding a single-line JSON payload", () => {
    const output = 'warning: deprecation\n[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("tolerates log noise after a pretty JSON payload", () => {
    const output = [
      JSON.stringify({ sessions: [{ key: "agent:main:main", sessionId: "sid-1" }] }, null, 2),
      "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
    ].join("\n");
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("returns [] when the upstream emits an empty index (empty array)", () => {
    expect(parseSessionIndex("[]")).toEqual([]);
  });

  it("returns [] when the upstream emits no output at all", () => {
    expect(parseSessionIndex("")).toEqual([]);
  });

  it("returns null when the output is non-empty but no JSON shape is recognised", () => {
    expect(parseSessionIndex("hello world")).toBeNull();
  });

  it("returns null when the array is non-empty but every entry uses unknown field names (schema drift)", () => {
    const output = JSON.stringify([{ alias: "agent:main:main", uuid: "sid-1" }]);
    expect(parseSessionIndex(output)).toBeNull();
  });

  it("does not accept session-shaped arrays under an unknown wrapper", () => {
    const output = JSON.stringify({
      records: [{ key: "agent:main:main", sessionId: "sid-1" }],
    });
    expect(parseSessionIndex(output)).toBeNull();
  });
});
