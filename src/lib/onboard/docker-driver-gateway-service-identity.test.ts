// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import {
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

const HOME = "/home/nvidia";
const NEMOCLAW_UNIT = `${HOME}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
const NEMOCLAW_GATEWAY = `${HOME}/.local/bin/openshell-gateway`;
const PACKAGE_UNIT = "/usr/lib/systemd/user/openshell-gateway.service";
const PACKAGE_GATEWAY = "/usr/bin/openshell-gateway";

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function identity(fragmentPath: string, executablePath: string, argumentsValue = executablePath) {
  return [
    `FragmentPath=${fragmentPath}`,
    `ExecStart={ path=${executablePath} ; argv[]=${argumentsValue} ; }`,
  ].join("\n");
}

function nemoclawOptions(spawnSyncImpl: SpawnSyncLike) {
  return {
    commandExists: (command: string) => command === "systemctl",
    env: { HOME },
    existsSync: (candidate: string) => candidate === NEMOCLAW_UNIT,
    getuid: () => 1000,
    home: HOME,
    lstatSync: (() => ({ isFile: () => true, isSymbolicLink: () => false, uid: 1000 })) as never,
    platform: "linux" as const,
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    spawnSyncImpl,
  };
}

it("rejects changed systemd identity after environment preparation and before stop (#9705)", () => {
  const events: string[] = [];
  let identityReads = 0;
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    const operation = args.slice(1).join(" ");
    events.push(operation);
    const output =
      identityReads === 0
        ? identity(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY)
        : identity("/tmp/foreign.service", NEMOCLAW_GATEWAY);
    identityReads += args.includes("show") ? 1 : 0;
    return args.includes("show") ? spawnResult(0, "", output) : spawnResult();
  });

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    prepareServiceEnv: () => events.push("prepare-env"),
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events).toContain("prepare-env");
  expect(events.some((event) => event.startsWith("stop "))).toBe(false);
  expect(events.some((event) => event.startsWith("enable "))).toBe(false);
  expect(events.some((event) => event.startsWith("restart "))).toBe(false);
});

it("rejects changed systemd identity after port preparation and before restart (#9705)", () => {
  const events: string[] = [];
  let identityReads = 0;
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    const operation = args.slice(1).join(" ");
    events.push(operation);
    const output =
      identityReads < 2
        ? identity(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY)
        : identity(NEMOCLAW_UNIT, "/tmp/foreign/openshell-gateway");
    identityReads += args.includes("show") ? 1 : 0;
    return args.includes("show") ? spawnResult(0, "", output) : spawnResult();
  });

  const result = startOpenShellGatewayUserService({
    ...nemoclawOptions(spawnSyncImpl),
    preparePortForServiceStart: () => events.push("prepare-port"),
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events).toContain("stop nemoclaw-openshell-gateway");
  expect(events).toContain("prepare-port");
  expect(events.some((event) => event.startsWith("enable "))).toBe(false);
  expect(events.some((event) => event.startsWith("restart "))).toBe(false);
});

it("qualifies the effective NemoClaw unit before disabling a competing descriptor (#9705)", () => {
  const events: string[] = [];
  const removed = vi.fn();
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    const operation = args.slice(1).join(" ");
    events.push(operation);
    const serviceName = args[args.indexOf("show") + 1];
    const output =
      serviceName === "nemoclaw-openshell-gateway"
        ? identity("/tmp/foreign.service", NEMOCLAW_GATEWAY)
        : identity(PACKAGE_UNIT, PACKAGE_GATEWAY);
    return args.includes("show") ? spawnResult(0, "", output) : spawnResult();
  });

  const result = startOpenShellGatewayUserService({
    commandExists: () => true,
    env: { HOME },
    existsSync: (candidate) => candidate === PACKAGE_UNIT || candidate === NEMOCLAW_UNIT,
    getUpstreamGatewayVersion: () => "0.0.85",
    getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
    getuid: () => 1000,
    home: HOME,
    lstatSync: (() => ({ isFile: () => true, isSymbolicLink: () => false, uid: 1000 })) as never,
    platform: "linux",
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    rmSync: removed as never,
    spawnSyncImpl,
  });

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events).not.toContain("disable --now nemoclaw-openshell-gateway");
  expect(removed).not.toHaveBeenCalled();
});

it("rejects unexpected effective arguments before changing service state (#9705)", () => {
  const events: string[] = [];
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
    events.push(args.slice(1).join(" "));
    return args.includes("show")
      ? spawnResult(
          0,
          "",
          identity(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY, `${NEMOCLAW_GATEWAY} --port 8080`),
        )
      : spawnResult();
  });

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ started: false, standaloneFallbackBlocked: true });
  expect(events.some((event) => event.startsWith("stop "))).toBe(false);
  expect(events.some((event) => event.startsWith("enable "))).toBe(false);
  expect(events.some((event) => event.startsWith("restart "))).toBe(false);
});

it("does not expose systemd lifecycle stderr in a service failure (#9705)", () => {
  const secret = "sentinel-secret-not-for-systemd-diagnostics";
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
    args.includes("show")
      ? spawnResult(0, "", identity(NEMOCLAW_UNIT, NEMOCLAW_GATEWAY))
      : args.includes("stop")
        ? spawnResult(1, secret)
        : spawnResult(),
  );

  const result = startOpenShellGatewayUserService(nemoclawOptions(spawnSyncImpl));

  expect(result).toMatchObject({ attempted: true, started: false });
  expect(result.reason).not.toContain(secret);
  expect(result.reason).toContain("failed with status 1");
});
