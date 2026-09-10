// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellGatewayObservation } from "./adapters/openshell/gateway-observer";
import * as gatewayRuntime from "./gateway-runtime-action";

function observation(state: OpenShellGatewayObservation["state"]): OpenShellGatewayObservation {
  return {
    state,
    activeGateway: "nemoclaw-8090",
    recoveryBlocked: state === "observation_failed",
    unavailable: state === "named_unreachable",
    diagnostic: state,
  };
}

describe("gateway observations and recovery", () => {
  let observe: ReturnType<typeof vi.spyOn>;
  let run: ReturnType<typeof vi.spyOn>;
  let start: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    observe = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "observeGateway");
    run = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "runOpenshell");
    start = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "startGatewayForRecovery");
    observe.mockReset().mockResolvedValue(observation("missing_named"));
    run.mockReset().mockReturnValue({ status: 0 } as never);
    start.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("OPENSHELL_GATEWAY", "foreign");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes the default gateway to the observer without mutating selection", async () => {
    await gatewayRuntime.getNamedGatewayLifecycleState();
    expect(observe).toHaveBeenCalledWith({ target: { kind: "named", gatewayName: "nemoclaw" } });
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(process.env.OPENSHELL_GATEWAY).toBe("foreign");
  });

  it("passes the recorded gateway and runtime selection to every recovery observation (#10514)", async () => {
    const output = { error: vi.fn(), log: vi.fn(), step: vi.fn(), warn: vi.fn() };
    const runtimeSelection = {
      gatewayName: "nemoclaw-8090",
      workspace: "default",
      localTlsDir: "/recorded/tls",
    };
    observe
      .mockResolvedValueOnce(observation("named_unreachable"))
      .mockResolvedValueOnce(observation("named_unreachable"))
      .mockResolvedValueOnce(observation("healthy_named"));
    const result = await gatewayRuntime.recoverNamedGatewayRuntime({
      gatewayName: "nemoclaw-8090",
      runtimeSelection,
      output,
    });
    expect(result).toMatchObject({ recovered: true, via: "start" });
    expect(observe).toHaveBeenCalledTimes(3);
    const expectedRequest = {
      target: { kind: "named", gatewayName: "nemoclaw-8090" },
      runtimeSelection,
    };
    expect(observe).toHaveBeenNthCalledWith(1, expectedRequest);
    expect(observe).toHaveBeenNthCalledWith(2, expectedRequest);
    expect(observe).toHaveBeenNthCalledWith(3, expectedRequest);
    expect(start).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
      runtimeSelection,
      output,
    });
  });

  it("does not select or start after an inconclusive observation (#10421)", async () => {
    observe.mockResolvedValue(observation("observation_failed"));
    expect(await gatewayRuntime.recoverNamedGatewayRuntime()).toMatchObject({
      recovered: false,
      attempted: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("stops recovery after selection when the next observation fails (#10421)", async () => {
    observe
      .mockResolvedValueOnce(observation("connected_other"))
      .mockResolvedValue(observation("observation_failed"));
    expect(await gatewayRuntime.recoverNamedGatewayRuntime()).toMatchObject({
      recovered: false,
      attempted: true,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("returns healthy observations without attempting recovery", async () => {
    observe.mockResolvedValue(observation("healthy_named"));
    expect(await gatewayRuntime.recoverNamedGatewayRuntime()).toMatchObject({
      recovered: true,
      attempted: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("reports successful selection without starting the gateway", async () => {
    observe
      .mockResolvedValueOnce(observation("connected_other"))
      .mockResolvedValueOnce(observation("healthy_named"));
    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({ gatewayName: "nemoclaw-8090" }),
    ).toMatchObject({ recovered: true, via: "select" });
    expect(run).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw-8090"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(start).not.toHaveBeenCalled();
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
  });

  it.each(["connected_other", "named_unreachable"] as const)(
    "starts the intended gateway when selection leaves it %s (#10249)",
    async (state) => {
      observe
        .mockResolvedValueOnce(observation(state))
        .mockResolvedValueOnce(observation(state))
        .mockResolvedValueOnce(observation("healthy_named"));
      expect(
        await gatewayRuntime.recoverNamedGatewayRuntime({ gatewayName: "nemoclaw-8090" }),
      ).toMatchObject({ recovered: true, via: "start", before: { state } });
      expect(start).toHaveBeenCalledWith({ gatewayName: "nemoclaw-8090", gatewayPort: 8090 });
    },
  );

  it("preserves an explicitly excluded recovery state", async () => {
    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({ recoverableStates: [] }),
    ).toMatchObject({ recovered: false, attempted: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects mismatched runtime authority before observing or mutating", async () => {
    await expect(
      gatewayRuntime.recoverNamedGatewayRuntime({
        gatewayName: "nemoclaw",
        runtimeSelection: { gatewayName: "foreign", workspace: "default" },
      }),
    ).rejects.toThrow("does not match");
    expect(observe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
