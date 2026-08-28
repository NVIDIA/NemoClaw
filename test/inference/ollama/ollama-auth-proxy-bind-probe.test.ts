// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #6014 first PR: cover the loopback bind probe inside the Ollama auth proxy.
//
// THREAT MODEL (advisor PRA-5):
//   The proxy is the token-authenticated network gate in front of Ollama on
//   every topology where `shouldFrontOllamaWithProxy()` returns true (native
//   Linux + macOS + WSL native dockerd -- see local-inference-topology.ts).
//   Ollama itself has no built-in auth. If the Ollama backend is reachable
//   on ANY non-loopback interface on the host, an attacker on the same LAN
//   (or a co-tenant on a shared host) can bypass the proxy entirely by
//   connecting directly to `<host-ip>:11434`. The token check the proxy
//   enforces on port 11435 is useless in that case.
//
//   The probe under test is the proxy's independent guard against this: at
//   startup, walk /proc/net/tcp{,6} (or fall back to `lsof`) and refuse to
//   listen if any observed LISTEN-state socket on the backend port is NOT
//   loopback. The tests below pin every branch of that classifier so a
//   regression cannot silently downgrade the security posture:
//     - Correct loopback classification for IPv4 (127.0.0.0/8), IPv6 (::1),
//       and IPv4-mapped IPv6 (::ffff:127.0.0.0/8), on BOTH the /proc-based
//       and the lsof-based classifiers
//     - Refusal of every non-loopback shape (wildcard, non-127 IPv4, IPv6
//       wildcard, IPv4-mapped IPv6 to a non-127 address)
//     - Behaviour when the listener count is zero (nothing to guard against
//       -> ok=true) vs when the listener count is nonzero (all must be
//       loopback)
//     - Refusal to accept malformed input (would otherwise degrade to
//       "unknown -> ok" which is fail-open)

import fs from "node:fs";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as proxyExports from "../../../scripts/ollama-auth-proxy.mts";

type ProbeResult = { ok: boolean; listeners: Array<{ address: string; port: number }> } | null;
type ProxyExports = {
  parseProcNetTcpListeners: (
    text: string,
    port: number,
  ) => Array<{ address: string; port: number }>;
  isLoopbackProcAddress: (addr: string) => boolean;
  isLoopbackLsofAddress: (addr: string) => boolean;
  probeLinuxLoopbackBind: (port: number) => ProbeResult;
  shouldProbeBackendHostname: (hostname: string) => boolean;
  EXIT_BACKEND_NOT_LOOPBACK: number;
};
const {
  parseProcNetTcpListeners,
  isLoopbackProcAddress,
  isLoopbackLsofAddress,
  probeLinuxLoopbackBind,
  shouldProbeBackendHostname,
  EXIT_BACKEND_NOT_LOOPBACK,
} = proxyExports as ProxyExports;

