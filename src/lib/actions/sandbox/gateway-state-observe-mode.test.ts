// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayRuntime from "../../gateway-runtime-action";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as portableAgentLifecycle from "../../onboard/experimental/portable-agent-lifecycle";
import * as registry from "../../state/registry";
import * as gatewaySelect from "./gateway-select";
import {
  captureHermesPortableInferenceRecoveryGateway,
  getReconciledSandboxGatewayState,
  recoverPortableDemoSandboxLifecycleForConnect,
} from "./gateway-state";

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

  it("keeps receipt-owned observation scoped without changing global gateway selection (#9203)", async () => {
    const getState = vi.fn().mockResolvedValue({ state: "present", output: "Phase: Ready" });

    const result = await getReconciledSandboxGatewayState("beta", {
      getState,
      gatewayRecovery: "observe",
      selectOwningGateway: false,
    });

    expect(gatewaySelect.selectSandboxOwningGateway).not.toHaveBeenCalled();
    expect(getState).toHaveBeenCalledWith("beta", "nemoclaw-8091");
    expect(result).toMatchObject({ state: "present" });
  });
});

describe("Hermes Portable inference recovery gateway", () => {
  it("rejects command environment drift before executable qualification", () => {
    expect(() =>
      captureHermesPortableInferenceRecoveryGateway("alpha", ["provider", "get", "ollama"], {
        env: { UNEXPECTED: "value" },
        timeout: 1_000,
      }),
    ).toThrow("rejected command environment drift");
  });
});

describe("Hermes Portable lifecycle recovery command authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses transaction currentness for intermediate captures and full currentness at recovery boundaries", () => {
    const assertCurrent = vi.fn();
    const assertTransactionCurrent = vi.fn();
    const capture = vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    } as never);
    const recover = vi
      .spyOn(portableAgentLifecycle, "recoverPortableAgentSandboxLifecycle")
      .mockImplementation((_sandboxName, _context, deps) => {
        const recoveryDeps = deps!;
        recoveryDeps.assertOpenShellExecutableAuthority?.({} as never, {}, {});
        recoveryDeps.captureOpenshell?.(["sandbox", "exec", "--", "true"], 1_000);
        recoveryDeps.captureOpenshell?.(["sandbox", "exec", "--", "health"], 1_000);
        recoveryDeps.assertOpenShellExecutableAuthority?.({} as never, {}, {});
        return { kind: "recovered" };
      });

    expect(
      recoverPortableDemoSandboxLifecycleForConnect(
        "alpha",
        {
          name: "alpha",
          agent: "hermes",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
        } as never,
        "nemoclaw",
        {
          assertCurrent,
          assertTransactionCurrent,
          receipt: {} as never,
          env: { HOME: "/home/test" },
          executablePath: "/usr/bin/openshell",
        },
      ),
    ).toEqual({ kind: "recovered" });

    expect(recover).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    expect(assertTransactionCurrent).toHaveBeenCalledTimes(4);
  });

  it("rejects transaction drift around an intermediate capture", () => {
    const assertCurrent = vi.fn();
    const assertTransactionCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("transaction authority changed");
      });
    vi.spyOn(openshellRuntime, "captureResolvedOpenshell").mockReturnValue({
      status: 0,
      output: "",
      stdout: "",
      stderr: "",
    } as never);
    vi.spyOn(portableAgentLifecycle, "recoverPortableAgentSandboxLifecycle").mockImplementation(
      (_sandboxName, _context, deps) => {
        deps!.captureOpenshell?.(["sandbox", "exec", "--", "true"], 1_000);
        return { kind: "recovered" };
      },
    );

    expect(() =>
      recoverPortableDemoSandboxLifecycleForConnect(
        "alpha",
        {
          name: "alpha",
          agent: "hermes",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
        } as never,
        "nemoclaw",
        {
          assertCurrent,
          assertTransactionCurrent,
          receipt: {} as never,
          env: { HOME: "/home/test" },
          executablePath: "/usr/bin/openshell",
        },
      ),
    ).toThrow("transaction authority changed");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
