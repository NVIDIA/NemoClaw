// SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { describe, expect, it, vi } from "vitest";

// The plugin's entry-point import (`openclaw/plugin-sdk/plugin-entry`) is provided
// by the OpenClaw host at runtime and is not an installed dependency in this repo.
// Stub it so the module loads under test; these tests drive the internal functions
// directly and never call createBlackwallPlugin (the only user of definePluginEntry).
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import {
  createBlackwallPlugin,
  handleBeforeToolCall,
  proxyFetch,
  requireSecureBaseUrl,
  resolveConfig,
} from "./index.ts";

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function verdict(recommendation: string, extra: Record<string, unknown> = {}) {
  return {
    recommendation,
    risk_score: 50,
    id: "fc-1",
    red_flags: [{ code: "R1", label: "risky" }],
    ...extra,
  };
}
const forecastReturning = (v: unknown) => vi.fn(async () => v);
const forecastThrowing = () =>
  vi.fn(async () => {
    throw new Error("backend down");
  });
const ev = (overrides: Record<string, unknown> = {}) => ({
  toolName: "shell",
  toolCallId: "call-1",
  params: { cmd: "rm -rf /" },
  ...overrides,
});
// resolveConfig injects forecast/observe when provided, so the whole gate is
// driven by a mock backend — no network.
const cfg = (overrides: Record<string, unknown>) =>
  resolveConfig({ apiKey: "test-key", observe: vi.fn(async () => {}), ...overrides } as any);

describe("requireSecureBaseUrl (PRA-3: no bearer key over plaintext HTTP)", () => {
  it("allows any https base URL", () => {
    expect(requireSecureBaseUrl("https://blackwalltier.com")).toBe("https://blackwalltier.com");
  });

  it("allows http only for loopback (no off-host observer)", () => {
    expect(requireSecureBaseUrl("http://localhost:8080")).toContain("localhost");
    expect(requireSecureBaseUrl("http://127.0.0.1:9000")).toContain("127.0.0.1");
    expect(requireSecureBaseUrl("http://[::1]:3000")).toContain("::1");
  });

  it("REJECTS http to a remote host before any request/header is emitted", () => {
    // These are the leak vectors: the API key would ride an Authorization header
    // over plaintext to a network peer.
    expect(() => requireSecureBaseUrl("http://blackwalltier.com")).toThrow(/refusing|https/i);
    expect(() => requireSecureBaseUrl("http://10.0.0.5:8080")).toThrow(/refusing|https/i);
    expect(() => requireSecureBaseUrl("http://evil.example.com")).toThrow(/refusing|https/i);
  });

  it("rejects a malformed base URL", () => {
    expect(() => requireSecureBaseUrl("not-a-url")).toThrow(/invalid base URL/i);
  });
});

describe("plugin metadata (PRA-1: docs must not claim a nonexistent approval prompt)", () => {
  it("the registered plugin description reflects that CAUTION blocks, not prompts", () => {
    const plugin = createBlackwallPlugin() as { description?: string };
    expect(typeof plugin.description).toBe("string");
    // The runtime has no interactive approval surface; claiming CAUTION "surfaces
    // approval prompts" (the pre-PRA-1 wording) is a false capability claim.
    expect(plugin.description).not.toMatch(/approval prompt/i);
    expect(plugin.description ?? "").toMatch(/blocks CAUTION/i);
  });
});

