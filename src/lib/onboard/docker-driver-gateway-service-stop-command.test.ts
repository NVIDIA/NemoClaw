// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellGatewayServiceStopCommand,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
} from "./docker-driver-gateway-service";

const HOME = "/home/tester";
const ENV: NodeJS.ProcessEnv = { HOME, PATH: "/usr/bin" };
const NEMOCLAW_UNIT = getNemoclawOpenShellGatewayUserServicePath(HOME, ENV);
const STOP_COMMAND = "systemctl --user stop nemoclaw-openshell-gateway";

/** Only the NemoClaw tarball unit exists; no package unit shadows it. */
function nemoclawUnitOnly(filePath: string): boolean {
  return filePath === NEMOCLAW_UNIT;
}

function stopCommandOptions(
  showResult: { status: number | null; stdout?: string },
  overrides: Record<string, unknown> = {},
) {
  const spawnSyncImpl = vi.fn((_command: string, _args: readonly string[]) => showResult);
  const lstatSync = (() => ({ isSymbolicLink: () => false })) as unknown as typeof fs.lstatSync;
  return {
    spawnSyncImpl,
    opts: {
      platform: "linux" as const,
      env: ENV,
      home: HOME,
      existsSync: nemoclawUnitOnly,
      lstatSync,
      readFileSync: () => NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE,
      commandExists: () => true,
      spawnSyncImpl,
      ...overrides,
    },
  };
}

function activeState(state: string): { status: number; stdout: string } {
  return { status: 0, stdout: `ActiveState=${state}\n` };
}

describe("gateway user service stop command ownership (#11720)", () => {
  it("offers the stop command while the unit is active", () => {
    const { opts } = stopCommandOptions(activeState("active"));
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
  });

  it.each(["activating", "deactivating", "reloading"])(
    "offers the stop command while the unit is %s",
    (state) => {
      const { opts } = stopCommandOptions(activeState(state));
      expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
    },
  );

  it.each(["inactive", "failed"])(
    "withholds the stop command when the installed unit is %s",
    (state) => {
      // The standalone fallback holds the port in this state, so the stop
      // would exit 0 without releasing it.
      const { opts } = stopCommandOptions(activeState(state));
      expect(getOpenShellGatewayServiceStopCommand(opts)).toBeNull();
    },
  );

  it("keeps the stop command when systemctl is unavailable", () => {
    const { opts } = stopCommandOptions(activeState("inactive"), { commandExists: () => false });
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
  });

  it("keeps the stop command when the state query fails", () => {
    const { opts } = stopCommandOptions({ status: 1, stdout: "" });
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
  });

  it("keeps the stop command when the reported state is empty", () => {
    const { opts } = stopCommandOptions(activeState(""));
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
  });

  it("keeps the stop command when the state query returns unexpected metadata", () => {
    const { opts } = stopCommandOptions({ status: 0, stdout: "MainPID=42\n" });
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBe(STOP_COMMAND);
  });

  it("returns null when no gateway user service is installed", () => {
    const { opts } = stopCommandOptions(activeState("active"), { existsSync: () => false });
    expect(getOpenShellGatewayServiceStopCommand(opts)).toBeNull();
  });

  it("queries only the resolved unit state", () => {
    const { opts, spawnSyncImpl } = stopCommandOptions(activeState("inactive"));
    getOpenShellGatewayServiceStopCommand(opts);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(spawnSyncImpl.mock.calls[0]?.[1]).toEqual([
      "--user",
      "show",
      "nemoclaw-openshell-gateway",
      "--property=ActiveState",
    ]);
  });
});
