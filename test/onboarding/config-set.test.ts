// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The shared source hook preserves the writable CommonJS cache used by these tests.
const require = createRequire(import.meta.url);
const {
  extractDotpath,
  validateConfigDotpath,
  findClobberingAncestor,
  classifyNewKeyGate,
  configSetAllowsOpenShellBridge,
  setDotpath,
  validateUrlValue,
  validateUrlValueWithDns,
  rewriteConfigUrlsWithDnsPinning,
  restartSandboxAgentAfterConfigSet,
  formatConfigValueForLogs,
  resolveAgentConfig,
  buildConfigSetRestartGuidance,
  buildRecomputeSandboxConfigHashScript,
  hermesCompatHashRecoveryError,
  isHermesCompatHashRecoveryError,
} = require("../../src/lib/sandbox/config");
const {
  selectDockerPrivilegedSandboxTarget: selectDirectSandboxContainer,
} = require("../../src/lib/onboard/runtime-provider/docker-privileged-sandbox-identity");

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

describe("buildRecomputeSandboxConfigHashScript", () => {
  it("does not run a pathname hash pass after an OpenClaw config transaction", () => {
    const script = buildRecomputeSandboxConfigHashScript({
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      format: "json",
      configFile: "openclaw.json",
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    });

    expect(script).toBeNull();
  });

  it("does not run a second pathname-based hash pass after a Hermes config transaction", () => {
    const script = buildRecomputeSandboxConfigHashScript({
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      format: "yaml",
      configFile: "config.yaml",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
    });

    expect(script).toBeNull();
  });
});

