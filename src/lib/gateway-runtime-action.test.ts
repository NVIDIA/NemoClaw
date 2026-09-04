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
    vi.unstubAllEnvs();
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

    it("accepts a connected named gateway when the legacy gateway does not support info (#6903)", () => {
      captureSpy
        .mockReturnValueOnce({
          status: 0,
          output: "Status: Connected\nGateway: nemoclaw\nVersion: 0.0.72\n",
        })
        .mockReturnValueOnce({
          status: 1,
          output: "gateway info is not supported by this gateway version",
        });

      const result = gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw");

      expect(result.state).toBe("healthy_named");
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
        label: "arbitrary gateway info failure under a connected named gateway",
        status: "Gateway: nemoclaw\nStatus: Connected\n",
        gatewayInfo: "gateway info requires admin privileges",
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
    ])(
      "classifies $label conservatively as $expected",
      ({ status, gatewayInfo, gatewayInfoStatus, expected }) => {
        captureSpy
          .mockReturnValueOnce({ status: 0, output: status })
          .mockReturnValueOnce({ status: gatewayInfoStatus, output: gatewayInfo });

        const result = gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw");

        expect(result.state).toBe(expected);
      },
    );

    it("keeps probes fatal by default, but still captures stderr (ignoreError falsy)", () => {
      captureSpy.mockReturnValue({ status: 0, output: "Status: Connected\nGateway: nemoclaw\n" });

      gatewayRuntime.getNamedGatewayLifecycleState("nemoclaw");

      // Default path is fatal (no ignoreError). stderr is still captured here
      // because captureOpenshell includes stderr whenever ignoreError is falsy,
      // so the `Status:`/`Gateway:` lines (written to stderr) are not dropped.
      expect(
        captureSpy.mock.calls.every(
          ([, opts]) => opts?.ignoreError !== true && opts?.includeStderr !== true,
        ),
      ).toBe(true);
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

      expect(
        captureSpy.mock.calls.every(
          ([, opts]) => opts?.ignoreError === true && opts?.includeStderr === true,
        ),
      ).toBe(true);
    });
  });

  describe("recoverNamedGatewayRuntime", () => {
    it.each([
      { label: "authentication", status: 1, output: "gateway info requires admin privileges" },
      { label: "schema validation", status: 1, output: "protobuf decode error: invalid wire type" },
      { label: "gateway identity validation", status: 1, output: "handshake verification failed" },
      { label: "request validation", status: 2, output: "unknown option: --json" },
    ] as const)(
      "does not select or start a gateway when $label lifecycle probe fails (#10421)",
      async ({ status, output }) => {
        captureSpy.mockReturnValue({ status, output });
        runSpy.mockReturnValue({ status: 0 } as never);

        const result = await gatewayRuntime.recoverNamedGatewayRuntime({
          gatewayName: "nemoclaw-8090",
        });

        expect(result).toMatchObject({ recovered: false, attempted: false });
        expect(runSpy).not.toHaveBeenCalled();
        expect(startGatewaySpy).not.toHaveBeenCalled();
      },
    );

    it("does not start a gateway when the post-selection lifecycle probe fails (#10421)", async () => {
      captureSpy
        .mockReturnValueOnce({
          status: 0,
          output: "Status: Connected\nGateway: nemoclaw\n",
        })
        .mockReturnValueOnce({ status: 0, output: "Gateway: nemoclaw\n" })
        .mockReturnValue({ status: 1, output: "gateway info requires admin privileges" });
      runSpy.mockReturnValue({ status: 0 } as never);

      const result = await gatewayRuntime.recoverNamedGatewayRuntime({
        gatewayName: "nemoclaw-8090",
      });

      expect(result).toMatchObject({ recovered: false, attempted: true });
      expect(runSpy).toHaveBeenCalledOnce();
      expect(startGatewaySpy).not.toHaveBeenCalled();
    });

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
      expect(
        runSpy.mock.calls
          .filter(([args]) => args[0] === "gateway" && args[1] === "select")
          .every(([, options]) => options.stdio === "ignore"),
      ).toBe(true);
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
      expect(selectCalls.length).toBeGreaterThan(0);
      expect(selectCalls.every((args: string[]) => args[2] === "nemoclaw-8090")).toBe(true);
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

    it("keeps recovery probes and startup on the frozen OpenShell target (#10514)", async () => {
      vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
      vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
      vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
      vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "1");
      vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
      vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
      const runtimeSelection = {
        gatewayName: "nemoclaw-8090",
        workspace: "default",
        localTlsDir: "/recorded/tls",
      };
      captureSpy
        .mockReturnValueOnce({ status: 0, output: "Status: Disconnected\nGateway: nemoclaw\n" })
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({ status: 0, output: "Status: Disconnected\nGateway: nemoclaw\n" })
        .mockReturnValueOnce({ status: 0, output: "" })
        .mockReturnValueOnce({
          status: 0,
          output: "Status: Connected\nGateway: nemoclaw-8090\n",
        })
        .mockReturnValueOnce({ status: 0, output: "Gateway: nemoclaw-8090\n" });
      runSpy.mockReturnValue({ status: 0 } as never);

      await expect(
        gatewayRuntime.recoverNamedGatewayRuntime({
          gatewayName: "nemoclaw-8090",
          runtimeSelection,
        }),
      ).resolves.toMatchObject({ recovered: true, via: "start" });

      const subprocessOptions = [
        ...captureSpy.mock.calls.map(([, options]) => options),
        ...runSpy.mock.calls.map(([, options]) => options),
      ];
      expect(subprocessOptions.length).toBeGreaterThan(0);
      expect(
        subprocessOptions.every(
          (options) =>
            options.replaceEnv === true &&
            options.env.OPENSHELL_GATEWAY === "nemoclaw-8090" &&
            options.env.OPENSHELL_WORKSPACE === "default" &&
            options.env.OPENSHELL_LOCAL_TLS_DIR === "/recorded/tls" &&
            options.env.OPENSHELL_GATEWAY_ENDPOINT === undefined &&
            options.env.OPENSHELL_GATEWAY_INSECURE === undefined &&
            options.env.OPENSHELL_TOKEN === undefined,
        ),
      ).toBe(true);
      expect(startGatewaySpy).toHaveBeenCalledWith({
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
        runtimeSelection,
      });
    });

    it.each([
      {
        state: "connected_other",
        status: "Status: Connected\nGateway: nemoclaw\n",
        gatewayInfo: "Gateway: nemoclaw\n",
      },
      {
        state: "named_unreachable",
        status: "Status: Disconnected\nGateway: nemoclaw-8090\nConnection refused\n",
        gatewayInfo: "Gateway: nemoclaw-8090\n",
      },
    ] as const)(
      "starts the requested gateway when selection leaves it $state (#10249)",
      async ({ gatewayInfo, state, status }) => {
        captureSpy
          .mockReturnValueOnce({ status: 0, output: status })
          .mockReturnValueOnce({ status: 0, output: gatewayInfo })
          .mockReturnValueOnce({ status: 0, output: status })
          .mockReturnValueOnce({ status: 0, output: gatewayInfo })
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
        expect(result).toMatchObject({
          recovered: true,
          before: { state },
          after: { state: "healthy_named" },
          attempted: true,
          via: "start",
        });
      },
    );
  });
});
