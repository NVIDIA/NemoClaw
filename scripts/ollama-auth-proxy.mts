#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticated reverse proxy for Ollama.
 *
 * Ollama has no built-in authentication. This proxy sits in front of it,
 * validating a Bearer token before forwarding requests. Ollama binds to
 * 127.0.0.1 (localhost only) while the proxy listens on 0.0.0.0 so the
 * OpenShell gateway (running in a container) can reach it.
 *
 * Env:
 *   OLLAMA_PROXY_TOKEN  — required, the Bearer token to validate
 *   OLLAMA_PROXY_PORT   — listen port (default: 11435)
 *   OLLAMA_BACKEND_PORT — Ollama port on localhost (default: 11434)
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

type BackendListener = { address: string; port: number };
type BackendProbeResult = {
  ok: boolean;
  listeners: BackendListener[];
  nonLoopback?: BackendListener[];
};

/**
 * Best-effort write of a structured exit reason for the host CLI to read
 * when proxy startup fails. The host (src/lib/inference/ollama/proxy.ts)
 * renders specific remediation messages based on `reason`.
 */
function writeExitStatus(reason: string, details?: string): void {
  const statusFile = process.env.NEMOCLAW_OLLAMA_PROXY_STATUS_FILE;
  if (!statusFile) return;
  try {
    const payload = JSON.stringify({
      reason,
      details: details || undefined,
      exitedAt: Math.floor(Date.now() / 1000),
    });
    fs.writeFileSync(statusFile, payload);
  } catch {
    // Status file is best-effort; the proxy still exits with the right code
    // so the host's port-conflict fall-back path can render a generic
    // remediation. Don't crash the proxy because we couldn't write a hint.
  }
}

function clearExitStatus() {
  const statusFile = process.env.NEMOCLAW_OLLAMA_PROXY_STATUS_FILE;
  if (!statusFile) return;
  try {
    fs.unlinkSync(statusFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      // Same as writeExitStatus: don't crash, this is hint metadata.
    }
  }
}

// Exit code 2 is reserved for "backend listening on a non-loopback interface"
// so the host-side startOllamaAuthProxy() can render an Ollama-specific
// remediation pointing the operator at OLLAMA_HOST=127.0.0.1.
const EXIT_BACKEND_NOT_LOOPBACK = 2;

// Reference encoding for the exact `127.0.0.1` IPv4 address in
// /proc/net/tcp: bytes 7F 00 00 01, little-endian per column ->
// hex "0100007F". IPv4 loopback is the full 127.0.0.0/8 block though, so
// the classifier below matches on the leading (post-reverse) byte being
// 7F instead of an exact string match. This constant is kept as an
// unambiguous fixture for tests and callers that want to compare against a
// specific example rather than a range.
const IPV4_LOOPBACK_PROC = "0100007F";
// IPv6 loopback (::1) in /proc/net/tcp6 encoding. The 16-byte address is
// split into four 32-bit groups; each group's four bytes are emitted in
// little-endian order. ::1 bytes = 00..00 00..01 -> groups reversed become
// 00000000:00000000:00000000:01000000, concatenated.
const IPV6_LOOPBACK_PROC = "00000000000000000000000001000000";
// IPv4-mapped IPv6 loopback (::ffff:127.0.0.1). Address bytes (network
// order):
//   00 00 00 00 00 00 00 00 00 00 FF FF 7F 00 00 01
// The kernel groups these into four 32-bit ints and prints each with %08X in
// native (little-endian) byte order, so each group's numeric u32 value is:
//   int[0] = 0x00000000  int[1] = 0x00000000
//   int[2] = 0xFFFF0000  (bytes 8-11 = 00 00 FF FF little-endian -> u32)
//   int[3] = 0x0100007F  (bytes 12-15 = 7F 00 00 01 little-endian -> u32)
// %08X of each: 00000000 00000000 FFFF0000 0100007F -> concatenated:
//   0000000000000000FFFF00000100007F
// The correctness of this constant is enforced end-to-end by the
// isLoopbackProcAddress test suite, which independently decodes the bytes
// via decodeProcAddress and checks the semantic loopback shape, rather
// than string-comparing against this constant.
const IPV6_MAPPED_IPV4_LOOPBACK_PROC = "0000000000000000FFFF00000100007F";

