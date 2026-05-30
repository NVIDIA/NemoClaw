// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseSessionStore,
  resolveSessionIdForKey,
} from "../../../../../dist/lib/actions/sandbox/sessions/store";

describe("session store parsing", () => {
  it("returns an empty store for empty or whitespace input", () => {
    expect(parseSessionStore("")).toEqual({});
    expect(parseSessionStore("   \n  ")).toEqual({});
  });

  it("parses a valid store with multiple entries", () => {
    const json = JSON.stringify({
      "agent:main:main": { sessionId: "abc123", updatedAt: 17000000 },
      "agent:main:telegram:thread": { sessionId: "def456", updatedAt: 17000100 },
    });
    const store = parseSessionStore(json);
    expect(Object.keys(store)).toEqual(["agent:main:main", "agent:main:telegram:thread"]);
    expect(store["agent:main:main"].sessionId).toBe("abc123");
    expect(store["agent:main:telegram:thread"].sessionId).toBe("def456");
  });

  it("drops entries with missing or non-string sessionId", () => {
    const json = JSON.stringify({
      "agent:main:main": { sessionId: "abc123" },
      "agent:main:broken-no-id": {},
      "agent:main:broken-wrong-type": { sessionId: 42 },
    });
    const store = parseSessionStore(json);
    expect(Object.keys(store)).toEqual(["agent:main:main"]);
  });

  it("rejects non-object or array roots", () => {
    expect(() => parseSessionStore("[]")).toThrow(/object map of sessionKey/);
    expect(() => parseSessionStore("null")).toThrow(/object map of sessionKey/);
    expect(() => parseSessionStore("\"string\"")).toThrow(/object map of sessionKey/);
  });

  it("reports malformed JSON with a readable error", () => {
    expect(() => parseSessionStore("{not json}")).toThrow(/Failed to parse session store JSON/);
  });
});

describe("session id resolution", () => {
  const store = parseSessionStore(
    JSON.stringify({
      "agent:main:main": { sessionId: "abc123" },
      "agent:main:telegram:thread": { sessionId: "def456" },
    }),
  );

  it("returns the sessionId for a known key", () => {
    expect(resolveSessionIdForKey(store, "agent:main:main")).toBe("abc123");
    expect(resolveSessionIdForKey(store, "agent:main:telegram:thread")).toBe("def456");
  });

  it("throws a helpful error listing known keys when missing", () => {
    expect(() => resolveSessionIdForKey(store, "agent:main:unknown")).toThrow(
      /not found in sessions store/,
    );
    expect(() => resolveSessionIdForKey(store, "agent:main:unknown")).toThrow(
      /agent:main:main, agent:main:telegram:thread/,
    );
  });

  it("refuses to return an id that fails shell-safe validation", () => {
    const compromised = parseSessionStore(
      JSON.stringify({
        "agent:main:main": { sessionId: "abc123" },
      }),
    );
    compromised["agent:main:main"].sessionId = "abc; rm -rf /";
    expect(() => resolveSessionIdForKey(compromised, "agent:main:main")).toThrow(
      /Refusing to operate/,
    );
  });
});
