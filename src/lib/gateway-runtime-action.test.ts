// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as gatewayRuntime from "./gateway-runtime-action";

describe("gateway-runtime-action per-sandbox gateway routing", () => {
  let captureSpy: MockInstance;
  let runSpy: MockInstance;
  let startGatewaySpy: MockInstance;

  beforeEach(() => {
    captureSpy = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "captureOpenshell");
    runSpy = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "runOpenshell");
    startGatewaySpy = vi
      .spyOn(gatewayRuntime.gatewayRuntimeDependencies, "startGatewayForRecovery")
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENSHELL_GATEWAY;
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

    it.each([
      {
        label: "failed gateway metadata under a connected foreign gateway",
        status: "Gateway: openshell\nStatus: Connected\n",
        gatewayInfo: "No gateway metadata found",
        gatewayInfoStatus: 1,
        expected: "connected_other",
      },
      {
        label: "empty lifecycle output",
        status: "",
        gatewayInfo: "",
        gatewayInfoStatus: 0,
        expected: "missing_named",
      },
      {
        label: "malformed lifecycle output",
        status: "??? garbage output ???",
        gatewayInfo: "garbage gateway info",
        gatewayInfoStatus: 0,
        expected: "missing_named",
      },
    ])("classifies $label conservatively as $expected", ({
      status,
      gatewayInfo,
      gatewayInfoStatus,
      expected,
    }) => {
      captureSpy
        .mockReturnValueOnce({ status: 0, output: status })
        .mockReturnValueOnce({ status: gatewayInfoStatus, output: gatewayInfo });

      const result = gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw");

      expect(result.state).toBe(expected);
    });

    it("keeps probes fatal by default, but still captures stderr (ignoreError falsy)", () => {
      captureSpy.mockReturnValue({ status: 0, output: "Status: Connected\nGateway: nemoclaw\n" });

      gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw");

      for (const [, opts] of captureSpy.mock.calls) {
        // Default path is fatal (no ignoreError). stderr is still captured here
        // because captureOpenshell includes stderr whenever ignoreError is falsy,
        // so the `Status:`/`Gateway:` lines (written to stderr) are not dropped.
        expect(opts?.ignoreError).not.toBe(true);
        expect(opts?.includeStderr).not.toBe(true);
      }
    });

    it("makes probes non-fatal AND keeps includeStderr in lockstep when ignoreProbeErrors is set (#5714)", () => {
      // Plain `nemoclaw list` recovery must not be killed by a hung gateway:
      // both lifecycle probes must run with ignoreError so an ETIMEDOUT is
      // swallowed instead of triggering captureOpenshell's process.exit. Because
      // ignoreError would otherwise drop stderr (where OpenShell writes the
      // Status:/Gateway: lines), includeStderr MUST stay true in lockstep, or
      // the healthy/connected classification silently breaks.
      captureSpy.mockReturnValue({ status: 0, output: "Status: Connected\nGateway: nemoclaw\n" });

      gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw", { ignoreProbeErrors: true });

      expect(captureSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, opts] of captureSpy.mock.calls) {
        expect(opts?.ignoreError).toBe(true);
        expect(opts?.includeStderr).toBe(true);
      }
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
