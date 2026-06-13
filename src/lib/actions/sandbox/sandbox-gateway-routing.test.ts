// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const requireDist = createRequire(import.meta.url);

type RoutingModule = typeof import("../../../../dist/lib/actions/sandbox/sandbox-gateway-routing");

describe("sandbox gateway routing helpers", () => {
  let routing: RoutingModule;
  let spies: MockInstance[];
  let getSandboxSpy: MockInstance;
  let captureOpenshellSpy: MockInstance;
  let runOpenshellSpy: MockInstance;

  beforeEach(() => {
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");

    spies = [];
    getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
      openshellDriver: "vm",
    });
    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation((args: unknown) => {
        const argv = Array.isArray(args) ? args : [];
        return {
          status: 0,
          output:
            argv[0] === "status"
              ? "Server Status\n\nGateway: nemoclaw-8090\nStatus: Connected\n"
              : "Gateway Info\n\nGateway: nemoclaw-8090\nGateway endpoint: https://127.0.0.1:8090/\n",
        } as never;
      });
    runOpenshellSpy = vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({
      status: 0,
    } as never);
    spies.push(getSandboxSpy, captureOpenshellSpy, runOpenshellSpy);

    routing = requireDist("../../../../dist/lib/actions/sandbox/sandbox-gateway-routing.js");
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("uses the persisted gateway name for metadata health probes", () => {
    expect(routing.probeGatewayRunning("alpha")).toBe(true);

    expect(captureOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "info", "-g", "nemoclaw-8090"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("selects the persisted gateway before sandbox-scoped OpenShell commands", () => {
    routing.selectSandboxGatewayIfRegistered("alpha");

    expect(runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-8090"],
      expect.objectContaining({ ignoreError: true }),
    );
  });
});