/**
 * Parse a /proc/net/tcp{,6} table and return every LISTEN socket whose local
 * port matches `port`. Each returned entry is `{address, port}` where
 * address is the proc-encoded local address column (uppercased, no `:port`).
 *
 * /proc/net/tcp{,6} state column 0x0A = LISTEN.
 */
function parseProcNetTcpListeners(text: string, port: number): BackendListener[] {
  const listeners: BackendListener[] = [];
  const lines = text.split("\n");
  // Skip header line.
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    // cols[1] = local_address:port, cols[3] = state.
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== "0A") continue;
    const sep = local.lastIndexOf(":");
    if (sep <= 0) continue;
    const addr = local.slice(0, sep).toUpperCase();
    const sockPort = parseInt(local.slice(sep + 1), 16);
    if (sockPort === port) listeners.push({ address: addr, port: sockPort });
  }
  return listeners;
}

/**
 * Decode a /proc/net/tcp{,6} local_address hex column into the address bytes
 * in canonical IP byte order (network order: high byte first, the same order
 * `inet_pton` / `getnameinfo` produce). The kernel formats each 32-bit
 * group with `%08X` on the native (little-endian) u32, so within each 8-hex
 * character group the bytes are emitted in reverse of network order. We undo
 * that here by walking each group in reverse-byte order.
 *
 * Returns a 4-byte array for IPv4 (8 hex chars), a 16-byte array for IPv6
 * (32 hex chars), or null if the input has any other length. Robust against
 * upstream-hex-encoding subtleties so the loopback classifier below can
 * reason about actual address bytes instead of hex string patterns.
 */
function decodeProcAddress(addr: string): number[] | null {
  const expectedGroups = addr.length === 8 ? 1 : addr.length === 32 ? 4 : 0;
  if (expectedGroups === 0) return null;
  const bytes = [];
  for (let g = 0; g < expectedGroups; g++) {
    const group = addr.slice(g * 8, (g + 1) * 8);
    // Each group is 4 bytes emitted little-endian in the hex; walk in
    // reverse to recover network byte order.
    for (let b = 3; b >= 0; b--) {
      bytes.push(parseInt(group.slice(b * 2, b * 2 + 2), 16));
    }
  }
  return bytes;
}

/**
 * Classify a decoded address as loopback. Handles three concrete cases:
 *   - IPv4: first byte 0x7F (127.0.0.0/8)
 *   - IPv6 canonical loopback: 15 zero bytes then 0x01 (::1)
 *   - IPv4-mapped IPv6 loopback: 10 zero bytes, then 0xFF 0xFF, then any
 *     127.x.y.z (byte 12 == 0x7F). Covers ::ffff:127.0.0.0/104.
 * Returns false for any input the decoder produced that does not match one
 * of these shapes.
 */
function isLoopbackProcAddress(addr: string): boolean {
  const bytes = decodeProcAddress(addr);
  if (bytes === null) return false;
  if (bytes.length === 4) return bytes[0] === 0x7f;
  if (bytes.length !== 16) return false;
  const allZero = (arr: number[], from: number, to: number): boolean =>
    arr.slice(from, to).every((b) => b === 0);
  // ::1 -> all-zero prefix, last byte 0x01
  if (allZero(bytes, 0, 15) && bytes[15] === 0x01) return true;
  // ::ffff:127.x.y.z -> 10 zeros, 0xFF 0xFF, then 127-prefixed IPv4
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes[12] === 0x7f;
  }
  return false;
}

/**
 * Linux backend-bind probe via /proc/net/tcp + /proc/net/tcp6. Returns
 * { ok: true } when every listener on BACKEND_PORT is loopback,
 * { ok: false, listeners } when at least one is not, and null when /proc
 * is unavailable so the caller can fall back to the cross-platform probe.
 */
