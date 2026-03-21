// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { checkPortAvailable } = require("../bin/lib/preflight");

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
    assert.equal(probedPort, 18789);
    assert.deepEqual(result, { ok: true });
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
    assert.equal(result.ok, false);
    assert.equal(result.process, "unknown");
    assert.ok(result.reason.includes("EADDRINUSE"));
  });

  it("parses process and PID from lsof output", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "openclaw  12345   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });
    assert.equal(result.ok, false);
    assert.equal(result.process, "openclaw");
    assert.equal(result.pid, 12345);
    assert.ok(result.reason.includes("openclaw"));
  });

  it("picks first listener when lsof shows multiple", async () => {
    const lsofOutput = [
      "COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "gateway   111   root    7u  IPv4  54321      0t0  TCP *:18789 (LISTEN)",
      "node      222   root    8u  IPv4  54322      0t0  TCP *:18789 (LISTEN)",
    ].join("\n");
    const result = await checkPortAvailable(18789, { lsofOutput });
    assert.equal(result.ok, false);
    assert.equal(result.process, "gateway");
    assert.equal(result.pid, 111);
  });

  it("returns ok for a free port probe", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({ ok: true }),
    });
    assert.deepEqual(result, { ok: true });
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
    assert.equal(result.ok, false);
    assert.equal(result.process, "unknown");
    assert.ok(result.reason.includes("EADDRINUSE"));
  });

  it("treats restricted probe environments as inconclusive instead of occupied", async () => {
    const result = await checkPortAvailable(8080, {
      skipLsof: true,
      probeImpl: async () => ({
        ok: true,
        warning: "port probe skipped: listen EPERM: operation not permitted 127.0.0.1",
      }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.warning.includes("EPERM"));
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
    assert.equal(probedPort, 18789);
    assert.equal(result.ok, true);
  });
});
