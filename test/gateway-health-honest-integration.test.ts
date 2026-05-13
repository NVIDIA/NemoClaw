// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Source-shape guards for the #3111 fix in startDockerDriverGateway.
//
// The fix gates the "Docker-driver gateway is healthy" log on:
//   1. a real TCP liveness probe (isGatewayTcpReady from
//      src/lib/onboard/gateway-tcp-readiness.ts) — plain TCP, not HTTP,
//      because the Docker-driver gateway and the K3s gateway expose
//      different root paths (see gateway-http-readiness for the K3s path
//      and the docstring of gateway-tcp-readiness for the rationale); and
//   2. a child-exit listener that catches zombied detached children that
//      process.kill(pid, 0) would otherwise report as alive.
//
// These guards keep future edits from silently regressing #3111.
//
// Behavioural tests for isGatewayTcpReady live co-located with the module
// at src/lib/onboard/gateway-tcp-readiness.test.ts — this file only
// verifies the wiring inside onboard.ts.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3111
//      https://github.com/NVIDIA/NemoClaw/pull/3312 (K3s-path HTTP helper)

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("startDockerDriverGateway integration (#3111)", () => {
  const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");
  // Scope assertions to the startDockerDriverGateway function body so other
  // occurrences of the helpers (e.g. in stale-gateway reuse paths or in
  // module.exports) don't satisfy the source-shape checks and mask a
  // regression inside this function.
  const fnMatch = content.match(
    /async function startDockerDriverGateway\([\s\S]*?\n\}\n/,
  );
  if (!fnMatch) {
    throw new Error(
      "Expected 'async function startDockerDriverGateway' block in src/lib/onboard.ts",
    );
  }
  const fnBody = fnMatch[0];

  it("tracks child-exit so zombies don't fool isPidAlive", () => {
    // The concrete tracker lives in src/lib/onboard/child-exit-tracker.ts.
    // startDockerDriverGateway must use it (not reimplement the listener)
    // so the extraction stays extracted and the God-Object doesn't regrow.
    expect(fnBody).toMatch(/trackChildExit\(\s*child\s*\)/);
    expect(fnBody).not.toMatch(/child\.once\(\s*["']exit["']/);
  });

  it("breaks the poll loop when the child has exited", () => {
    expect(fnBody).toMatch(
      /childExit\.exited\s*\|\|\s*!isPidAlive\(childPid\)/,
    );
  });

  it("gates the 'healthy' log on the TCP readiness probe", () => {
    // The poll loop must call isGatewayTcpReady() before logging
    // "✓ Docker-driver gateway is healthy". We use a TCP probe rather than
    // the K3s-path isGatewayHttpReady because the Docker-driver gateway
    // only serves /openshell.v1.OpenShell/* — GET / returns 404 and
    // fails the HTTP probe even though the gateway is functional.
    const healthyIdx = fnBody.indexOf("Docker-driver gateway is healthy");
    expect(healthyIdx).toBeGreaterThan(0);
    const before = fnBody.slice(0, healthyIdx);
    expect(before).toMatch(/await\s+isGatewayTcpReady\(/);
  });

  it("does NOT use the K3s-path HTTP probe in the Docker-driver loop", () => {
    // Regression guard: a previous version of this fix called
    // isGatewayHttpReady() here, which broke the existing
    // openshell-gateway-upgrade-e2e test because the Docker-driver
    // gateway returns 404 on GET /. Do not reintroduce that pattern.
    const healthyIdx = fnBody.indexOf("Docker-driver gateway is healthy");
    const before = fnBody.slice(0, healthyIdx);
    expect(before).not.toMatch(/await\s+isGatewayHttpReady\(/);
  });

  it("does NOT define the probe, tracker, or failure reporter inline (they must live in their own modules)", () => {
    // onboard.ts is the God Object being decomposed — new helpers should
    // land in focused modules, mirroring the pattern established by
    // src/lib/onboard/gateway-http-readiness.ts. These imports enforce
    // that the fix stays extracted and doesn't regrow the entrypoint.
    expect(content).not.toMatch(/function\s+isGatewayTcpReady\s*\(/);
    expect(content).not.toMatch(/function\s+trackChildExit\s*\(/);
    expect(content).not.toMatch(
      /function\s+reportDockerDriverGatewayStartFailure\s*\(/,
    );
    expect(content).toMatch(
      /require\(\s*["']\.\/onboard\/gateway-tcp-readiness["']/,
    );
    expect(content).toMatch(
      /require\(\s*["']\.\/onboard\/child-exit-tracker["']/,
    );
    expect(content).toMatch(
      /require\(\s*["']\.\/onboard\/docker-driver-gateway-failure["']/,
    );
  });

  it("routes child-exit details through the failure reporter, not inline", () => {
    // The failure message showing HOW the gateway exited (signal or code)
    // comes from reportDockerDriverGatewayStartFailure's call to
    // childExit.describeExit() inside its own module. The call site here
    // only needs to pass childExit along.
    expect(fnBody).toMatch(
      /reportDockerDriverGatewayStartFailure\([^)]*childExit[^)]*\)/,
    );
    // And the old inline implementation must be gone.
    expect(fnBody).not.toMatch(/childExit\.describeExit\(\)/);
  });
});