function probeLinuxLoopbackBind(port: number): BackendProbeResult | null {
  let v4Text = "";
  let v6Text = "";
  try {
    v4Text = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch (err) {
    // Any read failure (EACCES on some containers, EPERM under strict
    // sandboxes, or the absent-file case) degrades to null so the caller
    // falls back to `lsof` rather than crashing the proxy.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      return null;
    }
    return null;
  }
  try {
    v6Text = fs.readFileSync("/proc/net/tcp6", "utf8");
  } catch (err) {
    // tcp6 absent (ENOENT) means the kernel runs without IPv6, so there are
    // no IPv6 listeners to classify; the IPv4 data alone is complete.
    // Any other failure (EACCES / EPERM) means IPv6 listeners exist but are
    // not visible here, and passing on IPv4 data alone would let a
    // non-loopback IPv6-only listener through. Degrade to null so the
    // caller falls back to `lsof`, which sees both address families.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      return null;
    }
  }
  const listeners = [
    ...parseProcNetTcpListeners(v4Text, port),
    ...parseProcNetTcpListeners(v6Text, port),
  ];
  if (listeners.length === 0) return { ok: true, listeners };
  const nonLoopback = listeners.filter((l) => !isLoopbackProcAddress(l.address));
  return { ok: nonLoopback.length === 0, listeners, nonLoopback };
}

/**
 * Cross-platform fallback using `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
 * Returns { ok, listeners } in the same shape as the Linux probe, or null
 * when lsof is unavailable so the caller can render a degraded warning.
 */
/**
 * Classify a human-readable IP address string (as printed by `lsof -F n`)
 * as loopback. Handles the same three semantic cases as
 * `isLoopbackProcAddress`, but on the cross-platform lsof-style form so the
 * IPv4 accept range matches on both probes: any 127.x.y.z (127.0.0.0/8),
 * ::1, and ::ffff:127.0.0.0/104. Advisor PRA-4 (Ultra) flagged the earlier
 * exact-match against "127.0.0.1" as an incomplete classifier that would
 * refuse legitimate loopback binds and, worse, mask a genuine non-loopback
 * mistake as "not-loopback" on the fallback path.
 */
function isLoopbackLsofAddress(addr: string): boolean {
  if (addr === "localhost") return true;
  // IPv4 dotted quad, or IPv4-mapped IPv6 written as "::ffff:x.y.z.w" or
  // "[::ffff:x.y.z.w]" or a bracketed IPv6 wrapper on the same. Any of
  // these forms are loopback iff the leading IPv4 byte is 127.
  const ipv4Match = addr.match(/^\[?(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\]?$/i);
  if (ipv4Match !== null) return parseInt(ipv4Match[1], 10) === 127;
  // IPv6 canonical loopback.
  if (addr === "::1" || addr === "[::1]") return true;
  // IPv4-mapped IPv6 in colon-hex form (rare from lsof, but be robust).
  const mappedHex = addr.match(/^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/i);
  if (mappedHex !== null) {
    // The last 32 bits of the mapped IPv6 are the IPv4 address bytes.
    // The first hex group holds the high 16 bits (bytes 12-13), second
    // holds the low 16 bits (bytes 14-15). For 127.0.0.0/8 the top byte
    // (byte 12) is 0x7F, which is the high byte of the first hex group.
    const hi = parseInt(mappedHex[1], 16);
    return hi >>> 8 === 0x7f;
  }
  return false;
}

function probeLsofLoopbackBind(port: number): BackendProbeResult | null {
  let stdout: string;
  try {
    stdout = execFileSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-F", "n"], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch (err) {
    const processError = err as (NodeJS.ErrnoException & { status?: number }) | undefined;
    if (processError?.code === "ENOENT" || processError?.status === 1) return null;
    return null;
  }
  const listeners = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.startsWith("n")) continue;
    // lsof -F n field looks like `n*:11434` or `n127.0.0.1:11434` or
    // `n[::1]:11434`. Extract the address up to the final ':<port>'.
    const body = raw.slice(1);
    const sep = body.lastIndexOf(":");
    if (sep <= 0) continue;
    const addr = body.slice(0, sep);
    listeners.push({ address: addr, port });
  }
  if (listeners.length === 0) return { ok: true, listeners };
  const nonLoopback = listeners.filter((l) => !isLoopbackLsofAddress(l.address));
  return { ok: nonLoopback.length === 0, listeners, nonLoopback };
}

