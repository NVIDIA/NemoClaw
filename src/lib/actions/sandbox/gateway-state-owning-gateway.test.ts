// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gatewayRuntime from "../../gateway-runtime-action";
import * as registry from "../../state/registry";
import * as gatewaySelect from "./gateway-select";
import { getReconciledSandboxGatewayState } from "./gateway-state";

describe("getReconciledSandboxGatewayState owning-gateway guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reselects the owning gateway and re-queries when a present comes from another active gateway", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState").mockReturnValue({
      state: "connected_other",
      status: "",
      activeGateway: "nemoclaw",
    } as never);
    const selectSpy = vi
      .spyOn(gatewaySelect, "selectSandboxOwningGateway")
      .mockReturnValue({ outcome: "selected", gatewayName: "nemoclaw-8091" });

    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "present", output: "Phase: Provisioning" })
      .mockResolvedValueOnce({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledTimes(2);
    expect(selectSpy).toHaveBeenCalledWith("beta");
    expect(result).toMatchObject({
      state: "present",
      output: "Phase: Ready",
      recoveredGateway: true,
      recoveryVia: "select",
    });
  });

  it("reports wrong_gateway_active and does not re-query when owning-gateway selection fails", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState").mockReturnValue({
      state: "connected_other",
      status: "some status",
      activeGateway: "nemoclaw",
    } as never);
    const selectSpy = vi
      .spyOn(gatewaySelect, "selectSandboxOwningGateway")
      .mockReturnValue({ outcome: "failed", gatewayName: "nemoclaw-8091" });

    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "present", output: "Phase: Provisioning" });

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledWith("beta");
    expect(result).toMatchObject({
      state: "wrong_gateway_active",
      activeGateway: "nemoclaw",
      output: "some status",
    });
    expect(result.recoveredGateway).toBeUndefined();
  });

  it("trusts a present from the owning gateway without reselecting", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState").mockReturnValue({
      state: "healthy_named",
      status: "",
    } as never);
    const selectSpy = vi.spyOn(gatewaySelect, "selectSandboxOwningGateway");

    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledTimes(1);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: "present", output: "Phase: Ready" });
    expect(result.recoveredGateway).toBeUndefined();
  });

  it("leaves an unregistered sandbox's present result untouched", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const lifecycleSpy = vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState");
    const selectSpy = vi.spyOn(gatewaySelect, "selectSandboxOwningGateway");

    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("ghost", { getState });

    expect(getState).toHaveBeenCalledTimes(1);
    expect(lifecycleSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: "present" });
  });
});
