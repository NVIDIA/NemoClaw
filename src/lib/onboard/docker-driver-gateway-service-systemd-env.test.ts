// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { spawnResult, nonSymlinkStat, systemdSpawn } from "./__test-helpers__/gateway-service";
import {
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  type SpawnSyncLike,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

describe("systemd user service environment", () => {
  it.each([
    [undefined, undefined, "/run/user/1234", "unix:path=/run/user/1234/bus"],
    ["", "", "/run/user/1234", "unix:path=/run/user/1234/bus"],
    ["/custom/runtime", undefined, "/custom/runtime", "unix:path=/custom/runtime/bus"],
    [undefined, "unix:path=/custom/bus", "/run/user/1234", "unix:path=/custom/bus"],
    ["/custom/runtime", "unix:path=/custom/bus", "/custom/runtime", "unix:path=/custom/bus"],
  ])(
    "supplies the systemd user environment without changing configured values [case %#]",
    (runtime, bus, expectedRuntime, expectedBus) => {
      vi.spyOn(process, "getuid").mockReturnValue(1234);
      vi.stubEnv("NVIDIA_API_KEY", "host-only-test-value");
      const home = "/home/nvidia";
      const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
      const env = {
        HOME: home,
        LC_ALL: "fr_FR",
        SUDO_UID: "9999",
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: bus,
      };
      const original = { ...env };
      const spawnSyncImpl = vi.fn<SpawnSyncLike>(
        systemdSpawn([], servicePath, `${home}/.local/bin/openshell-gateway`),
      );
      const result = startOpenShellGatewayUserService({
        commandExists: (command) => command === "systemctl",
        env,
        existsSync: (candidate) => candidate === servicePath,
        home,
        lstatSync: nonSymlinkStat,
        platform: "linux",
        readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
        spawnSyncImpl,
      });
      expect(result).toMatchObject({ started: true, manager: "systemd" });
      expect(spawnSyncImpl).toHaveBeenCalled();
      expect(spawnSyncImpl.mock.calls).toEqual(
        Array(spawnSyncImpl.mock.calls.length).fill([
          "systemctl",
          expect.any(Array),
          expect.objectContaining({
            env: {
              ...env,
              LC_ALL: "C",
              XDG_RUNTIME_DIR: expectedRuntime,
              DBUS_SESSION_BUS_ADDRESS: expectedBus,
            },
          }),
        ]),
      );
      expect(env).toEqual(original);
    },
  );

  it("retains systemd startup failure with a derived current-user bus", () => {
    vi.spyOn(process, "getuid").mockReturnValue(4321);
    const env = { HOME: "/home/nvidia" };
    const spawnSyncImpl = vi.fn<SpawnSyncLike>(() =>
      spawnResult(1, "Failed to connect to bus: No medium found"),
    );
    const result = startOpenShellGatewayUserService({
      commandExists: (command) => command === "systemctl",
      env,
      existsSync: (candidate) => candidate === "/lib/systemd/user/openshell-gateway.service",
      getUpstreamGatewayVersion: () => "0.0.85",
      getUpstreamGatewayVersionBounds: () => ({ min: "0.0.85", max: "0.0.85" }),
      platform: "linux",
      spawnSyncImpl,
    });
    expect(result).toMatchObject({ started: false });
    expect(result.reason).toContain("Failed to connect to bus");
    expect(spawnSyncImpl.mock.calls.every(([, args]) => !args.includes("restart"))).toBe(true);
    expect(spawnSyncImpl.mock.calls).toEqual(
      Array(spawnSyncImpl.mock.calls.length).fill([
        "systemctl",
        expect.any(Array),
        expect.objectContaining({
          env: {
            ...env,
            LC_ALL: "C",
            XDG_RUNTIME_DIR: "/run/user/4321",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4321/bus",
          },
        }),
      ]),
    );
    expect(env).toEqual({ HOME: "/home/nvidia" });
  });
});