function assertBackendBoundToLoopback(port: number): void {
  if (process.env.NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE === "1") {
    // PRA-5 audit trail: the operator override that disables the
    // loopback probe MUST leave a durable record in the proxy's stderr so
    // an incident investigator scanning proxy logs can see that
    // enforcement was skipped, when, and via which knob. This is not a
    // fail-closed decision (the operator explicitly asked for the
    // override), but it must not be silent.
    console.warn(
      `Ollama auth proxy: SECURITY PROBE SKIPPED. ` +
        `NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE=1 disabled the loopback ` +
        `bind check for port ${port}. Any Ollama daemon on this host ` +
        `reachable on a non-loopback interface will bypass the proxy's ` +
        `token check. Unset the env to restore enforcement.`,
    );
    return;
  }
  let result = process.platform === "linux" ? probeLinuxLoopbackBind(port) : null;
  if (result === null) {
    result = probeLsofLoopbackBind(port);
  }
  if (result === null) {
    // Probe is unavailable on this host (no /proc, no lsof). Don't fail
    // closed — the proxy is still useful — but log so an operator scanning
    // logs can see the boundary check did not run. The systemd drop-in
    // (Linux only) remains the primary enforcement on Linux; non-Linux
    // topologies still rely on the operator-supplied bind today (#6014).
    console.warn(
      `Ollama auth proxy: backend-bind probe unavailable, ` +
        `unable to verify Ollama is bound to loopback on port ${port}`,
    );
    return;
  }
  if (result.ok) return;
  const labels = (result.nonLoopback || result.listeners || [])
    .map((l) => `${l.address}:${l.port}`)
    .join(", ");
  // This stderr is not the user-facing message: the host spawns the proxy with
  // stdio "ignore" and renders remediation from the status reason below, which
  // knows whether the backend is Ollama or a compatible endpoint (#9730). Keep
  // user-facing wording in that renderer, not here.
  console.error(
    `Ollama auth proxy: backend on port ${port} is NOT bound to loopback ` +
      `(found ${labels || "non-loopback listener"}). ` +
      `Refusing to start: an Ollama daemon reachable on a non-loopback ` +
      `interface bypasses the proxy's token check entirely. ` +
      `Set OLLAMA_HOST=127.0.0.1:${port} on the Ollama systemd unit or ` +
      `set NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE=1 to override (not recommended).`,
  );
  writeExitStatus("backend-not-loopback", labels || "non-loopback listener");
  process.exit(EXIT_BACKEND_NOT_LOOPBACK);
}

