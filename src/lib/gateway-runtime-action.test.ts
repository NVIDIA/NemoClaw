// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

type GatewayRuntimeModule = typeof import("../../dist/lib/gateway-runtime-action");

const requireDist = createRequire(import.meta.url);
const gatewayRuntimeModulePath = "../../dist/lib/gateway-runtime-action.js";

describe("gateway-runtime-action per-sandbox gateway routing", () => {
  let gatewayRuntime: GatewayRuntimeModule;
  let captureSpy: MockInstance;
  let runSpy: MockInstance;
  let startGatewaySpy: MockInstance;
  let spies: MockInstance[];

  beforeEach(() => {
    spies = [];
    delete require.cache[requireDist.resolve(gatewayRuntimeModulePath)];
    const openshellRuntime = requireDist("../../dist/lib/adapters/openshell/runtime.js");
    captureSpy = vi.spyOn(openshellRuntime, "captureOpenshell");
    runSpy = vi.spyOn(openshellRuntime, "runOpenshell");
    spies.push(captureSpy, runSpy);

    // The recovery path also pokes onboard.startGatewayForRecovery via lazy
    // require(); stub it so the tests do not pull onboard's runtime in.
    const onboard = requireDist("../../dist/lib/onboard.js");
    startGatewaySpy = vi
      .spyOn(onboard, "startGatewayForRecovery")
      .mockResolvedValue(undefined as never);
    spies.push(startGatewaySpy);

    gatewayRuntime = requireDist(gatewayRuntimeModulePath);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    delete process.env.OPENSHELL_GATEWAY;
    delete require.cache[requireDist.resolve(gatewayRuntimeModulePath)];
  });

  describe("getNamedGatewayLifecycleState", () => {
    it("queries the bare 'nemoclaw' name by default", () => {
      captureSpy.mockReturnValue({ status: 0, output: "Status: Connected\nGateway: nemoclaw\n" });

      gatewayRuntime.getNamedGatewayLifecycleState();

      const calls = captureSpy.mock.calls.map(([args]) => args);
      expect(calls).toContainEqual(["gateway", "info", "-g", "nemoclaw"]);
    });

    it("queries the per-port gateway when a name is supplied", () => {
      captureSpy.mockReturnValue({
        status: 0,
        output: "Status: Connected\nGateway: nemoclaw-8090\n",
      });

      const result = gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw-8090");

      const calls = captureSpy.mock.calls.map(([args]) => args);
      expect(calls).toContainEqual(["gateway", "info", "-g", "nemoclaw-8090"]);
      expect(result.state).toBe("healthy_named");
      expect(result.activeGateway).toBe("nemoclaw-8090");
    });

    it("treats a non-default gateway as 'connected_other' when the active gateway differs", () => {
      captureSpy.mockReturnValue({
        status: 0,
        output: "Status: Connected\nGateway: nemoclaw\n",
      });

      const result = gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw-8090");

      expect(result.state).toBe("connected_other");
      expect(result.activeGateway).toBe("nemoclaw");
    });
  });

  describe("recoverNamedGatewayRuntime", () => {
    it("selects the supplied gateway name on the recovery path", async () => {
      captureSpy
        .mockReturnValueOnce({ status: 0, output: "Status: Disconnected\nGateway: nemoclaw\n" })
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({
          status: 0,
          output: "Status: Connected\nGateway: nemoclaw-8090\n",
        })
        .mockReturnValueOnce({
          status: 0,
          output: "Gateway: nemoclaw-8090\n",
        });
      runSpy.mockReturnValue({ status: 0 } as never);

      const result = await gatewayRuntime.recoverNamedGatewayRuntime({
        gatewayName: "nemoclaw-8090",
      });

      const selectCalls = runSpy.mock.calls
        .map(([args]) => args)
        .filter((args: string[]) => args[0] === "gateway" && args[1] === "select");
      expect(selectCalls).toContainEqual(["gateway", "select", "nemoclaw-8090"]);
      expect(selectCalls.every((args: string[]) => args[2] === "nemoclaw-8090")).toBe(true);
      expect(result.recovered).toBe(true);
      expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
    });

    it("never selects the bare default gateway when a per-port name is supplied", async () => {
      captureSpy.mockReturnValue({
        status: 0,
        output: "Status: Disconnected\nGateway: other\n",
      });
      runSpy.mockReturnValue({ status: 0 } as never);

      await gatewayRuntime.recoverNamedGatewayRuntime({ gatewayName: "nemoclaw-8090" });

      const selectCalls = runSpy.mock.calls
        .map(([args]) => args)
        .filter((args: string[]) => args[0] === "gateway" && args[1] === "select");
      for (const args of selectCalls) {
        expect(args[2]).toBe("nemoclaw-8090");
      }
    });

    it("starts recovery with the supplied gateway name and derived port", async () => {
      captureSpy
        .mockReturnValueOnce({ status: 0, output: "Status: Disconnected\nGateway: nemoclaw\n" })
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({ status: 0, output: "Status: Disconnected\nGateway: nemoclaw\n" })
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({
          status: 0,
          output: "Status: Connected\nGateway: nemoclaw-8090\n",
        })
        .mockReturnValueOnce({
          status: 0,
          output: "Gateway: nemoclaw-8090\n",
        });
      runSpy.mockReturnValue({ status: 0 } as never);

      const result = await gatewayRuntime.recoverNamedGatewayRuntime({
        gatewayName: "nemoclaw-8090",
      });

      expect(startGatewaySpy).toHaveBeenCalledWith({
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
      });
      expect(result.recovered).toBe(true);
      expect(result.via).toBe("start");
      expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
    });
  });
});
