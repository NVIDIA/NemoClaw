// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  hasOpenShellGatewayUserService,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
  type SpawnSyncLikeResult,
} from "./openshell-gateway-user-service";

function trustedShowOutput(
  fragmentPath = "/lib/systemd/user/openshell-gateway.service",
  execPath = "/usr/bin/openshell-gateway",
): string {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${execPath} ; argv[]=${execPath} ; }`,
  ].join("\n");
}

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return {
    error: undefined,
    status,
    stderr,
    stdout,
  };
}

describe("OpenShell gateway user service", () => {
  it("detects the upstream OpenShell user service only on Linux", () => {
    const existsSync = (candidate: string) =>
      candidate === "/usr/lib/systemd/user/openshell-gateway.service";

    expect(hasOpenShellGatewayUserService({ existsSync, platform: "linux" })).toBe(true);
    expect(hasOpenShellGatewayUserService({ existsSync, platform: "darwin" })).toBe(false);
    expect(getOpenShellGatewayUserServicePaths()).toEqual([
      "/usr/local/lib/systemd/user/openshell-gateway.service",
      "/usr/lib/systemd/user/openshell-gateway.service",
      "/lib/systemd/user/openshell-gateway.service",
    ]);
    expect(getOpenShellGatewayUserServiceBinaryPaths()).toEqual([
      "/usr/local/bin/openshell-gateway",
      "/usr/bin/openshell-gateway",
    ]);
  });

  it("ignores stale per-user service units so standalone fallback remains available", () => {
    const existsSync = vi.fn(
      (candidate: string) =>
        candidate === "/home/nvidia/.config/systemd/user/openshell-gateway.service",
    );

    expect(hasOpenShellGatewayUserService({ existsSync, platform: "linux" })).toBe(false);
    expect(existsSync.mock.calls.flat()).not.toContain(
      "/home/nvidia/.config/systemd/user/openshell-gateway.service",
    );
  });

  it("restarts the upstream user service with systemctl --user after validating identity", () => {
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args[1] ?? args[0] ?? "");
      return args.includes("show") ? spawnResult(0, "", trustedShowOutput()) : spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      prepareServiceEnv: () => events.push("prepare-env"),
      spawnSyncImpl,
    });

    expect(result).toEqual({ attempted: true, fallbackAllowed: false, started: true });
    expect(events).toEqual(["daemon-reload", "show", "prepare-env", "enable", "restart"]);
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      [
        "systemctl",
        ["--user", "show", "openshell-gateway", "--property=FragmentPath", "--property=ExecStart"],
      ],
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
        args.includes("daemon-reload") ? spawnResult(1, "Failed to connect to bus") : spawnResult(),
      ),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("Failed to connect to bus");
  });

  it("allows standalone fallback when restart loses the user systemd manager", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "Failed to connect to bus");
        return spawnResult();
      }),
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
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "Job failed");
        return spawnResult();
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("Job failed");
  });

  it("does not treat missing service executables as user-manager outages", () => {
    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl: vi.fn((_command: string, args: string[]) => {
        if (args.includes("show")) return spawnResult(0, "", trustedShowOutput());
        if (args.includes("restart")) return spawnResult(1, "No such file or directory");
        return spawnResult();
      }),
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: false,
      started: false,
    });
    expect(result.reason).toContain("No such file or directory");
  });

  it("falls back instead of trusting an unverified service identity", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.includes("show")) {
        return spawnResult(
          0,
          "",
          trustedShowOutput("/home/nvidia/.config/systemd/user/openshell-gateway.service"),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("not the package-managed OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user restart openshell-gateway",
    );
  });

  it("falls back instead of trusting package units that execute untrusted wrappers", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.includes("show")) {
        return spawnResult(
          0,
          "",
          trustedShowOutput(
            "/lib/systemd/user/openshell-gateway.service",
            "/tmp/openshell-gateway",
          ),
        );
      }
      return spawnResult();
    });

    const result = startOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({
      attempted: true,
      fallbackAllowed: true,
      started: false,
    });
    expect(result.reason).toContain("not the package-managed OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user restart openshell-gateway",
    );
  });

  it("stops the upstream user service with systemctl --user after validating identity", () => {
    const events: string[] = [];
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      events.push(args[1] ?? args[0] ?? "");
      return args.includes("show") ? spawnResult(0, "", trustedShowOutput()) : spawnResult();
    });

    const result = stopOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env: {},
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toEqual({ attempted: true, stopped: true });
    expect(events).toEqual(["show", "stop"]);
    expect(spawnSyncImpl.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        "systemctl",
        ["--user", "show", "openshell-gateway", "--property=FragmentPath", "--property=ExecStart"],
      ],
      ["systemctl", ["--user", "stop", "openshell-gateway"]],
    ]);
  });

  it("refuses to stop an untrusted user unit", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
      args.includes("show")
        ? spawnResult(
            0,
            "",
            trustedShowOutput("/home/nvidia/.config/systemd/user/openshell-gateway.service"),
          )
        : spawnResult(),
    );

    const result = stopOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({ attempted: true, stopped: false });
    expect(result.reason).toContain("not the package-managed OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user stop openshell-gateway",
    );
  });

  it("refuses to stop a package unit that executes an untrusted wrapper", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
      args.includes("show")
        ? spawnResult(
            0,
            "",
            trustedShowOutput(
              "/lib/systemd/user/openshell-gateway.service",
              "/tmp/openshell-gateway",
            ),
          )
        : spawnResult(),
    );

    const result = stopOpenShellGatewayUserService({
      commandExists: () => true,
      env: {},
      existsSync: () => true,
      platform: "linux",
      spawnSyncImpl,
    });

    expect(result).toMatchObject({ attempted: true, stopped: false });
    expect(result.reason).toContain("not the package-managed OpenShell gateway");
    expect(spawnSyncImpl.mock.calls.map(([, args]) => args.join(" "))).not.toContain(
      "--user stop openshell-gateway",
    );
  });
});
