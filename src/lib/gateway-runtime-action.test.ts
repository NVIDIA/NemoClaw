// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellGatewayObserver } from "./adapters/openshell/gateway-observer-cli";
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
    run = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "selectGateway");
    start = vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "startGatewayForRecovery");
    observe.mockReset().mockResolvedValue(observation("missing_named"));
    run.mockReset().mockResolvedValue({ ok: true, state: "completed" } as never);
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
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
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

  it("recovers a registry-authorized exact target through an offline transport", async () => {
    const unavailable = {
      ...observation("observation_failed"),
      unavailable: true,
      error: {
        kind: "transport" as const,
        reason: "unreachable" as const,
        message: "The selected gateway is unreachable.",
      },
    };
    const runtimeSelection = { gatewayName: "nemoclaw-8090", workspace: "default" };
    observe.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(observation("healthy_named"));

    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection,
      }),
    ).toMatchObject({ recovered: true, attempted: true, via: "start" });
    expect(start).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-8090",
      gatewayPort: 8090,
      runtimeSelection,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  });

  it("blocks recovery when unreachable CLI probes report a conflicting gateway", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "Gateway: foreign\nConnection refused" })
      .mockResolvedValueOnce({ status: 1, output: "Connection refused" });
    observe.mockImplementation(createCliOpenShellGatewayObserver(capture).observeGateway);
    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection: { gatewayName: "nemoclaw-8090", workspace: "default" },
      }),
    ).toMatchObject({ recovered: false, attempted: false });
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    [
      "identity mismatch",
      "handshake verification failed",
      "transport",
      undefined,
      "identity_mismatch",
    ],
    ["authentication", "unauthorized", "authentication", undefined],
    ["schema", "invalid wire type", "schema", undefined],
    ["timeout", "Connection refused", "timeout", "ETIMEDOUT"],
    ["unknown error", "Unexpected gateway failure", "command", undefined],
  ])(
    "blocks real CLI %s observations before recovery",
    async (_label, output, kind, code, reason = undefined) => {
      const capture = vi.fn().mockResolvedValue({
        status: 1,
        output,
        ...(code ? { error: Object.assign(new Error("probe failed"), { code }) } : {}),
      });
      observe.mockImplementation(createCliOpenShellGatewayObserver(capture).observeGateway);
      const result = await gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection: { gatewayName: "nemoclaw-8090", workspace: "default" },
      });
      expect(start).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        recovered: false,
        attempted: false,
        before: { recoveryBlocked: true, error: { kind } },
      });
      expect(result.before.error).toMatchObject({ kind, ...(reason ? { reason } : {}) });
      expect(run).not.toHaveBeenCalled();
      expect(process.env.OPENSHELL_GATEWAY).toBe("foreign");
    },
  );

  it.each([
    "handshake verification failed",
    "unauthorized",
    "invalid wire type",
    "unknown failure",
  ])("blocks failed metadata %s when status is unreachable", async (output) => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "Connection refused" })
      .mockResolvedValueOnce({ status: 1, output });
    observe.mockImplementation(createCliOpenShellGatewayObserver(capture).observeGateway);
    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection: { gatewayName: "nemoclaw-8090", workspace: "default" },
      }),
    ).toMatchObject({ recovered: false, attempted: false });
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    {
      authorizeExactTargetTransportRecovery: false,
      runtimeSelection: { gatewayName: "nemoclaw-8090", workspace: "default" },
    },
    { authorizeExactTargetTransportRecovery: true },
  ])(
    "requires exact target authority for an unreachable CLI observation [case %#]",
    async (authority) => {
      const capture = vi.fn().mockResolvedValue({ status: 1, output: "Connection refused" });
      observe.mockImplementation(createCliOpenShellGatewayObserver(capture).observeGateway);
      expect(
        await gatewayRuntime.recoverNamedGatewayRuntime({
          ...authority,
          gatewayName: "nemoclaw-8090",
        }),
      ).toMatchObject({ recovered: false, attempted: false });
      expect(run).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("rejects mismatched target authority before observation or recovery", async () => {
    await expect(
      gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection: { gatewayName: "foreign", workspace: "default" },
      }),
    ).rejects.toThrow("does not match runtime selection");
    expect(observe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts an authorized unreachable CLI target before selection and verifies recovery", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ status: 1, output: "Connection refused" })
      .mockResolvedValueOnce({ status: 1, output: "Connection refused" })
      .mockResolvedValueOnce({ status: 0, output: "Status: Connected\nGateway: nemoclaw-8090" })
      .mockResolvedValueOnce({ status: 0, output: "Gateway: nemoclaw-8090" });
    observe.mockImplementation(createCliOpenShellGatewayObserver(capture).observeGateway);
    expect(
      await gatewayRuntime.recoverNamedGatewayRuntime({
        authorizeExactTargetTransportRecovery: true,
        gatewayName: "nemoclaw-8090",
        runtimeSelection: { gatewayName: "nemoclaw-8090", workspace: "default" },
      }),
    ).toMatchObject({ recovered: true, attempted: true, via: "start" });
    expect(start).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(capture).toHaveBeenCalledTimes(4);
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
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
    expect(run).toHaveBeenCalledWith({ target: { kind: "named", gatewayName: "nemoclaw-8090" } });
    expect(start).not.toHaveBeenCalled();
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-8090");
  });

  it("starts a registry-confirmed missing gateway before selection (#11898)", async () => {
    observe
      .mockResolvedValueOnce(observation("missing_named"))
      .mockResolvedValueOnce(observation("healthy_named"));

    await expect(
      gatewayRuntime.recoverNamedGatewayRuntime({ gatewayName: "nemoclaw-8090" }),
    ).resolves.toMatchObject({ recovered: true, attempted: true, via: "start" });
    expect(start).toHaveBeenCalledWith({ gatewayName: "nemoclaw-8090", gatewayPort: 8090 });
    expect(run).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
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

  it("reports a redacted startup failure only after recovery remains unhealthy", async () => {
    const output = { error: vi.fn(), log: vi.fn(), step: vi.fn(), warn: vi.fn() };
    observe.mockResolvedValue(observation("named_unhealthy"));
    start.mockRejectedValueOnce(
      new Error("gateway start failed with Authorization: Bearer recovery-secret"),
    );
    const result = await gatewayRuntime.recoverNamedGatewayRuntime({
      gatewayName: "nemoclaw-8090",
      output,
    });
    expect(result).toMatchObject({ recovered: false, attempted: true });
    expect(output.error).toHaveBeenCalledOnce();
    expect(output.error.mock.calls[0]?.[0]).toContain("OpenShell gateway recovery failed");
    expect(output.error.mock.calls[0]?.[0]).toContain("<REDACTED>");
    expect(output.error.mock.calls[0]?.[0]).not.toContain("recovery-secret");
  });

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
