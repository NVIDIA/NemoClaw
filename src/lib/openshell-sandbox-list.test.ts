// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenShellStateRpcIssue } from "./adapters/openshell/gateway-drift";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  detectPreflightIssue: vi.fn(),
  detectResultIssue: vi.fn(),
  printIssue: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn(),
}));

vi.mock("./adapters/openshell/gateway-drift", () => ({
  detectOpenShellStateRpcPreflightIssue: mocks.detectPreflightIssue,
  detectOpenShellStateRpcResultIssue: mocks.detectResultIssue,
  printOpenShellStateRpcIssue: mocks.printIssue,
}));
vi.mock("./adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
}));
vi.mock("./gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

import {
  captureNamedGatewaySandboxListReadOnly,
  captureSandboxListWithGatewayPreflightOrExit,
  captureSandboxListWithGatewayRecovery,
} from "./openshell-sandbox-list";
import type {
  OpenShellSandboxInventory,
  OpenShellSandboxObserver,
  OpenShellSandboxResult,
} from "./adapters/openshell/sandbox-observer";

const context = {
  action: "checking sandbox state",
  command: "nemoclaw test-command",
};

function observerReturning(
  result: OpenShellSandboxResult<OpenShellSandboxInventory>,
): OpenShellSandboxObserver {
  return { listSandboxes: vi.fn().mockResolvedValue(result) };
}

const imageDriftIssue: OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

const hostProcessDriftIssue: OpenShellStateRpcIssue = {
  kind: "host_process_drift",
  drift: {
    gatewayBin: "/home/u/.local/bin/openshell-gateway",
    currentVersion: "0.0.43",
    expectedVersion: "0.0.44",
  },
};

describe("sandbox list gateway preflight and recovery (#6237)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectPreflightIssue.mockReturnValue(null);
    mocks.detectResultIssue.mockReturnValue(null);
    mocks.captureOpenshell.mockReturnValue({ status: 0, output: "alpha Ready" });
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true, attempted: false });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "gateway image drift", issue: imageDriftIssue },
    { name: "host-process gateway drift", issue: hostProcessDriftIssue },
  ])("exits before querying sandbox state for $name", async ({ issue }) => {
    mocks.detectPreflightIssue.mockReturnValueOnce(issue);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mocks.printIssue).toHaveBeenCalledWith(issue, context);
    expect(mocks.captureOpenshell).not.toHaveBeenCalled();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("returns the successful sandbox list without gateway recovery", async () => {
    const result = await captureSandboxListWithGatewayPreflightOrExit(context);

    expect(result).toEqual({
      sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
    });
    expect(mocks.captureOpenshell).toHaveBeenCalledOnce();
    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "list"],
      expect.objectContaining({ ignoreError: true, includeStreams: true, timeout: 15_000 }),
    );
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("recovers a retired named gateway before sandbox observation (#10421)", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true, attempted: true });
    const listSandboxes = vi.fn(async () =>
      mocks.recoverNamedGatewayRuntime.mock.calls.length === 0
        ? {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "failed" as const,
              message: "The OpenShell sandbox observation failed.",
            },
          }
        : {
            ok: true as const,
            value: {
              sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" as const }],
            },
          },
    );

    const result = await captureSandboxListWithGatewayRecovery({
      gatewayName: "nemoclaw-12345",
      observer: { listSandboxes },
    });

    expect(result).toEqual({
      result: {
        ok: true,
        value: {
          sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
        },
      },
      recoveryAttempted: true,
      recoverySucceeded: true,
    });
    const expectedRecoveryOptions = {
      gatewayName: "nemoclaw-12345",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    };
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith(expectedRecoveryOptions);
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(mocks.recoverNamedGatewayRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      listSandboxes.mock.invocationCallOrder[0]!,
    );
  });

  it("checks a named gateway that needs no recovery before sandbox observation (#6114)", async () => {
    const options = { gatewayName: "nemoclaw-12345" };
    mocks.captureOpenshell.mockReturnValue({ status: 0, output: "alpha Ready" });

    await expect(captureSandboxListWithGatewayPreflightOrExit(context, options)).resolves.toEqual({
      sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
    });

    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-12345"],
      expect.anything(),
    );
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-12345",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(mocks.recoverNamedGatewayRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.captureOpenshell.mock.invocationCallOrder[0]!,
    );
  });

  it("recovers a disconnected gateway once and retries the sandbox list", async () => {
    mocks.captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" });

    const result = await captureSandboxListWithGatewayPreflightOrExit(context);

    expect(result).toEqual({
      sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
    });
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith({
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(2);
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "list"],
      expect.anything(),
    );
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "list"],
      expect.anything(),
    );
  });

  it("classifies protobuf mismatch from the retry before generic failure handling", async () => {
    const issue: OpenShellStateRpcIssue = {
      kind: "protobuf_mismatch",
      output: "Sandbox.metadata: invalid wire type value: 6",
    };
    mocks.captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 1, output: issue.output });
    mocks.detectResultIssue.mockReturnValueOnce(null).mockReturnValueOnce(issue);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(2);
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(mocks.printIssue).toHaveBeenCalledWith(
      { kind: "protobuf_mismatch", drift: null, output: "" },
      context,
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to query running sandboxes"),
    );
  });

  it("preserves invalid-request exit behavior from the single retry", async () => {
    mocks.captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 2, output: "unknown option: --json" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(2)",
    );

    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(2);
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    const diagnostics = errorSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("gateway was recovered, but the sandbox query still failed");
    expect(diagnostics).toContain(
      "kind=command; reason=invalid_request; gateway recovery attempted=yes",
    );
    expect(diagnostics).toContain("The OpenShell sandbox observation failed.");
    expect(diagnostics).not.toContain("unknown option: --json");
  });

  it("exits with recovery guidance when gateway recovery does not complete", async () => {
    const initial = { status: 1, output: "client error (Connect): Connection refused" };
    mocks.captureOpenshell.mockReturnValue(initial);
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mocks.captureOpenshell).toHaveBeenCalledOnce();
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("recovery did not complete");
  });

  it("does not recover a generic sandbox-list failure", async () => {
    mocks.captureOpenshell.mockReturnValue({ status: 2, output: "unknown option: --json" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(2)",
    );

    expect(mocks.captureOpenshell).toHaveBeenCalledOnce();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Failed to query running sandboxes");
  });

  it.each([
    {
      label: "authentication",
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
    },
    {
      label: "schema validation",
      error: {
        kind: "schema",
        message: "The OpenShell CLI and gateway sandbox schemas do not match.",
      },
    },
    {
      label: "gateway identity validation",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
    },
    {
      label: "request validation",
      error: {
        kind: "command",
        reason: "invalid_request",
        message: "OpenShell rejected the sandbox observation request.",
      },
    },
  ] as const)(
    "does not retry named gateway recovery when $label fails (#10421)",
    async ({ error }) => {
      const result = { ok: false, error } as const;
      const observer = observerReturning(result);

      await expect(
        captureSandboxListWithGatewayRecovery({
          gatewayName: "nemoclaw-12345",
          observer,
        }),
      ).resolves.toEqual({
        result,
        recoveryAttempted: false,
        recoverySucceeded: false,
      });
      expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
      expect(observer.listSandboxes).toHaveBeenCalledOnce();
    },
  );

  it("does not observe sandbox inventory when named gateway recovery fails (#10421)", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: false, attempted: true });
    const observer = observerReturning({ ok: true, value: { sandboxes: [] } });

    await expect(
      captureSandboxListWithGatewayRecovery({
        gatewayName: "nemoclaw-12345",
        observer,
      }),
    ).resolves.toEqual({
      result: {
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: "OpenShell could not reach the selected gateway.",
        },
      },
      recoveryAttempted: true,
      recoverySucceeded: false,
    });
    expect(observer.listSandboxes).not.toHaveBeenCalled();
  });

  it("does not repeat a completed named gateway recovery after observation fails (#10421)", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true, attempted: true });
    const result = {
      ok: false,
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
    } as const;
    const observer = observerReturning(result);

    await expect(
      captureSandboxListWithGatewayRecovery({
        gatewayName: "nemoclaw-12345",
        observer,
      }),
    ).resolves.toEqual({
      result,
      recoveryAttempted: true,
      recoverySucceeded: true,
    });
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(observer.listSandboxes).toHaveBeenCalledOnce();
  });

  it("classifies protobuf mismatch before recovery or generic failure handling", async () => {
    const issue: OpenShellStateRpcIssue = {
      kind: "protobuf_mismatch",
      output: "Sandbox.metadata: invalid wire type value: 6",
    };
    mocks.captureOpenshell.mockReturnValue({ status: 1, output: issue.output });
    mocks.detectResultIssue.mockReturnValue(issue);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(mocks.printIssue).toHaveBeenCalledWith(
      { kind: "protobuf_mismatch", drift: null, output: "" },
      context,
    );
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to query running sandboxes"),
    );
  });
});

