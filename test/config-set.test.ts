// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// Build must run before these tests (imports from dist/)
const require = createRequire(import.meta.url);
const {
  extractDotpath,
  isRecognizedConfigPath,
  setDotpath,
  validateUrlValue,
  resolveAgentConfig,
} = require("../dist/lib/sandbox-config");

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
      const obj: Record<string, unknown> = { foo: "old" };
      setDotpath(obj, "foo", "new");
      expect(obj.foo).toBe("new");
    });

    it("sets a nested key", () => {
      const obj: Record<string, unknown> = { a: { b: { c: 1 } } };
      setDotpath(obj, "a.b.c", 99);
      expect((obj.a as Record<string, unknown>).b).toEqual({ c: 99 });
    });

    it("creates intermediate objects if missing", () => {
      const obj: Record<string, unknown> = {};
      setDotpath(obj, "a.b.c", "deep");
      expect(obj).toEqual({ a: { b: { c: "deep" } } });
    });

    it("overwrites non-object intermediate with empty object", () => {
      const obj: Record<string, unknown> = { a: "string" };
      setDotpath(obj, "a.b", "val");
      expect(obj).toEqual({ a: { b: "val" } });
    });

    it("adds a new key to existing object", () => {
      const obj: Record<string, unknown> = { a: { existing: true } };
      setDotpath(obj, "a.newKey", "added");
      expect(obj.a).toEqual({ existing: true, newKey: "added" });
    });
  });

  describe("isRecognizedConfigPath", () => {
    it("accepts an existing top-level key", () => {
      expect(isRecognizedConfigPath({ version: 1 }, "version")).toBe(true);
    });

    it("accepts an existing nested key path", () => {
      expect(
        isRecognizedConfigPath(
          { agents: { defaults: { model: { primary: "gpt-5.4" } } } },
          "agents.defaults.model.primary",
        ),
      ).toBe(true);
    });

    it("accepts existing keys whose value is null", () => {
      expect(isRecognizedConfigPath({ provider: { endpoint: null } }, "provider.endpoint")).toBe(true);
    });

    it("rejects an unknown top-level key", () => {
      expect(isRecognizedConfigPath({ version: 1 }, "inference.endpoint")).toBe(false);
    });

    it("rejects an unknown nested key", () => {
      expect(
        isRecognizedConfigPath(
          { agents: { defaults: { model: { primary: "gpt-5.4" } } } },
          "agents.defaults.model.secondary",
        ),
      ).toBe(false);
    });

    it("rejects malformed dotpaths", () => {
      expect(isRecognizedConfigPath({ version: 1 }, "agents..defaults")).toBe(false);
    });

    it("rejects prototype-inherited keys", () => {
      expect(isRecognizedConfigPath({}, "toString")).toBe(false);
      expect(isRecognizedConfigPath({ safe: {} }, "safe.constructor")).toBe(false);
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