// /proc/net/tcp header + one row template. Hex port 0x2CAA = 11434.
const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
function tcpRow(localAddrColonPort: string, state: string): string {
  return `   0: ${localAddrColonPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
}

// Independent fixtures (CR: do not reuse the production constants under test).
// IPv4 127.0.0.1 in /proc/net/tcp little-endian hex: bytes 7F 00 00 01 -> 0100007F.
const FIX_IPV4_LOOPBACK_1 = "0100007F";
// IPv4 127.0.0.42 -- also loopback (127.0.0.0/8) -- bytes 7F 00 00 2A -> 2A00007F.
const FIX_IPV4_LOOPBACK_42 = "2A00007F";
// IPv4 0.0.0.0 wildcard -- NOT loopback -- bytes 00 00 00 00 -> 00000000.
const FIX_IPV4_WILDCARD = "00000000";
// IPv4 10.0.0.1 -- NOT loopback -- bytes 0A 00 00 01 -> 0100000A.
const FIX_IPV4_NON_LOOPBACK = "0100000A";
// IPv6 ::1 in /proc/net/tcp6 per-group little-endian:
//   bytes 00..00 (12) + 00 00 00 01, grouped by 4 and byte-reversed inside each
//   group: 00000000 00000000 00000000 01000000.
const FIX_IPV6_LOOPBACK = "00000000000000000000000001000000";
// IPv6 ::ffff:127.0.0.1 (IPv4-mapped). Address bytes (network order):
//   00 00 00 00 00 00 00 00 00 00 FF FF 7F 00 00 01
// Grouped into four 32-bit ints, each printed %08X on native (LE) byte
// order gives numeric values 0x00000000 0x00000000 0xFFFF0000 0x0100007F,
// so the concatenated proc encoding is:
const FIX_IPV6_MAPPED_LOOPBACK_1 = "0000000000000000FFFF00000100007F";
// IPv6 ::ffff:127.0.0.9 (also loopback under 127.0.0.0/8). Last group:
// bytes 12-15 = 7F 00 00 09 -> LE u32 = 0x0900007F.
const FIX_IPV6_MAPPED_LOOPBACK_9 = "0000000000000000FFFF00000900007F";
// IPv6 ::ffff:10.0.0.1 (mapped BUT non-loopback). Last group: bytes 12-15
// = 0A 00 00 01 -> LE u32 = 0x0100000A. Exercises the negative branch of
// the IPv4-mapped IPv6 classifier.
const FIX_IPV6_MAPPED_NON_LOOPBACK = "0000000000000000FFFF00000100000A";
// IPv6 wildcard (all zeros) -- NOT loopback.
const FIX_IPV6_WILDCARD = "00000000000000000000000000000000";

describe("parseProcNetTcpListeners bind probe (#6014)", () => {
  it("returns a listener for a LISTEN state row matching the port", () => {
    const text = HEADER + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A");
    const listeners = parseProcNetTcpListeners(text, 11434);
    expect(listeners).toEqual([{ address: FIX_IPV4_LOOPBACK_1, port: 11434 }]);
  });

  it("skips rows whose state is not LISTEN (0A)", () => {
    // 01 = ESTABLISHED, 0B = CLOSING; neither should appear as a listener
    const text =
      HEADER +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "01") +
      "\n" +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0B");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("skips rows whose port does not match", () => {
    // 0x2BB7 = 11191
    const text = HEADER + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2BB7`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([]);
  });

  it("returns address uppercased so loopback comparison is canonical", () => {
    const text = HEADER + tcpRow("0100007f:2CAA", "0A");
    const [listener] = parseProcNetTcpListeners(text, 11434);
    expect(listener.address).toBe(FIX_IPV4_LOOPBACK_1);
  });

  it("ignores blank and malformed lines without throwing", () => {
    const text =
      HEADER + "\n\n" + "   garbage line\n" + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([
      { address: FIX_IPV4_LOOPBACK_1, port: 11434 },
    ]);
  });

  it("returns multiple listeners when several LISTEN rows match the port", () => {
    const text =
      HEADER +
      tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A") +
      "\n" +
      tcpRow(`${FIX_IPV4_WILDCARD}:2CAA`, "0A");
    expect(parseProcNetTcpListeners(text, 11434)).toEqual([
      { address: FIX_IPV4_LOOPBACK_1, port: 11434 },
      { address: FIX_IPV4_WILDCARD, port: 11434 },
    ]);
  });
});

