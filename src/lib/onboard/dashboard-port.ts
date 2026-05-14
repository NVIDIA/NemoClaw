// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard-port allocation for the OpenShell sandbox.
 *
 * The allocator runs at sandbox-create time and bakes the chosen port into
 * the sandbox's Dockerfile ARG + NEMOCLAW_DASHBOARD_PORT env. If the port
 * later turns out to be unavailable, the sandbox has to be torn down and
 * re-created, so the allocator needs to be aggressive about detecting
 * already-bound host ports — `lsof` alone misses root-owned listeners on
 * macOS (docker-proxy) and TOCTOU windows where another listener binds
 * mid-build. See #3260 and #2174.
 */

import { spawnSync } from "node:child_process";

import { DASHBOARD_PORT_RANGE_END, DASHBOARD_PORT_RANGE_START } from "../core/ports";

// runner.ts is still CommonJS — use require so module shape matches.
const { runCapture } = require("../runner");
type RunCaptureFn = typeof import("../runner").runCapture;

// Match the broader pattern used by onboard.ts (covers CSI, OSC, and Fe escapes)
// so colorised `openshell forward list` output parses correctly.
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

/** OpenShell forward statuses that hold a port (and therefore block reuse). */
export function isLiveForwardStatus(status: string): boolean {
  return status === "running" || status === "active";
}

/**
 * Parse `openshell forward list` output into a Map<port, sandboxName>.
 * Only includes running forwards — stopped/stale entries are ignored so
 * they don't block port allocation or cause false "range exhausted" errors.
 *
 * ANSI escape codes (the openshell CLI colourises status columns when
 * stdout is a TTY) are stripped per-line before tokenising so port numbers
 * and status words are matched cleanly.
 *
 * Output format (columns separated by whitespace):
 *   SANDBOX  BIND  PORT  PID  STATUS
 */
export function getOccupiedPorts(forwardListOutput: string | null): Map<string, string> {
  const occupied = new Map<string, string>();
  if (!forwardListOutput) return occupied;
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // parts: [sandbox, bind, port, pid, status...]
    if (parts.length < 3 || !/^\d+$/.test(parts[2])) continue;
    const status = (parts[4] || "").toLowerCase();
    if (!isLiveForwardStatus(status)) continue;
    occupied.set(parts[2], parts[0]);
  }
  return occupied;
}

/**
 * Synchronous Node `net` bind probe — tries to listen on the port and
 * reports whether the bind would have failed with EADDRINUSE. Spawned via
 * spawnSync of `node -e` because `findAvailableDashboardPort` runs deep in
 * a sync allocation flow and `net.createServer().listen()` is async.
 *
 * Exit codes: 0 = bind succeeded (port free); 1 = EADDRINUSE; anything
 * else = inconclusive (treated as free for safety — the forward-start
 * check is authoritative).
 */
export function probePortBoundSync(port: number): boolean {
  try {
    const script =
      "const net = require('node:net');" +
      "const srv = net.createServer();" +
      "let done = false;" +
      "const exit = (code) => { if (!done) { done = true; process.exit(code); } };" +
      "srv.once('error', (e) => exit(e && e.code === 'EADDRINUSE' ? 1 : 2));" +
      `srv.listen(${port}, '127.0.0.1', () => srv.close(() => exit(0)));`;
    const result = spawnSync(process.execPath, ["-e", script], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return result.status === 1;
  } catch {
    return false;
  }
}

/**
 * Synchronous check whether a TCP port has an active listener on the host.
 *
 * Detection chain — any positive signal short-circuits:
 *   1. `lsof` — finds listeners owned by the current user.
 *   2. `sudo -n lsof` — catches root-owned listeners (e.g., docker-proxy on
 *      macOS) that the unprivileged lsof can't see. Silently no-ops when
 *      the user can't escalate non-interactively.
 *   3. Node `net` bind probe — authoritative fallback when both lsof
 *      invocations come up empty, mirroring what `openshell forward start`
 *      will actually attempt.
 *
 * Returns false (optimistic) when every probe is inconclusive — the
 * downstream forward-start check is the final authority (#3260).
 */
export function isPortBoundOnHost(port: number): boolean {
  try {
    const out: ReturnType<RunCaptureFn> = runCapture(
      ["lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { ignoreError: true },
    );
    if (out && out.trim().length > 0) return true;
  } catch {
    /* fall through to the next probe */
  }

  try {
    const sudoOut: ReturnType<RunCaptureFn> = runCapture(
      ["sudo", "-n", "lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { ignoreError: true },
    );
    if (sudoOut && sudoOut.trim().length > 0) return true;
  } catch {
    /* fall through to the bind probe */
  }

  return probePortBoundSync(port);
}

/**
 * Find the next available dashboard port for the given sandbox.
 * Returns the preferred port if free or already owned by this sandbox,
 * otherwise scans DASHBOARD_PORT_RANGE_START..END for a free port.
 * Validates host-port availability (via the proactive probe chain in
 * isPortBoundOnHost) so ports bound by non-OpenShell processes are
 * skipped (#3260).
 * Throws if the entire range is exhausted.
 *
 * `isPortBoundCheck` is an injectable seam for tests so they don't have
 * to spawn real lsof / Node probes; production callers leave it at the
 * default.
 */
export function findAvailableDashboardPort(
  sandboxName: string,
  preferredPort: number,
  forwardListOutput: string | null,
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
): number {
  const occupied = getOccupiedPorts(forwardListOutput);
  const hostBoundPorts: number[] = [];
  // Try the preferred port first (it may be outside the dashboard range when
  // a caller passes --control-ui-port), then the rest of the range. Each port
  // is probed at most once so we don't pay for `lsof` + `sudo lsof` + Node
  // bind multiple times per port.
  const portsToScan = [
    preferredPort,
    ...Array.from(
      { length: DASHBOARD_PORT_RANGE_END - DASHBOARD_PORT_RANGE_START + 1 },
      (_, i) => DASHBOARD_PORT_RANGE_START + i,
    ).filter((p) => p !== preferredPort),
  ];
  for (const p of portsToScan) {
    const pStr = String(p);
    const pOwner = occupied.get(pStr) ?? null;
    if (pOwner === sandboxName) return p;
    if (pOwner === null) {
      if (!isPortBoundCheck(p)) return p;
      hostBoundPorts.push(p);
    }
  }

  const ownerLines = [...occupied.entries()]
    .filter(
      ([p]) => Number(p) >= DASHBOARD_PORT_RANGE_START && Number(p) <= DASHBOARD_PORT_RANGE_END,
    )
    .map(([p, s]) => `  ${p} → ${s}`);
  const hostLines = hostBoundPorts
    .filter((p) => p >= DASHBOARD_PORT_RANGE_START && p <= DASHBOARD_PORT_RANGE_END)
    .map((p) => `  ${p} → non-OpenShell host listener`);
  const lines = [...ownerLines, ...hostLines].join("\n");
  throw new Error(
    `All dashboard ports in range ${DASHBOARD_PORT_RANGE_START}-${DASHBOARD_PORT_RANGE_END} are occupied:\n${lines}\n` +
      `Free a sandbox or use --control-ui-port <N> with a port outside this range.`,
  );
}
