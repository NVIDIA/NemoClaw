// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isCgroupV2, readDaemonJson, checkCgroupConfig } = require("../bin/lib/preflight");

// Helper: create a temp daemon.json with given content and return its path.
function writeTempDaemon(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preflight-"));
  const p = path.join(dir, "daemon.json");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("isCgroupV2", () => {
  it("returns a boolean", () => {
    assert.equal(typeof isCgroupV2(), "boolean");
  });

  it("returns false on non-linux platforms", () => {
    // On Linux this still returns a boolean (true or false depending on
    // actual cgroup version). On macOS/other it always returns false.
    // Either way the function must not throw.
    const result = isCgroupV2();
    if (process.platform !== "linux") {
      assert.equal(result, false);
    }
  });
});

describe("readDaemonJson", () => {
  it("parses valid JSON", () => {
    const p = writeTempDaemon('{ "default-cgroupns-mode": "host" }');
    const result = readDaemonJson(p);
    assert.deepEqual(result, { "default-cgroupns-mode": "host" });
  });

  it("returns null for invalid JSON", () => {
    const p = writeTempDaemon("not json at all");
    assert.equal(readDaemonJson(p), null);
  });

  it("returns null for missing file", () => {
    assert.equal(readDaemonJson("/tmp/nonexistent-daemon-" + Date.now() + ".json"), null);
  });
});

describe("checkCgroupConfig", () => {
  it("runs without arguments (uses live detection)", () => {
    const result = checkCgroupConfig();
    assert.equal(typeof result.ok, "boolean");
  });

  it("returns ok when cgroup v1 (skips daemon.json check)", () => {
    const result = checkCgroupConfig({ cgroupV2: false });
    assert.deepEqual(result, { ok: true });
  });

  it("returns ok when cgroup v2 and daemon.json has cgroupns=host", () => {
    const p = writeTempDaemon('{ "default-cgroupns-mode": "host" }');
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.deepEqual(result, { ok: true });
  });

  it("fails when cgroup v2 and daemon.json missing", () => {
    const p = "/tmp/nonexistent-daemon-" + Date.now() + ".json";
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("does not exist"));
  });

  it("fails when cgroup v2 and daemon.json has no cgroupns key", () => {
    const p = writeTempDaemon('{ "storage-driver": "overlay2" }');
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("not set to"));
  });

  it("fails when cgroup v2 and cgroupns mode is wrong value", () => {
    const p = writeTempDaemon('{ "default-cgroupns-mode": "private" }');
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("not set to"));
  });

  it("fails when cgroup v2 and daemon.json is invalid JSON", () => {
    const p = writeTempDaemon("oops");
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("not valid JSON"));
  });

  it("passes with extra keys alongside cgroupns=host", () => {
    const p = writeTempDaemon(JSON.stringify({
      "storage-driver": "overlay2",
      "default-cgroupns-mode": "host",
      "log-driver": "json-file",
    }));
    const result = checkCgroupConfig({ cgroupV2: true, daemonPath: p });
    assert.deepEqual(result, { ok: true });
  });
});
