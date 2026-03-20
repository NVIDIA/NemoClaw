// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that gateway cleanup includes Docker volume removal in all
// failure paths. Without this, failed gateway starts leave corrupted
// volumes (openshell-cluster-*) that break subsequent onboard runs.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/17

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

describe("gateway cleanup: Docker volumes removed on failure (#17)", () => {
  it("onboard.js: destroyGateway() removes Docker volumes", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/lib/onboard.js"), "utf-8");
    assert.ok(
      content.includes("docker volume") && content.includes("openshell-cluster"),
      "onboard.js must contain Docker volume cleanup for openshell-cluster volumes"
    );
  });

  it("onboard.js: volume cleanup runs on gateway start failure", () => {
    const content = fs.readFileSync(path.join(ROOT, "bin/lib/onboard.js"), "utf-8");
    // The startGateway function should call destroyGateway after a failed start
    const startGwBlock = content.match(/async function startGateway[\s\S]*?^}/m);
    assert.ok(startGwBlock, "Could not find startGateway function");

    // Count calls to destroyGateway — should be at least 3:
    // 1. pre-cleanup before start
    // 2. after start failure
    // 3. after health check failure
    const calls = (startGwBlock[0].match(/destroyGateway\(\)/g) || []).length;
    assert.ok(
      calls >= 3,
      `startGateway must call destroyGateway() at least 3 times (pre-start, start failure, health failure), found ${calls}`
    );
  });

  it("uninstall.sh: includes Docker volume cleanup", () => {
    const content = fs.readFileSync(path.join(ROOT, "uninstall.sh"), "utf-8");
    assert.ok(
      content.includes("docker volume") && content.includes("openshell-cluster"),
      "uninstall.sh must remove openshell-cluster Docker volumes"
    );
    assert.ok(
      content.includes("remove_related_docker_volumes"),
      "uninstall.sh must define and call remove_related_docker_volumes()"
    );
  });

  it("setup.sh: includes Docker volume cleanup on failure", () => {
    const content = fs.readFileSync(path.join(ROOT, "scripts/setup.sh"), "utf-8");
    assert.ok(
      content.includes("docker volume") && content.includes("openshell-cluster"),
      "setup.sh must remove openshell-cluster Docker volumes on failure"
    );
  });
});
