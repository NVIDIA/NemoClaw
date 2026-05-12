// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that onboarding probes the gateway Docker container before trusting
// "healthy" metadata from the openshell CLI. Without this, a stale local
// state file causes step 2 to skip gateway startup even when the container
// has been removed, leading to "Connection refused" in step 4.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/2020

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("gateway liveness probe (#2020)", () => {
  const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");

  it("verifyGatewayContainerRunning() helper exists and checks Docker state", () => {
    const match = content.match(/function verifyGatewayContainerRunning\([\s\S]*?^}/m);
    expect(match).toBeTruthy();
    if (!match) throw new Error("Expected verifyGatewayContainerRunning() in src/lib/onboard.ts");
    // Must use a Docker inspect helper to probe container state
    expect(match[0]).toMatch(/docker(?:Inspect|ContainerInspectFormat)\(/);
    // Must check .State.Running, not just container existence
    expect(match[0]).toContain("{{.State.Running}}");
  });

  it("preflight probes the container when gatewayReuseState is 'healthy'", () => {
    // The preflight section must call the probe before entering the port loop.
    // Scope to preflight so the regex can't accidentally match the main onboard block.
    const preflightStart = content.indexOf("async function preflight(");
    const preflightEnd = content.indexOf("async function startGatewayWithOptions(");
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(preflightEnd).toBeGreaterThan(preflightStart);
    const preflightSection = content.slice(preflightStart, preflightEnd);
    const preflightProbe = preflightSection.match(
      /let gatewayReuseState = gatewaySnapshot\.gatewayReuseState[\s\S]*?verifyGatewayContainerRunning\(\)[\s\S]*?gatewayReuseState = "missing"/,
    );
    expect(preflightProbe).toBeTruthy();
  });

  it("main onboard flow probes the container before canReuseHealthyGateway", () => {
    // The main onboard flow must also probe before setting canReuseHealthyGateway.
    // Scope to the onboard() function so the regex can't accidentally match the preflight block.
    const onboardSection = content.slice(content.indexOf("async function onboard("));
    const mainFlowProbe = onboardSection.match(
      /let gatewayReuseState = gatewaySnapshot\.gatewayReuseState[\s\S]*?verifyGatewayContainerRunning\(\)[\s\S]*?const canReuseHealthyGateway/,
    );
    expect(mainFlowProbe).toBeTruthy();
  });

  it("returns tri-state: running, missing, or unknown", () => {
    // The helper must distinguish container-removed from Docker-unavailable
    expect(content).toContain('return "running"');
    expect(content).toContain('return "missing"');
    expect(content).toContain('return "unknown"');
  });

  it("only downgrades to 'missing' when container is confirmed missing", () => {
    // Both probe sites must check containerState === "missing" before cleanup
    const downgrades = content.match(/containerState === "missing"/g);
    expect(downgrades).toBeTruthy();
    if (!downgrades) {
      throw new Error('Expected containerState === "missing" checks in src/lib/onboard.ts');
    }
    expect(downgrades.length).toBeGreaterThanOrEqual(2);
  });

  it("cleans up stale metadata when container is confirmed missing", () => {
    // After detecting a removed container, the code must clean up forwarding
    // and destroy the gateway via the shared destroyGateway() helper.
    const cleanupAfterProbe = content.match(
      /containerState === "missing"[\s\S]*?forward.*stop[\s\S]*?destroyGateway\(\)/,
    );
    expect(cleanupAfterProbe).toBeTruthy();
  });

  it("main onboard flow aborts (does not downgrade or destroy) when Docker is unknown and HTTP is unready (#3258, #2020)", () => {
    // Regression guard: when verifyGatewayContainerRunning() returns "unknown"
    // and the host HTTP probe also fails, we cannot tell whether the existing
    // gateway is live. Per #2020 the branch must stay non-destructive, and
    // it must not downgrade gatewayReuseState to "missing" — that would feed
    // execution into startGatewayWithOptions, whose retry hook destroys the
    // gateway between failed attempts and would tear down a possibly-live
    // gateway when Docker is just temporarily unavailable.
    const onboardSection = content.slice(content.indexOf("async function onboard("));
    const unknownBranchMatch = onboardSection.match(
      /containerState === "unknown"[\s\S]*?waitForGatewayHttpReady\(\)[\s\S]*?\} else \{[\s\S]*?\}\s*\}/,
    );
    expect(unknownBranchMatch).toBeTruthy();
    if (!unknownBranchMatch) {
      throw new Error('Expected containerState === "unknown" branch in main onboard()');
    }
    const branchBody = unknownBranchMatch[0];
    // Must bail out — no fall-through into start-gateway / orphan-cleanup paths.
    expect(branchBody).toMatch(/process\.exit\(/);
    // Must not downgrade reuse state (would feed startGatewayWithOptions whose
    // retry hook calls destroyGateway, tearing down a possibly-live gateway).
    expect(branchBody).not.toMatch(/gatewayReuseState\s*=\s*"missing"/);
  });

  it("does not modify isGatewayHealthy() in src/lib/state/gateway.ts", () => {
    // isGatewayHealthy() must remain a pure function — no I/O.
    // Scope the check to the function body so unrelated helpers don't cause false failures.
    const gsContent = fs.readFileSync(path.join(ROOT, "src/lib/state/gateway.ts"), "utf-8");
    const fnMatch = gsContent.match(
      /(?:function isGatewayHealthy|const isGatewayHealthy\b)[\s\S]*?\n\}/,
    );
    expect(fnMatch).toBeTruthy();
    if (!fnMatch) {
      throw new Error("Expected isGatewayHealthy() in src/lib/state/gateway.ts");
    }
    const fnBody = fnMatch[0];
    expect(fnBody).not.toContain("docker");
    expect(fnBody).not.toContain("spawn");
    expect(fnBody).not.toContain("exec");
  });
});
