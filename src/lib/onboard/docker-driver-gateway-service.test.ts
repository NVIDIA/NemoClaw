// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getOpenShellGatewayUserServicePaths,
  hasOpenShellGatewayUserService,
  startOpenShellGatewayUserService,
  type SpawnSyncLikeResult,
} from "./docker-driver-gateway-service";

function spawnResult(status = 0, stderr = ""): SpawnSyncLikeResult {
  return {
    error: undefined,
    status,
    stderr,
    stdout: "",
  };
}

describe("docker-driver-gateway-service", () => {
  it("detects the upstream OpenShell user service only on Linux", () => {
    const homeDir = "/home/nvidia";
    const existsSync = (candidate: string) =>
      candidate === "/usr/lib/systemd/user/openshell-gateway.service";

    expect(hasOpenShellGatewayUserService({ existsSync, homeDir, platform: "linux" })).toBe(true);
    expect(hasOpenShellGatewayUserService({ existsSync, homeDir, platform: "darwin" })).toBe(false);
    expect(getOpenShellGatewayUserServicePaths(homeDir)).toContain(
      "/home/nvidia/.config/systemd/user/openshell-gateway.service",
    );
  });

  it("restarts the upstream user service with systemctl --user", () => {
    const spawnSyncImpl = vi.fn((_command: string, _args: string[]) => spawnResult());

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toEqual({ attempted: true, fallbackAllowed: false, started: true });
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "openshell-gateway"]],
      ["systemctl", ["--user", "restart", "openshell-gateway"]],
    ]);
  });

  it("allows standalone fallback when the user systemd manager is unavailable", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        Array.isArray(args) && args.includes("daemon-reload")
          ? spawnResult(1, "Failed to connect to bus")
          : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("Failed to connect to bus");
  });

  it("does not silently fall back when the installed service fails to restart", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) =>
        Array.isArray(args) && args.includes("restart")
          ? spawnResult(1, "Job failed")
          : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("Job failed");
  });
});