describe("read-only named-gateway sandbox list (#7279)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectPreflightIssue.mockReturnValue(null);
    mocks.detectResultIssue.mockReturnValue(null);
    mocks.captureOpenshell.mockReturnValue({ status: 0, output: "alpha Ready" });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the named gateway with -g and never recovers or selects", async () => {
    const result = await captureNamedGatewaySandboxListReadOnly(context, "nemoclaw-18080");

    expect(mocks.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-18080"],
      expect.objectContaining({ ignoreError: true, includeStreams: true, timeout: 15_000 }),
    );
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(result).toEqual({
      sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
    });
  });

  it("stays non-fatal when the recorded gateway is down", async () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      output: "tcp connect error: Connection refused",
    });

    const result = await captureNamedGatewaySandboxListReadOnly(context, "nemoclaw-18080");

    expect(result).toEqual({ sandboxes: [] });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "authentication",
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
      exitCode: 1,
    },
    {
      label: "identity mismatch",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
      exitCode: 1,
    },
    {
      label: "invalid command",
      error: {
        kind: "command",
        reason: "invalid_request",
        message: "OpenShell rejected the sandbox observation request.",
      },
      exitCode: 2,
    },
  ] as const)(
    "fails closed on a $label observation failure (#9803)",
    async ({ error, exitCode }) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        captureNamedGatewaySandboxListReadOnly(
          context,
          "nemoclaw-18080",
          observerReturning({ ok: false, error }),
        ),
      ).rejects.toThrow(`process.exit(${exitCode})`);

      expect(errorSpy.mock.calls.flat().join("\n")).toContain(error.message);
      expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    },
  );

  it("still exits on a state-RPC result drift issue", async () => {
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      output: "Sandbox.metadata: invalid wire type value: 6",
    });

    await expect(captureNamedGatewaySandboxListReadOnly(context, "nemoclaw-18080")).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mocks.printIssue).toHaveBeenCalledWith(
      { kind: "protobuf_mismatch", drift: null, output: "" },
      context,
    );
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
  });

  it("exits before listing on a preflight drift issue", async () => {
    mocks.detectPreflightIssue.mockReturnValue(hostProcessDriftIssue);

    await expect(captureNamedGatewaySandboxListReadOnly(context, "nemoclaw-18080")).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mocks.captureOpenshell).not.toHaveBeenCalled();
  });
});
