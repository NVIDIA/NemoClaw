// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

type CutoverEvent = {
  type: string;
  extraPids?: Array<number | null>;
  pid?: number;
  signal?: string;
};

describe("startGateway Docker-driver prelaunch cutover (#5968)", () => {
  it(
    "reaps a stale gateway through the shared stopper before spawning its replacement",
    testTimeoutOptions(20_000),
    () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cutover-"));
      const stateDir = path.join(tmpDir, "state");
      const scriptPath = path.join(tmpDir, "gateway-cutover.cjs");
      const tracePath = path.join(tmpDir, "cutover.trace");
      const onboardPath = path.join(repoRoot, "src", "lib", "onboard.ts");

      fs.writeFileSync(
        scriptPath,
        String.raw`
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const onboardPath = ${JSON.stringify(onboardPath)};
const stateDir = ${JSON.stringify(stateDir)};
const tracePath = ${JSON.stringify(tracePath)};
const stalePid = 4242;
const duplicateListenerPid = 4343;
let staleAlive = true;

function record(event) {
  fs.appendFileSync(tracePath, JSON.stringify(event) + "\n");
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const fromOnboard = parent && path.resolve(parent.filename) === path.resolve(onboardPath);
  if (!fromOnboard) return originalLoad.call(this, request, parent, isMain);

  if (request === "./onboard/docker-driver-gateway-runtime") {
    return {
      createDockerDriverGatewayRuntimeHelpers() {
        return {
          clearDockerDriverGatewayRuntimeFiles() {
            record({ type: "legacy-runtime-clear" });
          },
          getDockerDriverGatewayEnv() {
            return { OPENSHELL_DRIVERS: "docker" };
          },
          getDockerDriverGatewayPid() {
            return staleAlive ? stalePid : null;
          },
          getDockerDriverGatewayPortListenerPids() {
            return staleAlive ? [stalePid, duplicateListenerPid] : [];
          },
          getDockerDriverGatewayPortListenerPid() {
            return null;
          },
          getDockerDriverGatewayRuntimeDrift(pid) {
            return pid === stalePid ? { reason: "test runtime drift" } : null;
          },
          getDockerDriverGatewayRuntimeDriftFromSnapshot() {
            return null;
          },
          getDockerDriverGatewayStateDir() {
            return stateDir;
          },
          isDockerDriverGatewayPortListener() {
            return false;
          },
          isDockerDriverGatewayProcess() {
            return true;
          },
          isDockerDriverGatewayProcessAlive() {
            return staleAlive;
          },
          isPidAlive(pid) {
            return (pid === stalePid || pid === duplicateListenerPid) && staleAlive;
          },
          rememberDockerDriverGatewayPid(pid) {
            record({ type: "remember-pid", pid });
          },
          resolveOpenShellGatewayBinary() {
            return "/test/bin/openshell-gateway";
          },
          resolveOpenShellSandboxBinary() {
            return null;
          },
          shouldRequireDockerDriverEnv() {
            return true;
          },
        };
      },
    };
  }

  if (request === "./onboard/docker-driver-gateway-prelaunch") {
    return {
      reapHostGatewayBeforeLaunchOrFail(options) {
        record({ type: "prelaunch-reap", extraPids: options.extraPids ?? [] });
        staleAlive = false;
        return {
          failed: [],
          skippedDeadPids: [],
          skippedNonMatchingPids: [],
          stopped: [stalePid],
          sudoRemediationPids: [],
        };
      },
      reapDuplicateHostGatewaysExceptOrFail() {
        record({ type: "unexpected-duplicate-reap" });
        return {
          failed: [],
          skippedDeadPids: [],
          skippedNonMatchingPids: [],
          stopped: [],
          sudoRemediationPids: [],
        };
      },
    };
  }

  if (request === "./onboard/docker-driver-gateway-launch") {
    const launch = {
      command: "/test/bin/openshell-gateway",
      args: [],
      env: {},
      mode: "host",
      processGatewayBin: "/test/bin/openshell-gateway",
    };
    return {
      buildDockerDriverGatewayRuntimeIdentity() {
        return {
          launch,
          desiredEnv: { OPENSHELL_DRIVERS: "docker" },
          driftGatewayBin: launch.processGatewayBin,
          identityGatewayBin: launch.processGatewayBin,
        };
      },
      openDockerDriverGatewayLog() {
        record({ type: "open-log" });
        return 99;
      },
      prepareAndLogDockerDriverGatewayLaunch() {
        record({ type: "prepare-launch" });
      },
      resolveDriftGatewayBin(runtimeIdentity, gatewayBin) {
        return runtimeIdentity ? runtimeIdentity.driftGatewayBin : gatewayBin;
      },
      spawnDockerDriverGateway() {
        record({ type: "spawn-fresh" });
        throw new Error("__fresh_launch_reached__");
      },
    };
  }

  if (request === "./onboard/docker-driver-gateway-env") {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      async startPackageManagedDockerDriverGatewayWithEnvOverride() {
        return false;
      },
    };
  }

  if (request === "./onboard/preflight") {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      checkPortAvailable() {
        return { ok: true };
      },
    };
  }

  if (request === "./onboard/openshell-cli") {
    return {
      createOpenshellCliHelpers() {
        return {
          getOpenshellBinary: () => "/test/bin/openshell",
          openshellShellCommand: () => "/test/bin/openshell",
          openshellArgv: (args) => ["/test/bin/openshell", ...args],
          runOpenshell: () => ({ status: 0, stdout: "", stderr: "" }),
          runCaptureOpenshell(args) {
            if (args[0] === "--version") return "openshell 0.0.72";
            if (args[0] === "status") return "Gateway: nemoclaw\nConnected";
            if (args[0] === "gateway" && args[1] === "info") {
              return "Gateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080";
            }
            return "";
          },
          safeOpenShellArgument: (value) => value,
          getGatewayPortArg: () => "8080",
          getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
        };
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

Object.defineProperty(process, "platform", { value: "linux" });
process.kill = function(pid, signal) {
  record({ type: "direct-process-kill", pid, signal: String(signal ?? "") });
  staleAlive = false;
  return true;
};

const { startGateway } = require(onboardPath);
startGateway(null)
  .then(() => {
    console.error("startGateway unexpectedly returned before the launch seam");
    process.exitCode = 2;
  })
  .catch((error) => {
    if (!String(error && error.message).includes("__fresh_launch_reached__")) {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 3;
      return;
    }
    console.log("public startGateway reached the fresh-launch seam");
  });
`,
      );

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          NEMOCLAW_GATEWAY_PORT: "8080",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
        },
      });

      assert.equal(
        result.status,
        0,
        `public startGateway harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /public startGateway reached the fresh-launch seam/);

      const events = fs
        .readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CutoverEvent);
      const reapIndex = events.findIndex((event) => event.type === "prelaunch-reap");
      const launchIndex = events.findIndex((event) => event.type === "spawn-fresh");

      assert.notEqual(
        reapIndex,
        -1,
        `shared prelaunch reaper was not reached: ${JSON.stringify(events)}`,
      );
      assert.notEqual(launchIndex, -1, `fresh launch was not reached: ${JSON.stringify(events)}`);
      assert.ok(
        reapIndex < launchIndex,
        `gateway launched before stale reaping: ${JSON.stringify(events)}`,
      );
      assert.ok(
        events[reapIndex]?.extraPids?.includes(4242),
        `stale PID was not handed to the shared reaper: ${JSON.stringify(events)}`,
      );
      assert.ok(
        events[reapIndex]?.extraPids?.includes(4343),
        `duplicate listener PID was not handed to the shared reaper: ${JSON.stringify(events)}`,
      );
      assert.ok(
        !events.some((event) => event.type === "direct-process-kill"),
        `legacy terminate-only path was reachable: ${JSON.stringify(events)}`,
      );
      assert.ok(
        !events.some((event) => event.type === "legacy-runtime-clear"),
        `legacy restart cleared runtime state before the shared reaper: ${JSON.stringify(events)}`,
      );
    },
  );
});
