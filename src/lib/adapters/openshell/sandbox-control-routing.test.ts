// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { OpenShellGrpcEdgeTunnelRequiredError } from "./grpc-gateway-config";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcOutputLimitError,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import type { OpenShellSandboxControl, SandboxExecResult } from "./sandbox-control";
import {
  execSandboxReadOnlyWithGrpcFallback,
  selectOpenShellSandboxControlForMutation,
} from "./sandbox-control-routing";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

function dependencies(grpcResult: SandboxExecResult | Error, cliResult?: SandboxExecResult) {
  const close = vi.fn();
  const grpcExec = vi.fn(() =>
    grpcResult instanceof Error ? Promise.reject(grpcResult) : Promise.resolve(grpcResult),
  );
  const grpc: GrpcOpenShellSandboxControl = { close, exec: grpcExec };
  const cliExec = vi.fn(async () => cliResult ?? { status: 0, stdout: "cli", stderr: "" });
  const cli: OpenShellSandboxControl = { exec: cliExec };
  const createGrpc = vi.fn(() => grpc);
  const debug = vi.fn();
  return { close, grpcExec, cliExec, createGrpc, debug, deps: { cli, createGrpc, debug } };
}

const request = {
  sandboxName: "alpha",
  command: ["openclaw", "sessions", "list"] as const,
  maxOutputBytes: 4096,
};

describe("read-only OpenShell sandbox control routing", () => {
  it("uses direct gRPC with a bounded deadline", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw-9090", request, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "grpc", stderr: "" });

    expect(test.createGrpc).toHaveBeenCalledWith("nemoclaw-9090");
    expect(test.grpcExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("preserves binary stdout across the direct route", async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const result = { status: 0, stdout: "", stdoutBytes: bytes, stderr: "" };
    const test = dependencies(result);
    const binaryRequest = { ...request, stdoutEncoding: "buffer" as const };

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", binaryRequest, test.deps),
    ).resolves.toEqual(result);
    expect(test.grpcExec).toHaveBeenCalledWith({
      ...binaryRequest,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
  });

  it("does not replay a completed non-zero command through the CLI", async () => {
    const result = { status: 2, stdout: "", stderr: "unknown flag" };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("retries a pre-dispatch gRPC lookup failure without forwarding its deadline", async () => {
    const grpcError = new Error("UNAVAILABLE");
    const cliResult = { status: 0, stdout: "cli", stderr: "" };
    const test = dependencies(
      {
        status: null,
        stdout: "",
        stderr: "",
        error: new OpenShellGrpcPreDispatchError(grpcError),
      },
      cliResult,
    );

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(cliResult);

    expect(test.cliExec).toHaveBeenCalledWith(request);
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("before dispatch"), grpcError);
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("retries a post-dispatch gRPC stream failure because the command is read-only", async () => {
    const grpcError = new Error("stream reset");
    const result = { status: null, stdout: "partial", stderr: "", error: grpcError };
    const cliResult = { status: 0, stdout: "cli", stderr: "" };
    const test = dependencies(result, cliResult);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(cliResult);

    expect(test.cliExec).toHaveBeenCalledWith(request);
    expect(test.debug).toHaveBeenCalledWith(
      expect.stringContaining("read-only exec failed"),
      grpcError,
    );
  });

  it("does not retry a local gRPC output limit failure", async () => {
    const error = new OpenShellGrpcOutputLimitError(4096);
    const result = { status: null, stdout: "partial", stderr: "", error };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("uses the CLI when gateway configuration cannot create a gRPC client", async () => {
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });
    const error = new Error("edge tunnel required");
    test.createGrpc.mockImplementation(() => {
      throw error;
    });

    await expect(execSandboxReadOnlyWithGrpcFallback("edge", request, test.deps)).resolves.toEqual({
      status: 0,
      stdout: "cli",
      stderr: "",
    });

    expect(test.grpcExec).not.toHaveBeenCalled();
    expect(test.cliExec).toHaveBeenCalledWith(request);
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("configuration failed"), error);
  });

  it("does not let close failures replace a successful result", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });
    const closeError = new Error("close failed");
    test.close.mockImplementation(() => {
      throw closeError;
    });

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", { ...request, timeoutMs: 0 }, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "grpc", stderr: "" });

    expect(test.grpcExec).toHaveBeenCalledWith({ ...request, timeoutMs: 0 });
    expect(test.debug).toHaveBeenCalledWith(
      "OpenShell direct gRPC client close failed",
      closeError,
    );
  });
});

describe("mutating OpenShell sandbox control routing", () => {
  it("selects direct gRPC before a mutation and exposes its close hook", () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });

    const selected = selectOpenShellSandboxControlForMutation("nemoclaw", test.deps);

    expect(selected).toMatchObject({ control: expect.any(Object), transport: "grpc" });
    expect(selected.control).not.toBe(test.deps.cli);
    selected.close();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("preselects the CLI only for the edge-tunnel auth mode", () => {
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });
    test.createGrpc.mockImplementation(() => {
      throw new OpenShellGrpcEdgeTunnelRequiredError();
    });

    const selected = selectOpenShellSandboxControlForMutation("edge", test.deps);

    expect(selected).toEqual({
      control: test.deps.cli,
      transport: "cli-edge-tunnel",
      close: expect.any(Function),
    });
    selected.close();
    expect(test.close).not.toHaveBeenCalled();
  });

  it("does not turn a completed mutation into failure when the client cannot close", () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });
    const error = new Error("close failed");
    test.close.mockImplementation(() => {
      throw error;
    });
    const selected = selectOpenShellSandboxControlForMutation("nemoclaw", test.deps);

    expect(() => selected.close()).not.toThrow();
    expect(test.debug).toHaveBeenCalledWith("OpenShell direct gRPC client close failed", error);
  });

  it("fails before dispatch for every other direct-client configuration error", () => {
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });
    const error = new Error("invalid mTLS material");
    test.createGrpc.mockImplementation(() => {
      throw error;
    });

    expect(() => selectOpenShellSandboxControlForMutation("nemoclaw", test.deps)).toThrow(error);
    expect(test.cliExec).not.toHaveBeenCalled();
  });
});
