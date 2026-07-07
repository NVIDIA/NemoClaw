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
  runOpenshell: vi.fn(),
  stripAnsi: vi.fn((value: string) => value),
}));

vi.mock("./adapters/openshell/gateway-drift", () => ({
  detectOpenShellStateRpcPreflightIssue: mocks.detectPreflightIssue,
  detectOpenShellStateRpcResultIssue: mocks.detectResultIssue,
  printOpenShellStateRpcIssue: mocks.printIssue,
}));
vi.mock("./adapters/openshell/client", () => ({
  stripAnsi: mocks.stripAnsi,
}));
vi.mock("./adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: mocks.runOpenshell,
}));
vi.mock("./gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

import { captureSandboxListWithGatewayPreflightOrExit } from "./openshell-sandbox-list";

const context = {
  action: "checking sandbox state",
  command: "nemoclaw test-command",
};

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
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({ recovered: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [name, issue] of [
    ["gateway image drift", imageDriftIssue],
    ["host-process gateway drift", hostProcessDriftIssue],
  ] as const) {
    it(`exits before querying sandbox state for ${name}`, async () => {
      mocks.detectPreflightIssue.mockReturnValueOnce(issue);

      await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
        "process.exit(1)",
      );

      expect(mocks.printIssue).toHaveBeenCalledWith(issue, context);
      expect(mocks.captureOpenshell).not.toHaveBeenCalled();
      expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    });
  }

  it("returns the successful sandbox list without gateway recovery", async () => {
    const result = await captureSandboxListWithGatewayPreflightOrExit(context);

    expect(result).toEqual({ status: 0, output: "alpha Ready" });
    expect(mocks.captureOpenshell).toHaveBeenCalledOnce();
    expect(mocks.captureOpenshell).toHaveBeenCalledWith(["sandbox", "list"]);
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("recovers a disconnected gateway once and retries the sandbox list", async () => {
    mocks.captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" });

    const result = await captureSandboxListWithGatewayPreflightOrExit(context);

    expect(result).toEqual({ status: 0, output: "alpha Ready" });
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith({
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(2);
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(1, ["sandbox", "list"]);
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(2, ["sandbox", "list"]);
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
    expect(mocks.printIssue).toHaveBeenCalledWith(issue, context);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to query running sandboxes"),
    );
  });

  it("preserves a generic failure status from the single retry", async () => {
    mocks.captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "client error (Connect): Connection refused" })
      .mockReturnValueOnce({ status: 2, output: "unknown option: --json" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureSandboxListWithGatewayPreflightOrExit(context)).rejects.toThrow(
      "process.exit(2)",
    );

    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(2);
    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "gateway was recovered, but the sandbox query still failed",
    );
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

    expect(mocks.printIssue).toHaveBeenCalledWith(issue, context);
    expect(mocks.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to query running sandboxes"),
    );
  });
});
