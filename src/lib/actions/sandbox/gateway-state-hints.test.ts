// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

type GatewayStateModule = typeof import("../../../../dist/lib/actions/sandbox/gateway-state");

const requireDist = createRequire(import.meta.url);

describe("printGatewayLifecycleHint multi-instance hints", () => {
  let gatewayState: GatewayStateModule;
  let getSandboxSpy: MockInstance;

  beforeEach(async () => {
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "instance-a",
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    gatewayState = requireDist("../../../../dist/lib/actions/sandbox/gateway-state.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces a switch-gateway hint when the underlying gRPC error is `sandbox has no spec`", () => {
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint(
      'status: Internal, message: "sandbox has no spec", details: []',
      "instance-a",
      (msg: string) => lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).toContain("instance-a");
    expect(combined).toContain("nemoclaw");
    expect(combined).toContain("openshell gateway select");
    expect(getSandboxSpy).toHaveBeenCalledWith("instance-a");
  });

  it("uses the sandbox's per-port gateway name in the hint for a non-default `NEMOCLAW_GATEWAY_PORT`", () => {
    getSandboxSpy.mockReturnValue({
      name: "instance-b",
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
    });
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint("sandbox has no spec", "instance-b", (msg: string) =>
      lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).toContain("nemoclaw-8081");
    expect(combined).toContain("openshell gateway select nemoclaw-8081");
  });

  it("does not match the new clause on unrelated gateway lifecycle output", () => {
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint("No gateway configured", "instance-a", (msg: string) =>
      lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).not.toContain("sandbox has no spec");
    expect(combined).toContain("openshell gateway start");
  });
});
