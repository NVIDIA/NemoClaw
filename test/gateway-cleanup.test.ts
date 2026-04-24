// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that gateway cleanup includes Docker volume removal in all
// failure paths. Without this, failed gateway starts leave corrupted
// volumes (openshell-cluster-*) that break subsequent onboard runs.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/17

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("gateway cleanup: Docker volumes removed on failure (#17)", () => {
  it("onboard.js: destroyGateway() removes Docker volumes", () => {
    const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");
    expect(content.includes("docker volume") && content.includes("openshell-cluster")).toBe(true);
  });

  it("onboard.js: volume cleanup runs on gateway start failure", () => {
    const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");
    const startGwBlock = content.match(/async function startGatewayWithOptions[\s\S]*?^}/m);
    expect(startGwBlock).toBeTruthy();
    if (!startGwBlock) {
      throw new Error("Expected startGatewayWithOptions() in src/lib/onboard.ts");
    }

    // Current behavior:
    // 1. stale gateway is detected but NOT destroyed upfront — gateway start
    //    can recover the container without wiping metadata/certs
    // 2. destroyGateway() runs inside the retry loop only on genuine failure
    expect(startGwBlock[0].includes("if (hasStaleGateway(gwInfo))")).toBe(true);
    expect(startGwBlock[0]).toContain("destroyGateway()");
  });

  it("uninstall.sh: includes Docker volume cleanup", () => {
    const content = fs.readFileSync(path.join(ROOT, "uninstall.sh"), "utf-8");
    expect(content.includes("docker volume") && content.includes("openshell-cluster")).toBe(true);
    expect(content.includes("remove_related_docker_volumes")).toBe(true);
  });
});
