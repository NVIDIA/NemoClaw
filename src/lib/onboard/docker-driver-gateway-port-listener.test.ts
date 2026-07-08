// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createDockerDriverGatewayPortListenerHelpers,
  type DockerDriverGatewayPortListenerDeps,
} from "./docker-driver-gateway-port-listener";

function makeHelpers(overrides: Partial<DockerDriverGatewayPortListenerDeps> = {}) {
  const runCaptureEx = vi.fn(() => ({ stdout: "", exitCode: 1, timedOut: false }));
  const deps: DockerDriverGatewayPortListenerDeps = {
    gatewayPort: 18080,
    runCaptureEx,
    isPidAlive: () => true,
    isDockerDriverGatewayProcess: () => true,
    ...overrides,
  };
  return {
    helpers: createDockerDriverGatewayPortListenerHelpers(deps),
    runCaptureEx: deps.runCaptureEx,
  };
}

describe("Docker-driver gateway port listener discovery", () => {
  it("rejects a primary listener when the injected gateway identity check fails", () => {
    const { helpers } = makeHelpers();
    const isDockerDriverGatewayProcessFn = vi.fn(() => false);

    expect(
      helpers.getDockerDriverGatewayPortListenerPid(
        { ok: false, process: "openshell-gateway", pid: 1234 },
        {
          platform: "linux",
          gatewayBin: "/opt/openshell/openshell-gateway",
          isPidAliveFn: () => true,
          isDockerDriverGatewayProcessFn,
        },
      ),
    ).toBeNull();
    expect(isDockerDriverGatewayProcessFn).toHaveBeenCalledWith(
      1234,
      "/opt/openshell/openshell-gateway",
    );
  });

  it("collects every verified gateway listener on the configured port", () => {
    const gatewayBin = "/opt/openshell/openshell-gateway";
    const runCaptureEx = vi.fn(() => ({
      stdout: "1234\n2345\n9999\n",
      exitCode: 0,
      timedOut: false,
    }));
    const { helpers } = makeHelpers({ runCaptureEx });
    const isDockerDriverGatewayProcessFn = vi.fn(
      (pid: number, candidateBin?: string | null) =>
        (pid === 1234 || pid === 2345) && candidateBin === gatewayBin,
    );

    expect(
      helpers.getDockerDriverGatewayPortListenerScan(
        { ok: false, process: "openshell-gateway", pid: 1234 },
        {
          platform: "linux",
          gatewayBin,
          isPidAliveFn: () => true,
          isDockerDriverGatewayProcessFn,
        },
      ),
    ).toEqual({ complete: true, pids: [1234, 2345] });
    expect(runCaptureEx).toHaveBeenCalledWith(["lsof", "-ti", ":18080", "-sTCP:LISTEN"]);
  });

  it("retains a verified primary PID when complete enumeration fails", () => {
    const { helpers } = makeHelpers({
      runCaptureEx: vi.fn(() => ({ stdout: "", exitCode: 127, timedOut: false })),
    });

    expect(
      helpers.getDockerDriverGatewayPortListenerScan(
        { ok: false, process: "openshell-gateway", pid: 1234 },
        {
          platform: "linux",
          isPidAliveFn: () => true,
          isDockerDriverGatewayProcessFn: () => true,
        },
      ),
    ).toEqual({ complete: false, pids: [1234] });
  });

  it("treats empty lsof output as incomplete while the independent port probe is busy", () => {
    const { helpers } = makeHelpers();

    expect(
      helpers.getDockerDriverGatewayPortListenerScan({
        ok: false,
        pid: null,
        reason: "bind probe reported EADDRINUSE",
      }),
    ).toEqual({ complete: false, pids: [] });
  });

  it("marks listener enumeration incomplete when the structured runner throws", () => {
    const { helpers } = makeHelpers({
      runCaptureEx: vi.fn(() => {
        throw new Error("lsof unavailable");
      }),
    });

    expect(helpers.getDockerDriverGatewayPortListenerScan({ ok: true })).toEqual({
      complete: false,
      pids: [],
    });
  });

  it("resolves a dynamic gateway port for every listener scan", () => {
    let gatewayPort = 18080;
    const runCaptureEx = vi.fn(() => ({ stdout: "", exitCode: 1, timedOut: false }));
    const { helpers } = makeHelpers({ gatewayPort: () => gatewayPort, runCaptureEx });

    helpers.getDockerDriverGatewayPortListenerScan({ ok: true });
    gatewayPort = 18081;
    helpers.getDockerDriverGatewayPortListenerScan({ ok: true });

    expect(runCaptureEx).toHaveBeenNthCalledWith(1, ["lsof", "-ti", ":18080", "-sTCP:LISTEN"]);
    expect(runCaptureEx).toHaveBeenNthCalledWith(2, ["lsof", "-ti", ":18081", "-sTCP:LISTEN"]);
  });
});
