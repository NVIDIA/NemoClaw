// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runtime validation for the #5968 gateway port release. The unit suite in
// src/lib/tunnel/gateway-port-release.test.ts mocks lsof/the stopper to cover
// branch decisions; this test exercises the REAL release path end-to-end:
// it starts an actual process whose argv0 basename is `openshell-gateway`
// (the identity the host-gateway stopper cmdline-gates on), bound to an
// isolated non-default port with an isolated HOME/state dir, then runs the
// real releaseManagedGatewayPort and proves a fresh process can immediately
// rebind the freed port. Nothing here touches a real user gateway.
//
// The fake gateway is launched through a short-lived launcher that exits
// immediately, so the gateway is orphaned to init rather than parented by the
// (synchronous, event-loop-blocked) test process — otherwise a killed child
// would linger as an unreaped zombie that `ps` still reports as alive.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { waitUntil } from "../src/lib/core/wait";
import { resolveGatewayStateDirName } from "../src/lib/onboard/gateway-binding";
import { releaseManagedGatewayPort } from "../src/lib/tunnel/gateway-port-release";

// POSIX-only: the release path relies on lsof/ps/POSIX signals and the
// cmdline gate reads /proc or `ps -o args=`. Windows has no equivalent and is
// not a NemoClaw host target for the gateway.
const posix = process.platform !== "win32";
const hasLsof = posix && !spawnSync("lsof", ["-v"], { stdio: "ignore" }).error;

let gatewayPid = 0;
let tmpHome: string | null = null;

function killQuietly(pid: number): void {
  try {
    pid > 0 && process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

afterEach(() => {
  killQuietly(gatewayPid);
  gatewayPid = 0;
  tmpHome && fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

// Reserve a free localhost TCP port by binding :0, then releasing it.
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

// Resolve true when a fresh server can bind the port, false otherwise.
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function readPidQuietly(pidFile: string): number {
  try {
    return Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim() || "0", 10) || 0;
  } catch {
    return 0;
  }
}

describe("releaseManagedGatewayPort runtime validation (#5968)", () => {
  it.skipIf(!posix || !hasLsof)(
    "stops a real openshell-gateway process and frees the port for immediate rebind",
    async () => {
      const port = await reserveFreePort();
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-rt-"));
      const argv0Path = path.join(tmpHome, "openshell-gateway");

      // Persist realistic per-port bookkeeping, then rely on real lsof to prove
      // this PID owns the selected port before the stopper may signal it.
      const stateDir = path.join(
        tmpHome,
        ".local",
        "state",
        "nemoclaw",
        resolveGatewayStateDirName(port),
      );
      fs.mkdirSync(stateDir, { recursive: true });
      const pidFile = path.join(stateDir, "openshell-gateway.pid");

      // The gateway binds the port and records its own pid; the launcher spawns
      // it detached (argv0 basename `openshell-gateway`) and exits, orphaning it.
      const gatewayFile = path.join(tmpHome, "gateway.cjs");
      fs.writeFileSync(
        gatewayFile,
        `const net=require("node:net");const fs=require("node:fs");` +
          `const server=net.createServer();` +
          `server.listen(${String(port)},"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)));` +
          `process.on("SIGTERM",()=>process.exit(0));`,
      );
      const launcherScript =
        `const {spawn}=require("node:child_process");` +
        `spawn(process.argv[1],[process.argv[2]],{argv0:process.argv[3],detached:true,stdio:"ignore"}).unref();`;
      spawn(process.execPath, ["-e", launcherScript, process.execPath, gatewayFile, argv0Path], {
        stdio: "ignore",
      });

      // Wait until the orphaned gateway has recorded its pid and bound the port.
      const pidRecorded = waitUntil(
        () => {
          gatewayPid = readPidQuietly(pidFile);
          return gatewayPid > 0;
        },
        {
          deadlineMs: Date.now() + 10_000,
          initialIntervalMs: 25,
          maxIntervalMs: 25,
          backoffFactor: 1,
        },
      );
      expect(pidRecorded).toBe(true);
      expect(gatewayPid).toBeGreaterThan(0);
      await expect(canBind(port)).resolves.toBe(false);

      // Run the REAL release path (real spawnSync/ps/kill/stopper); only the
      // registry lookup and HOME are isolated so no real gateway is touched.
      const result = releaseManagedGatewayPort(
        { sandboxName: "nemoclaw-5968-runtime", confirmTimeoutMs: 8000 },
        {
          homeDir: tmpHome,
          env: { ...process.env, HOME: tmpHome },
          getSandbox: () => ({ gatewayPort: port }),
        },
      );

      expect(result.port).toBe(port);
      expect(result.stopped).toContain(gatewayPid);
      expect(result.released).toBe(true);

      // Ground truth: a fresh process can rebind the freed port immediately.
      await expect(canBind(port)).resolves.toBe(true);
    },
    30000,
  );
});
