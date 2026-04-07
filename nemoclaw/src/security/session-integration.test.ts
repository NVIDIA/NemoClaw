// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import { wireSessionTracker, classifyToolCall, type PluginApi } from "./session-integration.js";
import { Capability } from "./session-tracker.js";

// ── Test helpers ─────────────────────────────────────────────

type HookHandler = (...args: unknown[]) => void;

function createMockApi(): PluginApi & {
  hooks: Map<string, HookHandler[]>;
  warnings: string[];
  fire(hookName: string, ctx: unknown): void;
} {
  const hooks = new Map<string, HookHandler[]>();
  const warnings: string[] = [];
  return {
    logger: { warn: (msg: string) => warnings.push(msg) },
    on(hookName: string, handler: HookHandler) {
      if (!hooks.has(hookName)) {
        hooks.set(hookName, []);
      }
      const list = hooks.get(hookName);
      if (list) {
        list.push(handler);
      }
    },
    hooks,
    warnings,
    fire(hookName: string, ctx: unknown) {
      for (const h of hooks.get(hookName) ?? []) {
        h(ctx);
      }
    },
  };
}

// ── classifyToolCall ─────────────────────────────────────────

describe("classifyToolCall", () => {
  it("classifies read_file with sensitive path as ReadSensitive", () => {
    const result = classifyToolCall("read_file", { path: "/etc/passwd" });
    expect(result).toEqual({ cap: Capability.ReadSensitive, detail: "/etc/passwd" });
  });

  it("classifies cat with .env path as ReadSensitive", () => {
    const result = classifyToolCall("cat", { path: "/app/.env" });
    expect(result).toEqual({ cap: Capability.ReadSensitive, detail: "/app/.env" });
  });

  it("classifies cat with .env.local as ReadSensitive", () => {
    const result = classifyToolCall("cat", { path: "/app/.env.local" });
    expect(result).toEqual({ cap: Capability.ReadSensitive, detail: "/app/.env.local" });
  });

  it("returns null for read_file with non-sensitive path", () => {
    const result = classifyToolCall("read_file", { path: "/app/src/index.ts" });
    expect(result).toBeNull();
  });

  it("classifies fetch as IngestedUntrusted", () => {
    const result = classifyToolCall("fetch", { url: "https://example.com" });
    expect(result).toEqual({ cap: Capability.IngestedUntrusted, detail: "https://example.com" });
  });

  it("classifies curl as IngestedUntrusted", () => {
    const result = classifyToolCall("curl", { url: "https://untrusted.com/payload" });
    expect(result).toEqual({
      cap: Capability.IngestedUntrusted,
      detail: "https://untrusted.com/payload",
    });
  });

  it("classifies http_post as HasEgress", () => {
    const result = classifyToolCall("http_post", { url: "https://evil.com/exfil" });
    expect(result).toEqual({ cap: Capability.HasEgress, detail: "https://evil.com/exfil" });
  });

  it("classifies send_email as HasEgress", () => {
    const result = classifyToolCall("send_email", { to: "attacker@evil.com" });
    expect(result).toEqual({ cap: Capability.HasEgress, detail: "attacker@evil.com" });
  });

  it("returns null for unknown tools", () => {
    const result = classifyToolCall("unknown_tool", {});
    expect(result).toBeNull();
  });

  it("is case-insensitive for tool names", () => {
    const result = classifyToolCall("Read_File", { path: "/etc/shadow" });
    expect(result).toEqual({ cap: Capability.ReadSensitive, detail: "/etc/shadow" });
  });

  it("matches credentials path case-insensitively", () => {
    const result = classifyToolCall("cat", { path: "/app/Credentials.json" });
    expect(result).toEqual({ cap: Capability.ReadSensitive, detail: "/app/Credentials.json" });
  });

  it("returns null for read_file with no path arg", () => {
    const result = classifyToolCall("read_file", {});
    expect(result).toBeNull();
  });
});

// ── wireSessionTracker ───────────────────────────────────────

describe("wireSessionTracker", () => {
  let api: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    api = createMockApi();
  });

  it("registers before_tool_call and session_end hooks", () => {
    wireSessionTracker(api);
    expect(api.hooks.has("before_tool_call")).toBe(true);
    expect(api.hooks.has("session_end")).toBe(true);
  });

  it("returns a SessionStore instance", () => {
    const store = wireSessionTracker(api);
    expect(store).toBeDefined();
    expect(typeof store.record).toBe("function");
    expect(typeof store.hasTrifecta).toBe("function");
  });

  it("records ReadSensitive on file read with sensitive path", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "cat",
      args: { path: "/etc/passwd" },
    });
    const caps = store.getCapabilities("s1");
    expect(caps).not.toBeNull();
    expect(caps?.[Capability.ReadSensitive]).toBe(true);
  });

  it("records IngestedUntrusted on fetch", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "fetch",
      args: { url: "https://external.com" },
    });
    const caps = store.getCapabilities("s1");
    expect(caps).not.toBeNull();
    expect(caps?.[Capability.IngestedUntrusted]).toBe(true);
  });

  it("records HasEgress on http_post", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "http_post",
      args: { url: "https://evil.com" },
    });
    const caps = store.getCapabilities("s1");
    expect(caps).not.toBeNull();
    expect(caps?.[Capability.HasEgress]).toBe(true);
  });

  it("logs warning when trifecta is detected", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "cat",
      args: { path: "/etc/passwd" },
    });
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "fetch",
      args: { url: "https://untrusted.com" },
    });
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "http_post",
      args: { url: "https://evil.com" },
    });
    expect(store.hasTrifecta("s1")).toBe(true);
    expect(api.warnings).toHaveLength(1);
    expect(api.warnings[0]).toContain("trifecta detected");
    expect(api.warnings[0]).toContain("s1");
  });

  it("cleans up session on session_end", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "cat",
      args: { path: "/etc/passwd" },
    });
    expect(store.getCapabilities("s1")).not.toBeNull();
    api.fire("session_end", { sessionId: "s1" });
    expect(store.getCapabilities("s1")).toBeNull();
  });

  it("ignores tool calls with no sessionId", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      tool: "cat",
      args: { path: "/etc/passwd" },
    });
    expect(store.listSessions()).toHaveLength(0);
  });

  it("ignores non-matching tools", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "echo",
      args: { text: "hello" },
    });
    expect(store.getCapabilities("s1")).toBeNull();
  });

  it("ignores read_file with non-sensitive path", () => {
    const store = wireSessionTracker(api);
    api.fire("before_tool_call", {
      sessionId: "s1",
      tool: "read_file",
      args: { path: "/app/README.md" },
    });
    expect(store.getCapabilities("s1")).toBeNull();
  });
});
