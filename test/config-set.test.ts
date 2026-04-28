// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// Build must run before these tests (imports from dist/)
const require = createRequire(import.meta.url);
const {
  extractDotpath,
  validateConfigDotpath,
  findClobberingAncestor,
  classifyNewKeyGate,
  setDotpath,
  validateUrlValue,
  resolveAgentConfig,
} = require("../dist/lib/sandbox-config");

type MutableScalar = string | number | boolean | null | undefined;
type MutableValue = MutableScalar | MutableMap | MutableValue[];
type MutableMap = { [key: string]: MutableValue };
type NestedConfig = { a?: { b?: { c?: number } } };

describe("resolveAgentConfig", () => {
  it("returns openclaw defaults for unknown sandbox", () => {
    const target = resolveAgentConfig("nonexistent-sandbox");
    expect(target.agentName).toBe("openclaw");
    expect(target.configPath).toBe("/sandbox/.openclaw/openclaw.json");
    expect(target.format).toBe("json");
  });

  it("returns a configDir that is the parent of configPath", () => {
    const target = resolveAgentConfig("any-sandbox");
    expect(target.configPath.startsWith(target.configDir)).toBe(true);
  });

  it("includes configFile in configPath", () => {
    const target = resolveAgentConfig("any-sandbox");
    expect(target.configPath.endsWith(target.configFile)).toBe(true);
  });
});