describe("isLoopbackProcAddress bind probe (#6014)", () => {
  it("accepts the canonical IPv4 loopback 127.0.0.1", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_LOOPBACK_1)).toBe(true);
  });

  it("accepts every address in the 127.0.0.0/8 loopback block, not just 127.0.0.1", () => {
    // CR flagged the earlier implementation only accepted the single
    // 127.0.0.1 encoding. The full IPv4 loopback range is 127.0.0.0/8.
    expect(isLoopbackProcAddress(FIX_IPV4_LOOPBACK_42)).toBe(true);
  });

  it("accepts the canonical IPv6 loopback ::1", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_LOOPBACK)).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_MAPPED_LOOPBACK_1)).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 addresses in the 127.0.0.0/8 block", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_MAPPED_LOOPBACK_9)).toBe(true);
  });

  it("rejects IPv4 wildcard 0.0.0.0", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_WILDCARD)).toBe(false);
  });

  it("rejects a non-loopback IPv4 address (e.g. 10.0.0.1)", () => {
    expect(isLoopbackProcAddress(FIX_IPV4_NON_LOOPBACK)).toBe(false);
  });

  it("rejects an IPv6 wildcard (all zeros)", () => {
    expect(isLoopbackProcAddress(FIX_IPV6_WILDCARD)).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 to a non-loopback IPv4 (::ffff:10.0.0.1)", () => {
    // The classifier must not accept just any ::ffff:*/96 address; only
    // those whose embedded IPv4 falls in 127.0.0.0/8.
    expect(isLoopbackProcAddress(FIX_IPV6_MAPPED_NON_LOOPBACK)).toBe(false);
  });

  it("rejects malformed proc-encoded addresses of unexpected length", () => {
    // Decoder returns null for anything that is not 8 chars (IPv4) or 32
    // chars (IPv6); classifier must return false rather than throwing.
    expect(isLoopbackProcAddress("7F00")).toBe(false);
    expect(isLoopbackProcAddress("")).toBe(false);
    expect(isLoopbackProcAddress("0100007FFF")).toBe(false);
  });
});

// Helpers kept at module scope so test bodies stay linear and free of
// conditional branching (per the repository's growth guardrail on new `if`
// statements in test files).
function bindEphemeralLoopback(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: net.Server | null): Promise<void> {
  return new Promise((resolve) => {
    server === null ? resolve() : server.close(() => resolve());
  });
}

describe("probeLinuxLoopbackBind bind probe (#6014)", () => {
  let ephemeralServer: net.Server | null = null;
  let ephemeralPort = 0;

  beforeEach(async () => {
    // CR follow-up: do not assume a static port is unused. Bind an ephemeral
    // loopback listener the test controls, so the probe has a real listener
    // to observe.
    const { server, port } = await bindEphemeralLoopback();
    ephemeralServer = server;
    ephemeralPort = port;
  });

  afterEach(async () => {
    await closeServer(ephemeralServer);
    ephemeralServer = null;
  });

  it.skipIf(process.platform !== "linux")(
    "reports the ephemeral loopback server as an ok loopback listener",
    () => {
      const result = probeLinuxLoopbackBind(ephemeralPort);
      expect(result).not.toBeNull();
      const ok = result as NonNullable<typeof result>;
      expect(ok.ok).toBe(true);
      expect(ok.listeners.length).toBeGreaterThanOrEqual(1);
      expect(ok.listeners.every((l) => isLoopbackProcAddress(l.address))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reports ok: true with empty listeners once the ephemeral server is closed",
    async () => {
      await closeServer(ephemeralServer);
      ephemeralServer = null;
      const result = probeLinuxLoopbackBind(ephemeralPort);
      expect(result).not.toBeNull();
      const ok = result as NonNullable<typeof result>;
      expect(ok.ok).toBe(true);
      expect(ok.listeners).toEqual([]);
    },
  );

  it.skipIf(process.platform === "linux")(
    "returns null on non-Linux platforms so the caller falls back to lsof",
    () => {
      expect(probeLinuxLoopbackBind(ephemeralPort)).toBeNull();
    },
  );
});

describe("probeLinuxLoopbackBind tcp6 visibility degradation (#9730)", () => {
  // Hex port 0x2CAA = 11434, matching the fixtures above.
  const PORT = 11434;
  const V4_OK = HEADER + tcpRow(`${FIX_IPV4_LOOPBACK_1}:2CAA`, "0A");
  const errWithCode = (code: string) => Object.assign(new Error(code), { code });
  const readerFor = (byPath: Record<string, () => string>) => (requested: unknown) =>
    (byPath[String(requested)] ?? (() => { throw errWithCode("ENOENT"); }))();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("degrades to null when tcp6 is unreadable, so the caller falls back to lsof", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(
      readerFor({
        "/proc/net/tcp": () => V4_OK,
        "/proc/net/tcp6": () => { throw errWithCode("EACCES"); },
      }) as typeof fs.readFileSync,
    );

    // Loopback-only IPv4 data must not produce ok: true while IPv6 listeners
    // exist but are invisible; a non-loopback IPv6-only listener would pass.
    expect(probeLinuxLoopbackBind(PORT)).toBeNull();
  });

  it("classifies from IPv4 alone when tcp6 is absent on an IPv6-disabled kernel", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(
      readerFor({ "/proc/net/tcp": () => V4_OK }) as typeof fs.readFileSync,
    );

    const result = probeLinuxLoopbackBind(PORT);
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).ok).toBe(true);
  });
});

