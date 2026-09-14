// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

const home = "/home/nvidia";
const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
const gatewayBin = `${home}/.local/bin/openshell-gateway`;
const currentUserId = process.getuid?.();

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function systemdSpawn(): ReturnType<typeof vi.fn<SpawnSyncLike>> {
  return vi
    .fn<SpawnSyncLike>()
    .mockReturnValue(spawnResult())
    .mockReturnValueOnce(spawnResult())
    .mockReturnValueOnce(
      spawnResult(
        0,
        "",
        [
          `FragmentPath=${servicePath}`,
          `ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
        ].join("\n"),
      ),
    );
}

function start(spawnSyncImpl: SpawnSyncLike, env: NodeJS.ProcessEnv) {
  return startOpenShellGatewayUserService({
    commandExists: (command) => command === "systemctl",
    env,
    existsSync: (candidate) => candidate === servicePath,
    home,
    lstatSync: () => ({ isSymbolicLink: () => false }) as never,
    platform: "linux",
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    spawnSyncImpl,
  });
}

describe.skipIf(currentUserId === undefined)("docker-driver gateway service recovery", () => {
  it("restores the current Linux user session for a reduced recovery environment (#10947)", () => {
    const suppliedEnv = { HOME: home };
    const spawnSyncImpl = systemdSpawn();

    expect(start(spawnSyncImpl, suppliedEnv).started).toBe(true);

    const runtimeDir = `/run/user/${String(currentUserId)}`;
    expect(spawnSyncImpl.mock.calls).not.toHaveLength(0);
    expect(spawnSyncImpl.mock.calls.map((call) => call[2]?.env)).toEqual(
      spawnSyncImpl.mock.calls.map(() =>
        expect.objectContaining({
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
          LC_ALL: "C",
          XDG_RUNTIME_DIR: runtimeDir,
        }),
      ),
    );
    expect(suppliedEnv).toEqual({ HOME: home });
  });

  it("preserves configured Linux user session authority during recovery (#10947)", () => {
    const spawnSyncImpl = systemdSpawn();

    expect(
      start(spawnSyncImpl, {
        HOME: home,
        XDG_RUNTIME_DIR: "/run/user/configured",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/configured/custom-bus",
      }).started,
    ).toBe(true);
    expect(spawnSyncImpl.mock.calls).not.toHaveLength(0);
    expect(spawnSyncImpl.mock.calls.map((call) => call[2]?.env)).toEqual(
      spawnSyncImpl.mock.calls.map(() =>
        expect.objectContaining({
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/configured/custom-bus",
          XDG_RUNTIME_DIR: "/run/user/configured",
        }),
      ),
    );
  });

  it("preserves a systemd user-service failure after restoring session variables (#10947)", () => {
    const spawnSyncImpl = vi.fn<SpawnSyncLike>().mockImplementation((_command, _args, options) => {
      expect(options?.env).toMatchObject({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(currentUserId)}/bus`,
        XDG_RUNTIME_DIR: `/run/user/${String(currentUserId)}`,
      });
      return spawnResult(1, "manager refused restart");
    });

    const result = start(spawnSyncImpl, { HOME: home });

    expect(result).toMatchObject({ attempted: true, manager: "systemd", started: false });
    expect(result.reason).toContain("manager refused restart");
  });
});