function buildProxyServer(token: string, backendUrl: URL): http.Server {
  const expectedBuf = Buffer.from(`Bearer ${token}`);
  return http.createServer((clientReq, clientRes) => {
    // Every request must present a valid Bearer token. The proxy binds 0.0.0.0
    // so the OpenShell sandbox container can reach it via the docker bridge —
    // which also means anything else with network reach to the host could,
    // so unauthenticated requests are uniformly rejected (no health-check
    // bypass for /api/tags). DevTest T5987914: "calls without
    // Authorization: Bearer TOKEN should NOT return 200." See #3338.
    // Compare buffers, not JS strings: a non-ASCII Authorization header
    // can have the same .length as the expected string but a different byte
    // length, which would make crypto.timingSafeEqual throw and crash the
    // proxy (it binds 0.0.0.0). Build buffers first, gate timingSafeEqual on
    // matching byte length.
    const auth = clientReq.headers.authorization;
    const authBuf = typeof auth === "string" ? Buffer.from(auth) : null;
    const tokenMatch =
      authBuf !== null &&
      authBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(authBuf, expectedBuf);
    if (!tokenMatch) {
      clientRes.writeHead(401, { "Content-Type": "text/plain" });
      clientRes.end("Unauthorized");
      return;
    }

    // Strip the auth header before forwarding to Ollama
    const headers = { ...clientReq.headers };
    delete headers.authorization;
    delete headers.host;

    const handleBackendError = (err: Error): void => {
      if (clientRes.destroyed || clientRes.writableEnded) return;
      if (clientRes.headersSent) {
        clientRes.destroy();
        return;
      }
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end(`Backend error: ${err.message}`);
    };

    const proxyReq = http.request(
      {
        hostname: backendUrl.hostname,
        port: backendUrl.port,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (proxyRes: http.IncomingMessage) => {
        proxyRes.once("error", handleBackendError);
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );

    const destroyUpstream = (): void => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    };
    clientReq.once("aborted", destroyUpstream);
    clientRes.once("close", () => {
      if (!clientRes.writableFinished) destroyUpstream();
    });
    proxyReq.once("error", handleBackendError);

    clientReq.pipe(proxyReq);
  });
}

function shouldProbeBackendHostname(hostname: string): boolean {
  return isLoopbackLsofAddress(hostname);
}

function main(): void {
  const TOKEN = process.env.OLLAMA_PROXY_TOKEN;
  if (!TOKEN) {
    console.error("OLLAMA_PROXY_TOKEN required");
    process.exit(1);
  }

  const LISTEN_PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11435", 10);
  const BACKEND_PORT = parseInt(process.env.OLLAMA_BACKEND_PORT || "11434", 10);

  const BACKEND_URL = new URL(process.env.OLLAMA_BACKEND_URL || `http://127.0.0.1:${BACKEND_PORT}`);
  // A non-local backend is explicitly selected by the persisted adapter
  // configuration. The bind probe applies only to a local Ollama port.
  if (shouldProbeBackendHostname(BACKEND_URL.hostname)) {
    const backendPort = Number(BACKEND_URL.port || (BACKEND_URL.protocol === "https:" ? 443 : 80));
    assertBackendBoundToLoopback(backendPort);
  }

  const server = buildProxyServer(TOKEN, BACKEND_URL);

  // The proxy binds 0.0.0.0, so an unhandled listen error (most commonly
  // EADDRINUSE when the port is already taken) would crash with an uncaught
  // exception. Exit cleanly with a non-zero code instead; the host-side
  // startOllamaAuthProxy() detects the missing process and reports the port
  // owner with remediation. See #4820.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`Ollama auth proxy: port ${LISTEN_PORT} is already in use`);
      writeExitStatus("listen-port-conflict", `port ${LISTEN_PORT} in use`);
    } else {
      const msg = err && err.message ? err.message : String(err);
      console.error(`Ollama auth proxy failed to start: ${msg}`);
      writeExitStatus("listen-error", msg);
    }
    process.exit(1);
  });

  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    // The proxy is healthy; clear any stale exit status so a later failed
    // restart's status file is not misread as the current proxy's failure.
    clearExitStatus();
    console.log(`Ollama auth proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${BACKEND_URL.origin}`);
  });
}

if (import.meta.main) {
  main();
}

export {
  clearExitStatus,
  decodeProcAddress,
  EXIT_BACKEND_NOT_LOOPBACK,
  IPV4_LOOPBACK_PROC,
  IPV6_LOOPBACK_PROC,
  IPV6_MAPPED_IPV4_LOOPBACK_PROC,
  isLoopbackLsofAddress,
  isLoopbackProcAddress,
  parseProcNetTcpListeners,
  probeLinuxLoopbackBind,
  probeLsofLoopbackBind,
  shouldProbeBackendHostname,
  writeExitStatus,
};
