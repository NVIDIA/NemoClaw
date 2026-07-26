// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayDrift from "../../adapters/openshell/gateway-drift";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as registry from "../../state/registry";
import * as gatewaySelect from "./gateway-select";
import {
  getReconciledSandboxGatewayState,
  getSandboxGatewayState,
  getSandboxGatewayStateForStatus,
} from "./gateway-state";

describe("getReconciledSandboxGatewayState owning-gateway guard", () => {
  beforeEach(() => {
    vi.spyOn(gatewaySelect, "selectSandboxOwningGateway").mockReturnValue({
      outcome: "selected",
      gatewayName: "nemoclaw-8091",
    });
    vi.spyOn(gatewayRuntime, "getNamedGatewayLifecycleState").mockReturnValue({
      state: "connected_other",
      activeGateway: "sibling",
      status: "Gateway: sibling\nStatus: Connected",
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pins both the sandbox and policy RPCs to the recorded owner", () => {
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
    const capture = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValueOnce({ status: 0, output: "Policy:\nPhase: Ready" } as never)
      .mockReturnValueOnce({ status: 0, output: "version: 1" } as never);

    const result = getSandboxGatewayState("beta", "nemoclaw-8091");

    expect(result.state).toBe("present");
    expect(capture).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "get", "-g", "nemoclaw-8091", "beta"],
      expect.anything(),
    );
    expect(capture).toHaveBeenNthCalledWith(
      2,
      ["policy", "get", "-g", "nemoclaw-8091", "--full", "beta"],
      expect.anything(),
    );
  });

  it("classifies the owner-scoped Internal no-spec response as missing", () => {
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
    const capture = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 1,
      output: 'status: Internal, message: "sandbox has no spec"',
    } as never);

    expect(getSandboxGatewayState("beta", "nemoclaw-8091")).toMatchObject({
      state: "missing",
    });
    expect(capture).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-8091", "beta"],
      expect.anything(),
    );
  });

  it("pins the async status RPC to the recorded owner", async () => {
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
    vi.spyOn(openshellRuntime, "isCommandTimeout").mockReturnValue(false);
    const capture = vi
      .spyOn(openshellRuntime, "captureOpenshellForStatus")
      .mockResolvedValueOnce({ status: 0, output: "Phase: Ready" } as never)
      .mockResolvedValueOnce({ status: 1, output: "" } as never);

    const result = await getSandboxGatewayStateForStatus("beta", "nemoclaw-8091");

    expect(result.state).toBe("present");
    expect(capture).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "get", "-g", "nemoclaw-8091", "beta"],
      expect.anything(),
    );
    expect(capture).toHaveBeenNthCalledWith(
      2,
      ["policy", "get", "-g", "nemoclaw-8091", "--full", "beta"],
      expect.anything(),
    );
  });

  it("rejects endpoint routing before a status RPC can bypass the owner", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://sibling.invalid");
    const syncCapture = vi.spyOn(openshellRuntime, "captureOpenshell");
    const asyncCapture = vi.spyOn(openshellRuntime, "captureOpenshellForStatus");

    expect(getSandboxGatewayState("beta", "nemoclaw-8091")).toMatchObject({
      state: "gateway_endpoint_override",
      output: expect.stringContaining("OPENSHELL_GATEWAY_ENDPOINT is set"),
    });
    await expect(getSandboxGatewayStateForStatus("beta", "nemoclaw-8091")).resolves.toMatchObject({
      state: "gateway_endpoint_override",
      output: expect.stringContaining("OPENSHELL_GATEWAY_ENDPOINT is set"),
    });
    expect(syncCapture).not.toHaveBeenCalled();
    expect(asyncCapture).not.toHaveBeenCalled();
  });

  it("targets the registered owner on the first lookup instead of accepting ambient sibling state", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const getState = vi.fn((_name: string, gatewayName?: string) =>
      gatewayName === "nemoclaw-8091"
        ? { state: "present", output: "Phase: Ready" }
        : { state: "present", output: "Phase: Provisioning" },
    );

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(result).toMatchObject({
      state: "present",
      output: "Phase: Ready",
    });
    expect(result.recoveredGateway).toBeUndefined();
  });

  it("queries the gateway returned by selection when registry ownership changes between snapshots", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.mocked(gatewaySelect.selectSandboxOwningGateway).mockReturnValue({
      outcome: "selected",
      gatewayName: "nemoclaw-8092",
    });
    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledWith("beta", "nemoclaw-8092");
    expect(result).toMatchObject({ state: "present", output: "Phase: Ready" });
  });

  it("keeps recovery pinned to the gateway returned by selection after ownership changes", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.mocked(gatewaySelect.selectSandboxOwningGateway).mockReturnValue({
      outcome: "selected",
      gatewayName: "nemoclaw-8092",
    });
    const recover = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
      recovered: true,
      via: "start",
    } as never);
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "gateway_error", output: "transport error" })
      .mockResolvedValueOnce({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenNthCalledWith(1, "beta", "nemoclaw-8092");
    expect(recover).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-8092",
    });
    expect(getState).toHaveBeenNthCalledWith(2, "beta", "nemoclaw-8092");
    expect(result).toMatchObject({
      state: "present",
      output: "Phase: Ready",
      recoveredGateway: true,
      recoveryVia: "start",
    });
  });

  it("does not return an ambient sibling timeout without first querying the healthy owner", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const getState = vi.fn((_name: string, gatewayName?: string) =>
      gatewayName === "nemoclaw-8091"
        ? { state: "present", output: "Phase: Ready" }
        : { state: "status_probe_timeout", output: "sibling timed out" },
    );

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(result).toMatchObject({ state: "present", output: "Phase: Ready" });
  });

  it("does not return an ambient sibling unknown error without first querying the healthy owner", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    const getState = vi.fn((_name: string, gatewayName?: string) =>
      gatewayName === "nemoclaw-8091"
        ? { state: "present", output: "Phase: Ready" }
        : { state: "unknown_error", output: "sibling failed" },
    );

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(result).toMatchObject({ state: "present", output: "Phase: Ready" });
  });

  it("fails closed before lookup when the owning gateway cannot be selected", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ gatewayPort: 8091 } as never);
    vi.mocked(gatewaySelect.selectSandboxOwningGateway).mockReturnValue({
      outcome: "failed",
      gatewayName: "nemoclaw-8091",
    });
    const getState = vi.fn();

    const result = await getReconciledSandboxGatewayState("beta", { getState });

    expect(getState).not.toHaveBeenCalled();
    expect(result.state).toBe("wrong_gateway_active");
    expect(result.recoveredGateway).toBeUndefined();
  });

  it("leaves an unregistered sandbox on the existing default lookup path", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("ghost", { getState });

    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith("ghost", undefined);
    expect(result).toMatchObject({ state: "present" });
  });
});