describe("isLoopbackLsofAddress bind probe (#6014)", () => {
  it("accepts a literal 127.0.0.1", () => {
    expect(isLoopbackLsofAddress("127.0.0.1")).toBe(true);
  });

  it("accepts every address in 127.0.0.0/8 (127.42.13.99, 127.255.255.255)", () => {
    expect(isLoopbackLsofAddress("127.42.13.99")).toBe(true);
    expect(isLoopbackLsofAddress("127.255.255.255")).toBe(true);
  });

  it("accepts IPv6 loopback in both bracketed and unbracketed forms", () => {
    expect(isLoopbackLsofAddress("::1")).toBe(true);
    expect(isLoopbackLsofAddress("[::1]")).toBe(true);
  });

  it("accepts the literal 'localhost'", () => {
    // Some lsof configurations resolve DNS by default; accept the token so
    // the classifier does not spuriously refuse a genuine loopback bind.
    expect(isLoopbackLsofAddress("localhost")).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 (dotted quad form) in 127.0.0.0/8", () => {
    expect(isLoopbackLsofAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackLsofAddress("::ffff:127.42.13.99")).toBe(true);
  });

  it("rejects IPv4 wildcard 0.0.0.0", () => {
    expect(isLoopbackLsofAddress("0.0.0.0")).toBe(false);
  });

  it("rejects LAN-scope IPv4 addresses", () => {
    expect(isLoopbackLsofAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackLsofAddress("192.168.1.1")).toBe(false);
  });

  it("rejects IPv6 wildcard :: and any global IPv6", () => {
    expect(isLoopbackLsofAddress("::")).toBe(false);
    expect(isLoopbackLsofAddress("2001:db8::1")).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 pointing at a non-loopback IPv4", () => {
    expect(isLoopbackLsofAddress("::ffff:10.0.0.1")).toBe(false);
  });

  it("rejects the lsof wildcard token '*'", () => {
    // lsof prints `*:11434` for a wildcard listener; the classifier must
    // refuse it (the extractor upstream feeds us the "*" string).
    expect(isLoopbackLsofAddress("*")).toBe(false);
  });
});

describe("public surface bind probe (#6014)", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "[::1]",
    "::ffff:127.0.0.9",
  ])("probes the local backend hostname %s", (hostname) => {
    expect(shouldProbeBackendHostname(hostname)).toBe(true);
  });

  it.each([
    "10.0.0.1",
    "192.168.1.9",
    "ollama.example.com",
    "2001:db8::1",
  ])("skips the remote backend hostname %s", (hostname) => {
    expect(shouldProbeBackendHostname(hostname)).toBe(false);
  });

  it("exports EXIT_BACKEND_NOT_LOOPBACK as 2 (locked-in contract with the host CLI)", () => {
    // The host (src/lib/inference/ollama/proxy.ts) maps this code to a
    // specific remediation. Changing it would break the structured signal.
    expect(EXIT_BACKEND_NOT_LOOPBACK).toBe(2);
  });
});