describe("handleBeforeToolCall state machine (PRA-5)", () => {
  it("returns undefined when there is no toolName (nothing to gate)", async () => {
    const c = cfg({ mode: "enforce", forecast: forecastReturning(verdict("STOP")) });
    expect(await handleBeforeToolCall({ params: {} }, c, silent)).toBeUndefined();
  });

  it("returns undefined (opt-out) when shouldGate is false, without calling forecast", async () => {
    const f = forecastReturning(verdict("STOP"));
    const c = cfg({ mode: "enforce", shouldGate: () => false, forecast: f });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("observe mode scores but NEVER blocks, even on STOP", async () => {
    const f = forecastReturning(verdict("STOP"));
    const c = cfg({ mode: "observe", forecast: f });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("enforce + GO -> proceeds (undefined)", async () => {
    const c = cfg({ mode: "enforce", forecast: forecastReturning(verdict("GO")) });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
  });

  it("enforce + STOP -> hard block", async () => {
    const c = cfg({ mode: "enforce", forecast: forecastReturning(verdict("STOP")) });
    const r = await handleBeforeToolCall(ev(), c, silent);
    expect(r).toMatchObject({ block: true });
    expect(typeof r.blockReason).toBe("string");
  });

  it("enforce + CAUTION + cautionAction=allow -> proceeds", async () => {
    const c = cfg({
      mode: "enforce",
      cautionAction: "allow",
      forecast: forecastReturning(verdict("CAUTION")),
    });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
  });

  it("enforce + CAUTION + cautionAction=approve -> BLOCK (runtime has no approval surface)", async () => {
    const c = cfg({
      mode: "enforce",
      cautionAction: "approve",
      forecast: forecastReturning(verdict("CAUTION")),
    });
    expect(await handleBeforeToolCall(ev(), c, silent)).toMatchObject({ block: true });
  });

  it("enforce + CAUTION + cautionAction=block -> block", async () => {
    const c = cfg({
      mode: "enforce",
      cautionAction: "block",
      forecast: forecastReturning(verdict("CAUTION")),
    });
    expect(await handleBeforeToolCall(ev(), c, silent)).toMatchObject({ block: true });
  });

  it("enforce + unrecognized recommendation -> block (fail closed)", async () => {
    const c = cfg({ mode: "enforce", forecast: forecastReturning(verdict("WOBBLE")) });
    expect(await handleBeforeToolCall(ev(), c, silent)).toMatchObject({ block: true });
  });

  it("forecast error + enforce + failClosed -> block", async () => {
    const c = cfg({ mode: "enforce", failClosed: true, forecast: forecastThrowing() });
    expect(await handleBeforeToolCall(ev(), c, silent)).toMatchObject({ block: true });
  });

  it("forecast error + enforce + NOT failClosed -> fail open (undefined)", async () => {
    const c = cfg({ mode: "enforce", failClosed: false, forecast: forecastThrowing() });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
  });

  it("forecast error + observe -> undefined", async () => {
    const c = cfg({ mode: "observe", forecast: forecastThrowing() });
    expect(await handleBeforeToolCall(ev(), c, silent)).toBeUndefined();
  });
});

describe("proxyFetch CONNECT-header cap (PRA-4)", () => {
  it("aborts (bounded) when an untrusted proxy floods the CONNECT header with no terminator", async () => {
    // Malicious proxy: accept the TCP connection, read the CONNECT request, then stream
    // far past the 64KB cap WITHOUT ever sending the "\r\n\r\n" terminator. The client
    // must reject with the cap error instead of buffering unboundedly.
    const server = net.createServer((sock) => {
      sock.on("error", () => {}); // client aborts mid-flood -> ignore EPIPE/ECONNRESET
      sock.once("data", () => {
        const chunk = Buffer.alloc(16 * 1024, 0x41); // 16KB of 'A', never a CRLFCRLF
        let sent = 0;
        const pump = () => {
          while (sent < 512 * 1024 && sock.writable) {
            sent += chunk.length;
            if (!sock.write(chunk)) {
              sock.once("drain", pump);
              return;
            }
          }
        };
        pump();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    try {
      const fetchViaProxy = proxyFetch(`http://127.0.0.1:${port}`);
      // 5s abort is a safety net; the cap should fire well before it.
      await expect(
        fetchViaProxy("https://example.invalid/x", { signal: AbortSignal.timeout(5000) }),
      ).rejects.toThrow(/CONNECT response header exceeded/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
