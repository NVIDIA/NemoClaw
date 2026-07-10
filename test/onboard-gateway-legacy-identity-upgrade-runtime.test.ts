// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { waitUntil } from "../src/lib/core/wait";
import {
  type DockerDriverGatewayCutoverDeps,
  type DockerDriverGatewayCutoverInput,
  runDockerDriverGatewayCutover,
} from "../src/lib/onboard/docker-driver-gateway-cutover";
import { reapHostGatewayBeforeLaunchOrFail } from "../src/lib/onboard/docker-driver-gateway-prelaunch";
import { createDockerDriverGatewayRuntimeHelpers } from "../src/lib/onboard/docker-driver-gateway-runtime";
import { resolveGatewayName, resolveGatewayStateDirName } from "../src/lib/onboard/gateway-binding";
import { buildOwnedHostGatewayArgv0 } from "../src/lib/onboard/gateway-process-identity";
import { stopHostGatewayProcesses } from "../src/lib/onboard/host-gateway-process";

const posix = process.platform !== "win32";
const hasLsof = posix && !spawnSync("lsof", ["-v"], { stdio: "ignore" }).error;

const livePids = new Set<number>();
let tmpHome: string | null = null;
let scriptSequence = 0;

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already stopped.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of livePids) killQuietly(pid);
  livePids.clear();
  tmpHome && fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function readPid(pidFile: string): number {
  try {
    return Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function launchOrphanGateway(options: {
  argv0: string;
  env: NodeJS.ProcessEnv;
  pidFile: string;
  port: number;
}): number {
  assert.ok(tmpHome, "temporary home is not initialized");
  scriptSequence += 1;
  const gatewayFile = path.join(tmpHome, `gateway-${scriptSequence}.cjs`);
  fs.writeFileSync(
    gatewayFile,
    `const net=require("node:net");const fs=require("node:fs");` +
      `const server=net.createServer();` +
      `server.listen(${String(options.port)},"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(options.pidFile)},String(process.pid)));` +
      `process.on("SIGTERM",()=>process.exit(0));`,
  );
  const launcherScript =
    `const {spawn}=require("node:child_process");` +
    `spawn(process.argv[1],[process.argv[2]],{argv0:process.argv[3],detached:true,stdio:"ignore",env:JSON.parse(process.argv[4])}).unref();`;
  spawn(
    process.execPath,
    [
      "-e",
      launcherScript,
      process.execPath,
      gatewayFile,
      options.argv0,
      JSON.stringify(options.env),
    ],
    { stdio: "ignore" },
  );

  let pid = 0;
  const started = waitUntil(
    () => {
      pid = readPid(options.pidFile);
      return pid > 0 && isAlive(pid);
    },
    {
      deadlineMs: Date.now() + 10_000,
      initialIntervalMs: 25,
      maxIntervalMs: 25,
      backoffFactor: 1,
    },
  );
  assert.ok(started, "gateway fixture did not start");
  livePids.add(pid);
  return pid;
}

function runCapture(args: string[]): string {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf-8" });
  return result.status === 0 ? result.stdout : "";
}

function runCaptureEx(args: readonly string[]): {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
} {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf-8", timeout: 5000 });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status,
    timedOut: Boolean(result.error && "code" in result.error && result.error.code === "ETIMEDOUT"),
  };
}

describe("legacy Docker-driver gateway identity upgrade", () => {
  it.skipIf(!posix || !hasLsof)(
    "retires a reused legacy process, launches target-bound identity, and releases its port",
    async () => {
      const port = await reserveFreePort();
      const gatewayName = resolveGatewayName(port);
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-upgrade-"));
      const stateDir = path.join(
        tmpHome,
        ".local",
        "state",
        "nemoclaw",
        resolveGatewayStateDirName(port),
      );
      fs.mkdirSync(stateDir, { recursive: true });
      const pidFile = path.join(stateDir, "openshell-gateway.pid");
      const gatewayBin = path.join(tmpHome, "openshell-gateway");
      const driftEnv = { OPENSHELL_DRIVERS: "docker" };
      const childEnv = { ...process.env, ...driftEnv };

      const legacyPid = launchOrphanGateway({
        argv0: gatewayBin,
        env: childEnv,
        pidFile,
        port,
      });
      await expect(canBind(port)).resolves.toBe(false);

      const runtime = createDockerDriverGatewayRuntimeHelpers({
        gatewayPort: port,
        getCachedOpenshellBinary: () => null,
        getBlueprintMaxOpenshellVersion: () => null,
        getInstalledOpenshellVersion: () => "0.0.72",
        isOpenshellDevVersion: () => false,
        runCapture,
        runCaptureEx,
        shouldUseOpenshellDevChannel: () => false,
        supportedOpenshellFallbackVersion: "0.0.72",
      });
      const listenerScan = runtime.getDockerDriverGatewayPortListenerScan(
        { ok: false, process: "openshell-gateway", pid: legacyPid },
        { gatewayBin, platform: process.platform },
      );
      expect(listenerScan).toEqual({ complete: true, pids: [legacyPid] });

      const restartReasons: string[] = [];
      const verifyBridge = vi.fn(async () => undefined);
      const input: DockerDriverGatewayCutoverInput = {
        gatewayBin,
        identityGatewayBin: gatewayBin,
        driftGatewayBin: gatewayBin,
        driftGatewayEnv: driftEnv,
        exitOnFailure: false,
        skipSandboxBridgeReachability: false,
        stateDir,
        portListenerScan: listenerScan,
        pidFileGatewayPid: legacyPid,
        initialHealth: {
          status: "Gateway: active",
          namedInfo: `Gateway: ${gatewayName}`,
          activeInfo: `Gateway: ${gatewayName}`,
        },
      };
      const deps: DockerDriverGatewayCutoverDeps = {
        isDockerDriverGatewayProcessAlive: () => isAlive(legacyPid),
        isGatewayHealthy: () => true,
        getDockerDriverGatewayRuntimeDrift: (pid, env, binary) =>
          runtime.getDockerDriverGatewayRuntimeDrift(pid, env, binary, process.platform),
        logDockerDriverGatewayRestart: (reason) => restartReasons.push(reason),
        registerDockerDriverGatewayEndpoint: () => true,
        isDockerDriverGatewayHttpReady: async () => true,
        verifySandboxBridgeGatewayReachableOrExit: verifyBridge,
        readGatewayHealth: () => input.initialHealth,
        rememberDockerDriverGatewayPid: runtime.rememberDockerDriverGatewayPid,
        reapDuplicateHostGatewaysExceptOrFail: () => undefined,
        reapHostGatewayBeforeLaunchOrFail: (options) => reapHostGatewayBeforeLaunchOrFail(options),
        isGatewayPortAvailable: () => canBind(port),
        reportUntrustedGatewayPort: (message) => {
          throw new Error(message);
        },
        reportMissingGatewayBinary: () => {
          throw new Error("gateway binary missing");
        },
        log: () => undefined,
      };

      await expect(runDockerDriverGatewayCutover(input, deps)).resolves.toBe("launch");
      livePids.delete(legacyPid);
      expect(restartReasons).toContainEqual(
        expect.stringContaining("target-bound cleanup identity"),
      );
      expect(verifyBridge).not.toHaveBeenCalled();
      expect(isAlive(legacyPid)).toBe(false);
      await expect(canBind(port)).resolves.toBe(true);

      const argv0 = buildOwnedHostGatewayArgv0(gatewayName);
      expect(argv0).not.toBeNull();
      const freshPid = launchOrphanGateway({
        argv0: argv0 as string,
        env: childEnv,
        pidFile,
        port,
      });
      const stopped = stopHostGatewayProcesses(
        { env: { ...process.env, HOME: tmpHome } },
        {
          gatewayBin,
          openShellGatewayName: gatewayName,
          openShellGatewayPort: port,
          pidFile,
          stateDir,
          usePgrepFallback: false,
        },
      );
      livePids.delete(freshPid);

      expect(stopped.stopped).toContain(freshPid);
      expect(stopped.skippedNonMatchingPids).toEqual([]);
      expect(isAlive(freshPid)).toBe(false);
      expect(fs.existsSync(pidFile)).toBe(false);
      await expect(canBind(port)).resolves.toBe(true);
    },
    30000,
  );
});
