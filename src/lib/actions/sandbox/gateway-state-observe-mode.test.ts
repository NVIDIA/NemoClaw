// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayRuntime from "../../gateway-runtime-action";
import * as registry from "../../state/registry";
import * as gatewaySelect from "./gateway-select";
import { getReconciledSandboxGatewayState } from "./gateway-state";

describe("getReconciledSandboxGatewayState observe mode", () => {
  beforeEach(() => {
    vi.spyOn(gatewaySelect, "selectSandboxOwningGateway").mockReturnValue({
      outcome: "selected",
      gatewayName: "nemoclaw-8091",
    });
    vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState").mockReturnValue({
      state: "healthy_named",
      activeGateway: "nemoclaw-8091",
      status: "Gateway: nemoclaw-8091\nStatus: Connected",
    } as never);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns gateway_error verbatim without invoking host gateway recovery", async () => {
    const recover = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: true } as never);
    const getState = vi
      .fn()
      .mockResolvedValue({ state: "gateway_error", output: "transport error" });

    const result = await getReconciledSandboxGatewayState("beta", {
      getState,
      gatewayRecovery: "observe",
    });

    expect(getState).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: "gateway_error", output: "transport error" });
    expect(result.recoveredGateway).toBeUndefined();
  });

  it("still invokes recovery when caller opts into recover mode explicitly", async () => {
    const recover = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      via: "start",
    } as never);
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "gateway_error", output: "transport error" })
      .mockResolvedValueOnce({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", {
      getState,
      gatewayRecovery: "recover",
    });

    expect(recover).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      state: "present",
      output: "Phase: Ready",
      recoveredGateway: true,
      recoveryVia: "start",
    });
  });

  it("defaults to recover mode when no option is supplied", async () => {
    const recover = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: true } as never);
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "gateway_error", output: "transport error" })
      .mockResolvedValueOnce({ state: "present", output: "Phase: Ready" });

    await getReconciledSandboxGatewayState("beta", { getState });

    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not touch recovery for non-error states in observe mode", async () => {
    const recover = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: true } as never);
    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", {
      getState,
      gatewayRecovery: "observe",
    });

    expect(recover).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: "present" });
  });
});