describe("config set helpers", () => {
  describe("extractDotpath", () => {
    it("extracts a top-level key", () => {
      expect(extractDotpath({ foo: "bar" }, "foo")).toBe("bar");
    });

    it("extracts a nested key", () => {
      expect(extractDotpath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
    });

    it("returns undefined for missing key", () => {
      expect(extractDotpath({ a: 1 }, "b")).toBeUndefined();
    });

    it("returns undefined for null intermediate", () => {
      expect(extractDotpath({ a: null }, "a.b")).toBeUndefined();
    });

    it("handles array values", () => {
      expect(extractDotpath({ a: [1, 2, 3] }, "a")).toEqual([1, 2, 3]);
    });
  });

  describe("setDotpath", () => {
    it("sets a top-level key", () => {
      const obj: MutableMap = { foo: "old" };
      setDotpath(obj, "foo", "new");
      expect(obj.foo).toBe("new");
    });

    it("sets a nested key", () => {
      const obj: NestedConfig = { a: { b: { c: 1 } } };
      setDotpath(obj, "a.b.c", 99);
      expect(obj.a?.b).toEqual({ c: 99 });
    });

    it("creates intermediate objects if missing", () => {
      const obj: MutableMap = {};
      setDotpath(obj, "a.b.c", "deep");
      expect(obj).toEqual({ a: { b: { c: "deep" } } });
    });

    it("overwrites non-object intermediate with empty object", () => {
      const obj: MutableMap = { a: "string" };
      setDotpath(obj, "a.b", "val");
      expect(obj).toEqual({ a: { b: "val" } });
    });

    it("adds a new key to existing object", () => {
      const obj: MutableMap = { a: { existing: true } };
      setDotpath(obj, "a.newKey", "added");
      expect(obj.a).toEqual({ existing: true, newKey: "added" });
    });
  });

  describe("validateConfigDotpath", () => {
    it("accepts a top-level key", () => {
      expect(validateConfigDotpath("version")).toEqual({ ok: true });
    });

    it("accepts a deeply nested path", () => {
      expect(validateConfigDotpath("provider.compatible-endpoint.timeoutSeconds")).toEqual({
        ok: true,
      });
    });

    it("rejects empty input", () => {
      expect(validateConfigDotpath("").ok).toBe(false);
    });

    it("rejects an empty segment in the middle", () => {
      expect(validateConfigDotpath("agents..defaults").ok).toBe(false);
    });

    it("rejects a leading or trailing dot", () => {
      expect(validateConfigDotpath(".agents").ok).toBe(false);
      expect(validateConfigDotpath("agents.").ok).toBe(false);
    });

    it("rejects prototype-pollution segments anywhere in the path", () => {
      expect(validateConfigDotpath("__proto__").ok).toBe(false);
      expect(validateConfigDotpath("agents.constructor").ok).toBe(false);
      expect(validateConfigDotpath("agents.prototype.config").ok).toBe(false);
      expect(validateConfigDotpath("provider.__proto__.polluted").ok).toBe(false);
      expect(validateConfigDotpath("tools.hasOwnProperty").ok).toBe(false);
      expect(validateConfigDotpath("toString").ok).toBe(false);
    });

    it("returns a reason describing the failure", () => {
      const result = validateConfigDotpath("agents..defaults");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/empty segment/);
    });
  });

  describe("findClobberingAncestor", () => {
    it("returns null for a top-level path (no ancestors to clobber)", () => {
      expect(findClobberingAncestor({ a: 1 }, "a")).toBeNull();
      expect(findClobberingAncestor({}, "newKey")).toBeNull();
    });

    it("returns null when every existing ancestor is a config object", () => {
      expect(findClobberingAncestor({ a: { b: { c: 1 } } }, "a.b.c")).toBeNull();
      expect(findClobberingAncestor({ a: { b: {} } }, "a.b.newLeaf")).toBeNull();
    });

    it("returns null when an ancestor segment is missing entirely", () => {
      expect(findClobberingAncestor({}, "a.b.c")).toBeNull();
      expect(findClobberingAncestor({ a: { b: {} } }, "a.b.c.d.e")).toBeNull();
    });

    it("refuses numeric segments anywhere in the path", () => {
      const top = findClobberingAncestor({}, "0");
      expect(top).not.toBeNull();
      expect(top?.segment).toBe("0");
      expect(top?.reason).toMatch(/numeric/i);

      const mid = findClobberingAncestor({}, "tools.0.name");
      expect(mid).not.toBeNull();
      expect(mid?.segment).toBe("tools.0");
      expect(mid?.reason).toMatch(/array editing/i);
    });

    it("describes a string ancestor as 'a string'", () => {
      const result = findClobberingAncestor({ a: "scalar" }, "a.b");
      expect(result).toEqual({ segment: "a", reason: "is a string, not a config object" });
    });

    it("describes a number or boolean ancestor by typeof", () => {
      expect(findClobberingAncestor({ a: 42 }, "a.b")?.reason).toBe(
        "is a number, not a config object",
      );
      expect(findClobberingAncestor({ a: { b: true } }, "a.b.c")?.reason).toBe(
        "is a boolean, not a config object",
      );
    });

    it("describes a null ancestor as 'null'", () => {
      const result = findClobberingAncestor({ a: null }, "a.b");
      expect(result).toEqual({ segment: "a", reason: "is null, not a config object" });
    });

    it("describes an array ancestor as 'an array'", () => {
      const result = findClobberingAncestor({ a: [1, 2, 3] }, "a.b");
      expect(result).toEqual({ segment: "a", reason: "is an array, not a config object" });
    });

    it("identifies the deepest blocking ancestor along the path", () => {
      const result = findClobberingAncestor({ a: { b: { c: "leaf" } } }, "a.b.c.d");
      expect(result?.segment).toBe("a.b.c");
      expect(result?.reason).toMatch(/string/);
    });
  });

  describe("classifyNewKeyGate", () => {
    it("accepts when --config-accept-new-path is set, even without a TTY", () => {
      expect(classifyNewKeyGate({ acceptNewPath: true, isTTY: false })).toEqual({
        mode: "accept",
      });
    });

    it("accepts when NEMOCLAW_CONFIG_ACCEPT_NEW_PATH=1, even without a TTY", () => {
      expect(classifyNewKeyGate({ acceptEnv: "1", isTTY: false })).toEqual({
        mode: "accept",
      });
    });

    it("treats env values other than '1' as not accepted", () => {
      expect(classifyNewKeyGate({ acceptEnv: "true", isTTY: false })).toEqual({
        mode: "refuse",
      });
      expect(classifyNewKeyGate({ acceptEnv: "yes", isTTY: false })).toEqual({
        mode: "refuse",
      });
      expect(classifyNewKeyGate({ acceptEnv: "", isTTY: false })).toEqual({
        mode: "refuse",
      });
    });

    it("refuses when stdin is not a TTY and no override is in effect", () => {
      expect(classifyNewKeyGate({ isTTY: false })).toEqual({ mode: "refuse" });
    });

    it("refuses when NEMOCLAW_NON_INTERACTIVE=1, even on a TTY", () => {
      expect(classifyNewKeyGate({ isTTY: true, nonInteractiveEnv: "1" })).toEqual({
        mode: "refuse",
      });
    });

    it("prompts on a TTY when no override is in effect", () => {
      expect(classifyNewKeyGate({ isTTY: true })).toEqual({ mode: "prompt" });
    });

    it("override beats NEMOCLAW_NON_INTERACTIVE", () => {
      expect(
        classifyNewKeyGate({ acceptNewPath: true, isTTY: true, nonInteractiveEnv: "1" }),
      ).toEqual({ mode: "accept" });
      expect(
        classifyNewKeyGate({ acceptEnv: "1", isTTY: false, nonInteractiveEnv: "1" }),
      ).toEqual({ mode: "accept" });
    });
  });

  describe("validateUrlValue", () => {
    it("accepts public https URLs", () => {
      expect(() => validateUrlValue("https://api.nvidia.com/v1")).not.toThrow();
    });

    it("accepts public http URLs", () => {
      expect(() => validateUrlValue("http://example.com")).not.toThrow();
    });

    it("rejects localhost", () => {
      expect(() => validateUrlValue("http://localhost:8080")).toThrow(/private/i);
    });

    it("rejects 127.0.0.1", () => {
      expect(() => validateUrlValue("http://127.0.0.1:3000")).toThrow(/private/i);
    });

    it("rejects 10.x.x.x", () => {
      expect(() => validateUrlValue("http://10.0.0.1:8080")).toThrow(/private/i);
    });

    it("rejects 192.168.x.x", () => {
      expect(() => validateUrlValue("http://192.168.1.1:80")).toThrow(/private/i);
    });

    it("rejects 172.16-31.x.x", () => {
      expect(() => validateUrlValue("http://172.16.0.1:80")).toThrow(/private/i);
      expect(() => validateUrlValue("http://172.31.255.1:80")).toThrow(/private/i);
    });

    it("allows 172.15.x.x (not private)", () => {
      expect(() => validateUrlValue("http://172.15.0.1:80")).not.toThrow();
    });

    it("rejects ftp scheme", () => {
      expect(() => validateUrlValue("ftp://files.example.com")).toThrow(/scheme/i);
    });

    it("does not throw for non-URL strings", () => {
      expect(() => validateUrlValue("just a string")).not.toThrow();
      expect(() => validateUrlValue("42")).not.toThrow();
    });

    it("rejects IPv6 loopback", () => {
      expect(() => validateUrlValue("http://[::1]:8080")).toThrow(/private/i);
    });
  });
});
