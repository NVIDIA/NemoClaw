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
  validateUrlValueWithDns,
  rewriteConfigUrlsWithDnsPinning,
  formatConfigValueForLogs,
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

    it("rejects localhost subdomains", () => {
      expect(() => validateUrlValue("http://api.localhost:8080")).toThrow(/private/i);
    });

    it("rejects reserved hostname suffixes from the shared blocklist", () => {
      expect(() => validateUrlValue("http://printer.local:8080")).toThrow(/private/i);
      expect(() => validateUrlValue("http://my-vm.internal:8080")).toThrow(/private/i);
    });

    it("rejects additional reserved special-use ranges from the shared blocklist", () => {
      expect(() => validateUrlValue("http://192.0.2.1:80")).toThrow(/private/i);
      expect(() => validateUrlValue("http://240.0.0.1:80")).toThrow(/private/i);
      expect(() => validateUrlValue("http://[64:ff9b::a00:1]:80")).toThrow(/private/i);
      expect(() => validateUrlValue("http://[2001::1]:80")).toThrow(/private/i);
      expect(() => validateUrlValue("http://[2002::1]:80")).toThrow(/private/i);
    });
  });

  describe("formatConfigValueForLogs", () => {
    it("redacts scalar strings and URLs in preview output", () => {
      expect(formatConfigValueForLogs("super-secret-value")).toBe('"[REDACTED_STRING]"');
      expect(formatConfigValueForLogs("https://user:pass@example.com/v1?token=secret#frag")).toBe(
        '"[REDACTED_URL]"',
      );
    });

    it("redacts nested credential fields and string leaves", () => {
      const output = formatConfigValueForLogs({
        endpoint: "https://user:pass@example.com/v1?token=secret#frag",
        apiKey: "sk-secret",
        nested: { model: "nemotron", temperature: 0.2 },
      });
      expect(output).toContain("[REDACTED_URL]");
      expect(output).toContain("[REDACTED]");
      expect(output).toContain("[REDACTED_STRING]");
      expect(output).toContain("0.2");
      expect(output).not.toContain("user:pass");
      expect(output).not.toContain("token=secret");
      expect(output).not.toContain("sk-secret");
      expect(output).not.toContain("nemotron");
    });
  });

  describe("validateUrlValueWithDns", () => {
    it("rejects hostname resolving to private IPv4", async () => {
      const lookup = async () => [{ address: "169.254.169.254", family: 4 }];
      await expect(validateUrlValueWithDns("https://example.com/v1", lookup)).rejects.toThrow(
        /private\/internal/i,
      );
    });

    it("rejects hostname resolving to private IPv6", async () => {
      const lookup = async () => [{ address: "fd00::1", family: 6 }];
      await expect(validateUrlValueWithDns("https://example.com/v1", lookup)).rejects.toThrow(
        /private\/internal/i,
      );
    });

    it("rejects hostname when any resolved address is private", async () => {
      const lookup = async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ];
      await expect(validateUrlValueWithDns("https://example.com/v1", lookup)).rejects.toThrow(
        /private\/internal/i,
      );
    });

    it("allows hostname when all resolved addresses are public", async () => {
      const lookup = async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2607:f8b0:4004:800::200e", family: 6 },
      ];
      await expect(validateUrlValueWithDns("https://example.com/v1", lookup)).resolves.toBe(
        undefined,
      );
    });

    it("allows public IPv4 literals without DNS lookup", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for IP literals");
      };
      await expect(validateUrlValueWithDns("https://93.184.216.34/v1", lookup)).resolves.toBe(
        undefined,
      );
    });

    it("allows public bracketed IPv6 literals without DNS lookup", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for IP literals");
      };
      await expect(
        validateUrlValueWithDns("https://[2606:4700:4700::1111]/v1", lookup),
      ).resolves.toBe(undefined);
    });

    it("fails closed when DNS lookup errors", async () => {
      const lookup = async () => {
        throw new Error("NXDOMAIN");
      };
      await expect(validateUrlValueWithDns("https://missing.example/v1", lookup)).rejects.toThrow(
        /Cannot resolve hostname/i,
      );
    });

    it("fails closed when DNS lookup returns no addresses", async () => {
      const lookup = async () => [];
      await expect(validateUrlValueWithDns("https://empty.example/v1", lookup)).rejects.toThrow(
        /no addresses returned/i,
      );
    });
  });

  describe("rewriteConfigUrlsWithDnsPinning", () => {
    it("pins HTTP hostname URLs to the validated DNS address", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(rewriteConfigUrlsWithDnsPinning("http://example.com/v1", lookup)).resolves.toBe(
        "http://93.184.216.34/v1",
      );
    });

    it("preserves HTTPS hostnames after DNS validation", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(rewriteConfigUrlsWithDnsPinning("https://example.com/v1", lookup)).resolves.toBe(
        "https://example.com/v1",
      );
    });

    it("recursively rewrites nested HTTP URLs and leaves non-URLs unchanged", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(
        rewriteConfigUrlsWithDnsPinning(
          {
            primary: "http://api.example.com/v1",
            secure: "https://secure.example.com/v1",
            label: "production",
            fallbacks: ["http://backup.example.com/v2"],
          },
          lookup,
        ),
      ).resolves.toEqual({
        primary: "http://93.184.216.34/v1",
        secure: "https://secure.example.com/v1",
        label: "production",
        fallbacks: ["http://93.184.216.34/v2"],
      });
    });
  });
});
