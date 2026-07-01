// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("startDockerDriverGateway sandbox-bridge cleanup callsites", () => {
  it("passes the standalone gateway cleanup hook to every host-mode verifier call", () => {
    const source = fs.readFileSync(new URL("../onboard.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function startDockerDriverGateway(");
    const end = source.indexOf("async function startGateway(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const body = source.slice(start, end);
    expect(body).toContain("onUnreachable: () => void stopDockerDriverGatewayProcess()");
    expect(
      body.match(
        /verifySandboxBridgeGatewayReachableOrExit\(exitOnFailure, sandboxBridgeProbeOptions\)/g,
      ),
    ).toHaveLength(3);
    expect(body).not.toMatch(
      /verifySandboxBridgeGatewayReachableOrExit\(exitOnFailure, \{\s*skip:/,
    );
  });
});
