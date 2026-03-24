// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { checkPortAvailable } from "../bin/lib/preflight";

describe("checkPortAvailable", () => {
  it("falls through to the probe when lsof output is empty", async () => {
    let probedPort = null;
    const result = await checkPortAvailable(18789, {
      lsofOutput: "",
      probeImpl: async (port) => {
        probedPort = port;
        return { ok: true };
      },
    });

    expect(probedPort).toBe(18789);
    expect(result).toEqual({ ok: true });
  });

  it("probe catches occupied port even when lsof returns empty", async () => {
    const result = await checkPortAvailable(18789, {
      lsofOutput: "",
      probeImpl: async () => ({
        ok: false,
        process: "unknown",
        pid: null,
        reason: "port 18789 is in use (EADDRINUSE)",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("unknown");
    expect(result.reason).toContain("EADDRINUSE");
  });

  it("parses process and PID from lsof output", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "openclaw  12345   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("openclaw");
    expect(result.pid).toBe(12345);
    expect(result.reason).toContain("openclaw");
  });

  it("picks first listener when lsof shows multiple", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "gateway   111   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
      "node      222   root    8u  IPv4  54322      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("gateway");
    expect(result.pid).toBe(111);
  });

  it("returns ok for a free port probe", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns occupied for EADDRINUSE probe results", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({
        ok: false,
        process: "unknown",
        pid: null,
        reason: "port 8080 is in use (EADDRINUSE)",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.process).toBe("unknown");
    expect(result.reason).toContain("EADDRINUSE");
  });

  it("treats restricted probe environments as inconclusive instead of occupied", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({
        ok: true,
        warning: "port probe skipped: listen EPERM: operation not permitted 127.0.0.1",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toContain("EPERM");
  });

  it("defaults to port 18789 when no port is given", async () => {
    let probedPort = null;
    const result = await checkPortAvailable(undefined, {
      skipLsof: true,
      probeImpl: async (port) => {
        probedPort = port;
        return { ok: true };
      },
    });

    expect(probedPort).toBe(18789);
    expect(result.ok).toBe(true);
  });
});
