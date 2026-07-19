// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import type { OpenShellSandboxControl, SandboxExecResult } from "./sandbox-control";
import { execSandboxReadOnlyWithGrpcFallback } from "./sandbox-control-routing";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

function dependencies(grpcResult: SandboxExecResult | Error, cliResult?: SandboxExecResult) {
  const close = vi.fn();
  const grpcExec = vi.fn(() =>
    grpcResult instanceof Error ? Promise.reject(grpcResult) : Promise.resolve(grpcResult),
  );
  const grpc: GrpcOpenShellSandboxControl = { close, exec: grpcExec };
  const cliExec = vi.fn(async () => cliResult ?? { status: 0, stdout: "cli", stderr: "" });
  const cli: OpenShellSandboxControl = { exec: cliExec };
  const createCli = vi.fn(() => cli);
  const createGrpc = vi.fn(() => grpc);
  const debug = vi.fn();
  return {
    close,
    grpcExec,
    cliExec,
    createCli,
    createGrpc,
    debug,
    deps: { createCli, createGrpc, debug },
  };
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

  it("does not replay a completed non-zero command through the CLI", async () => {
    const result = { status: 2, stdout: "", stderr: "unknown flag" };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("retries a pre-dispatch gRPC lookup failure through the requested gateway", async () => {
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

    expect(test.createCli).toHaveBeenCalledWith("nemoclaw");
    expect(test.cliExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("before dispatch"), grpcError);
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("does not replay a post-dispatch gRPC stream failure", async () => {
    const grpcError = new Error("stream reset");
    const result = { status: null, stdout: "partial", stderr: "", error: grpcError };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("does not replay a rejected gRPC execution through the CLI", async () => {
    const error = new Error("stream rejected after dispatch");
    const test = dependencies(error);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual({ status: null, stdout: "", stderr: "", error });

    expect(test.grpcExec).toHaveBeenCalledOnce();
    expect(test.createCli).not.toHaveBeenCalled();
    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("retries a rejected explicit pre-dispatch failure through the requested gateway", async () => {
    const cause = new Error("UNAVAILABLE");
    const test = dependencies(new OpenShellGrpcPreDispatchError(cause));

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw-9090", request, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "cli", stderr: "" });

    expect(test.createCli).toHaveBeenCalledWith("nemoclaw-9090");
    expect(test.cliExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("before dispatch"), cause);
    expect(test.close).toHaveBeenCalledOnce();
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
    expect(test.createCli).toHaveBeenCalledWith("edge");
    expect(test.cliExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
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