describe("selectDirectSandboxContainer", () => {
  it("returns the immutable id for an exact direct sandbox container", () => {
    const selected = selectDirectSandboxContainer("demo", "exact-id\topenshell-demo\n", ["demo"]);

    expect(selected).toBe("exact-id");
  });

  it("returns the immutable id for a generated direct sandbox container", () => {
    const selected = selectDirectSandboxContainer("demo", "generated-id\topenshell-demo-abc123\n", [
      "demo",
    ]);

    expect(selected).toBe("generated-id");
  });

  it("returns the immutable id for a v0.0.99 default-workspace container", () => {
    const selected = selectDirectSandboxContainer(
      "demo",
      "generated-id\topenshell-default--demo-abc123\n",
      ["demo"],
    );

    expect(selected).toBe("generated-id");
  });

  it("rejects a prefix-collision container owned by a longer sandbox name", () => {
    expect(() =>
      selectDirectSandboxContainer("demo", "child-id\topenshell-demo-child\n", [
        "demo",
        "demo-child",
      ]),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });
});

describe("config set helpers", () => {
  describe("buildConfigSetRestartGuidance", () => {
    it.each(["openclaw", "hermes"])(
      "keeps managed restart guidance for OpenClaw and Hermes [case %#]",
      (agentName) => {
        const output = buildConfigSetRestartGuidance("alpha", agentName).join("\n");

        expect(output).toContain("--restart");
        expect(output).toContain("nemoclaw 'alpha' gateway restart");
      },
    );

    it("does not name Hermes in the OpenClaw restart note (#8614)", () => {
      const output = buildConfigSetRestartGuidance("alpha", "openclaw").join("\n");

      expect(output).not.toContain("Hermes");
      expect(output).toContain("--restart");
    });

    it("names Hermes in the Hermes restart note (#8614)", () => {
      const output = buildConfigSetRestartGuidance("alpha", "hermes").join("\n");

      expect(output).toContain("Hermes may restart");
      expect(output).toContain("--restart");
    });

    it("uses runtime-specific guidance for custom agents", () => {
      const output = buildConfigSetRestartGuidance("custom-box", "custom-agent").join("\n");

      expect(output).toContain("Follow the restart procedure for 'custom-agent'");
      expect(output).toContain("NemoClaw does not manage restarts for this agent");
      expect(output).not.toContain("--restart");
      expect(output).not.toContain("gateway restart");
    });
  });

  describe("Hermes config-write recovery gate", () => {
    it("names recover for a compat-hash refusal before a config write (#8614)", () => {
      expect(
        isHermesCompatHashRecoveryError(
          new Error(
            "compat hash does not match frozen Hermes inputs during non-root reconciliation",
          ),
        ),
      ).toBe(true);
      expect(isHermesCompatHashRecoveryError(new Error("compat hash verification failed"))).toBe(
        true,
      );
      expect(isHermesCompatHashRecoveryError(new Error("Hermes schema validation rejected"))).toBe(
        false,
      );
      const refusal = hermesCompatHashRecoveryError("triage-8614");
      expect(refusal.name).toBe("SandboxConfigError");
      expect(refusal.message).toContain("nemoclaw 'triage-8614' recover");
      expect(refusal.message).toContain("not applied");
    });
  });

  describe("restartSandboxAgentAfterConfigSet", () => {
    it("routes --restart through the managed gateway supervisor flow", () => {
      const calls: string[] = [];

      restartSandboxAgentAfterConfigSet("alpha", "openclaw", (sandboxName: string) => {
        calls.push(sandboxName);
        return { ok: true };
      });

      expect(calls).toEqual(["alpha"]);
    });

    it("fails with a written-but-not-applied message and a retry hint when the restart fails", () => {
      let thrown: unknown;
      try {
        restartSandboxAgentAfterConfigSet("alpha", "openclaw", () => ({ ok: false }));
      } catch (error) {
        thrown = error;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("written to disk but NOT applied to the running agent");
      expect(message).toContain("openclaw gateway restart did not complete for 'alpha'");
      expect(message).toContain("nemoclaw 'alpha' gateway restart");
    });
  });

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
      expect(classifyNewKeyGate({ acceptEnv: "1", isTTY: false, nonInteractiveEnv: "1" })).toEqual({
        mode: "accept",
      });
    });
  });

  describe("configSetAllowsOpenShellBridge", () => {
    it("allows supported endpoint config leaf paths", () => {
      expect(
        configSetAllowsOpenShellBridge("openclaw", "models.providers.ollama-mem.baseUrl"),
      ).toBe(true);
      expect(
        configSetAllowsOpenShellBridge("openclaw", "models.providers.ollama-mem", ["baseUrl"]),
      ).toBe(true);
      expect(configSetAllowsOpenShellBridge("hermes", "model.base_url")).toBe(true);
    });

    it("does not make the OpenShell bridge exception key-agnostic", () => {
      expect(configSetAllowsOpenShellBridge("openclaw", "telemetry.endpoint")).toBe(false);
      expect(
        configSetAllowsOpenShellBridge("openclaw", "models.providers.ollama-mem", ["healthUrl"]),
      ).toBe(false);
      expect(configSetAllowsOpenShellBridge("openclaw", "models.providers", ["0", "baseUrl"])).toBe(
        false,
      );
      expect(configSetAllowsOpenShellBridge("hermes", "custom_providers.base_url")).toBe(false);
    });

    it("does not grant the bridge exception through reserved key segments", () => {
      expect(
        configSetAllowsOpenShellBridge("openclaw", "models.providers", ["__proto__", "baseUrl"]),
      ).toBe(false);
      expect(
        configSetAllowsOpenShellBridge("openclaw", "models.providers", ["constructor", "baseUrl"]),
      ).toBe(false);
      expect(configSetAllowsOpenShellBridge("hermes", "model", ["__proto__"])).toBe(false);
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

    it("rejects the exact OpenShell host bridge by default", () => {
      expect(() => validateUrlValue("http://host.openshell.internal:1024")).toThrow(/private/i);
      expect(() => validateUrlValue("http://HOST.OPENSHELL.INTERNAL.:65535/v1")).toThrow(
        /private/i,
      );
    });

    it("allows the exact OpenShell host bridge only when explicitly enabled", () => {
      expect(() =>
        validateUrlValue("http://host.openshell.internal:1024", {
          allowOpenShellBridge: true,
        }),
      ).not.toThrow();
      expect(() =>
        validateUrlValue("http://HOST.OPENSHELL.INTERNAL.:65535/v1", {
          allowOpenShellBridge: true,
        }),
      ).not.toThrow();
    });

    it("rejects adjacent OpenShell host bridge bypass shapes", () => {
      const options = { allowOpenShellBridge: true };
      expect(() => validateUrlValue("http://host.openshell.internal:1023/v1", options)).toThrow(
        /private/i,
      );
      expect(() => validateUrlValue("https://host.openshell.internal:11434/v1", options)).toThrow(
        /private/i,
      );
      expect(() =>
        validateUrlValue("http://evil.host.openshell.internal:11434/v1", options),
      ).toThrow(/private/i);
      expect(() =>
        validateUrlValue("http://host.openshell.internal:11434/v1?token=secret", options),
      ).toThrow(/private/i);
      expect(() =>
        validateUrlValue("http://user:pass@host.openshell.internal:11434/v1", options),
      ).toThrow(/private/i);
      expect(() => validateUrlValue("http://host.openshell.internal/v1", options)).toThrow(
        /private/i,
      );
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

    it("rejects the exact OpenShell host bridge by default without DNS lookup", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };
      await expect(
        validateUrlValueWithDns("http://host.openshell.internal:11434/v1", lookup),
      ).rejects.toThrow(/private/i);
    });

    it("allows the exact OpenShell host bridge only when explicitly enabled", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };
      await expect(
        validateUrlValueWithDns("http://host.openshell.internal:11434/v1", lookup, {
          allowOpenShellBridge: true,
        }),
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

    it("fails closed for DNS-backed HTTPS hostname URLs", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(
        rewriteConfigUrlsWithDnsPinning("https://example.com/v1", lookup),
      ).rejects.toThrow(/DNS-backed HTTPS URLs are not supported/);
    });

    it("preserves HTTPS IP-literal URLs without DNS lookup", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for IP literals");
      };
      await expect(
        rewriteConfigUrlsWithDnsPinning("https://93.184.216.34/v1", lookup),
      ).resolves.toBe("https://93.184.216.34/v1");
    });

    it("rejects exact OpenShell host bridge URLs by default", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };
      await expect(
        rewriteConfigUrlsWithDnsPinning("http://host.openshell.internal:11434", lookup),
      ).rejects.toThrow(/private/i);
    });

    it("preserves exact OpenShell host bridge URLs only when explicitly enabled (#7453)", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };
      await expect(
        rewriteConfigUrlsWithDnsPinning(
          {
            models: {
              providers: {
                "ollama-mem": {
                  api: "ollama",
                  baseUrl: "http://host.openshell.internal:11434",
                },
              },
            },
          },
          lookup,
          { allowOpenShellBridge: true },
        ),
      ).resolves.toEqual({
        models: {
          providers: {
            "ollama-mem": {
              api: "ollama",
              baseUrl: "http://host.openshell.internal:11434",
            },
          },
        },
      });
    });

    it("allows exact OpenShell host bridge URLs only at allowlisted nested paths", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };

      await expect(
        rewriteConfigUrlsWithDnsPinning(
          {
            api: "ollama",
            baseUrl: "http://host.openshell.internal:11434",
            healthUrl: "http://host.openshell.internal:11434/api/tags",
            apiKey: "x",
            models: [{ id: "qwen3-embedding:4b", name: "Q" }],
          },
          lookup,
          {
            allowOpenShellBridgePath: (relativePath: readonly string[]) =>
              configSetAllowsOpenShellBridge(
                "openclaw",
                "models.providers.ollama-mem",
                relativePath,
              ),
          },
        ),
      ).rejects.toThrow(/private/i);

      await expect(
        rewriteConfigUrlsWithDnsPinning(
          {
            api: "ollama",
            baseUrl: "http://host.openshell.internal:11434",
            apiKey: "x",
            models: [{ id: "qwen3-embedding:4b", name: "Q" }],
          },
          lookup,
          {
            allowOpenShellBridgePath: (relativePath: readonly string[]) =>
              configSetAllowsOpenShellBridge(
                "openclaw",
                "models.providers.ollama-mem",
                relativePath,
              ),
          },
        ),
      ).resolves.toEqual({
        api: "ollama",
        baseUrl: "http://host.openshell.internal:11434",
        apiKey: "x",
        models: [{ id: "qwen3-embedding:4b", name: "Q" }],
      });
    });

    it("rejects exact OpenShell host bridge URLs below reserved object keys", async () => {
      const lookup = async () => {
        throw new Error("lookup should not run for the OpenShell host bridge");
      };
      const value = JSON.parse('{"__proto__":{"baseUrl":"http://host.openshell.internal:9999"}}');

      await expect(
        rewriteConfigUrlsWithDnsPinning(value, lookup, {
          allowOpenShellBridgePath: (relativePath: readonly string[]) =>
            configSetAllowsOpenShellBridge("openclaw", "models.providers", relativePath),
        }),
      ).rejects.toThrow(/private/i);
    });

    it("keeps DNS pinning for public hosts after private URLs are enabled (#8614)", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

      await expect(
        rewriteConfigUrlsWithDnsPinning("http://api.example.com/v1", lookup, {
          allowPrivateUrls: true,
        }),
      ).resolves.toBe("http://93.184.216.34/v1");
    });

    it("recursively rewrites nested HTTP URLs and leaves non-URLs unchanged", async () => {
      const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(
        rewriteConfigUrlsWithDnsPinning(
          {
            primary: "http://api.example.com/v1",
            label: "production",
            fallbacks: ["http://backup.example.com/v2"],
          },
          lookup,
        ),
      ).resolves.toEqual({
        primary: "http://93.184.216.34/v1",
        label: "production",
        fallbacks: ["http://93.184.216.34/v2"],
      });
    });
  });
});
