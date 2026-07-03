// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

type CutoverScenario =
  | "stale-reap-before-spawn"
  | "extra-listener-bypasses-sole-binder"
  | "prelaunch-reap-throws"
  | "duplicate-reap-throws";

type CutoverEvent = {
  type: string;
  extraPids?: Array<number | null>;
  keepPid?: number;
  marker?: string;
  pid?: number;
  signal?: string;
};

function runStartGatewayHarness(scenario: CutoverScenario) {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cutover-"));
  const stateDir = path.join(tmpDir, "state");
  const scriptPath = path.join(tmpDir, "gateway-cutover.cjs");
  const tracePath = path.join(tmpDir, "cutover.trace");
  const onboardPath = path.join(repoRoot, "src", "lib", "onboard.ts");

  // startDockerDriverGateway is private, so this short-lived child intercepts
  // its CommonJS dependency seams while still entering through exported
  // startGateway. Keep this harness in CI until onboard exposes an equivalent
  // injectable public boundary; then replace the Module._load interception.
  fs.writeFileSync(
    scriptPath,
    String.raw`
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const onboardPath = ${JSON.stringify(onboardPath)};
const scenario = ${JSON.stringify(scenario)};
const stateDir = ${JSON.stringify(stateDir)};
const tracePath = ${JSON.stringify(tracePath)};
const stalePid = 4242;
const duplicateListenerPid = 4343;
let staleAlive = true;

function record(event) {
  fs.appendFileSync(tracePath, JSON.stringify(event) + "\n");
}

function pidFileGatewayPid() {
  return scenario === "duplicate-reap-throws" ? null : stalePid;
}

function portListenerPids() {
  if (scenario === "duplicate-reap-throws") return [duplicateListenerPid];
  if (scenario === "prelaunch-reap-throws") return [stalePid];
  if (scenario === "extra-listener-bypasses-sole-binder") {
    return [stalePid, duplicateListenerPid];
  }
  return staleAlive ? [stalePid, duplicateListenerPid] : [];
}

function runtimeDrift(pid) {
  if (scenario === "stale-reap-before-spawn" || scenario === "prelaunch-reap-throws") {
    return pid === stalePid ? { reason: "test runtime drift" } : null;
  }
  return null;
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
            return pidFileGatewayPid();
          },
          getDockerDriverGatewayPortListenerPids() {
            return portListenerPids();
          },
          getDockerDriverGatewayPortListenerPid() {
            return portListenerPids()[0] ?? null;
          },
          getDockerDriverGatewayRuntimeDrift(pid) {
            return runtimeDrift(pid);
          },
          getDockerDriverGatewayRuntimeDriftFromSnapshot() {
            return null;
          },
          getDockerDriverGatewayStateDir() {
            return stateDir;
          },
          isDockerDriverGatewayPortListener() {
            return true;
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
        if (scenario === "prelaunch-reap-throws") {
          throw new Error("__prelaunch_reap_failed__");
        }
        staleAlive = false;
        return {
          failed: [],
          skippedDeadPids: [],
          skippedNonMatchingPids: [],
          stopped: [stalePid],
          sudoRemediationPids: [],
        };
      },
      reapDuplicateHostGatewaysExceptOrFail(keepPid, _gatewayBin, extraPids) {
        record({ type: "duplicate-reap", keepPid, extraPids });
        if (scenario === "duplicate-reap-throws") {
          throw new Error("__duplicate_reap_failed__");
        }
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

  if (request === "./onboard/gateway-http-readiness") {
    return {
      getGatewayReuseHealthWaitConfig() {
        return { count: 1, intervalSeconds: 0 };
      },
      async isDockerDriverGatewayHttpReady() {
        record({ type: "http-ready" });
        return true;
      },
      async isGatewayHttpReady() {
        return true;
      },
      async waitForGatewayHttpReady() {
        return true;
      },
    };
  }

  if (request === "./onboard/gateway-sandbox-reachability") {
    return {
      async verifySandboxBridgeGatewayReachableOrExit() {
        record({ type: "verify-sandbox-bridge" });
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

const expectedError = {
  "stale-reap-before-spawn": "__fresh_launch_reached__",
  "prelaunch-reap-throws": "__prelaunch_reap_failed__",
  "duplicate-reap-throws": "__duplicate_reap_failed__",
}[scenario];

const { startGateway } = require(onboardPath);
startGateway(null)
  .then(() => {
    record({ type: "start-resolved" });
    if (expectedError) {
      console.error("startGateway unexpectedly resolved for " + scenario);
      process.exitCode = 2;
      return;
    }
    console.log("public startGateway resolved for " + scenario);
  })
  .catch((error) => {
    const message = String(error && error.message);
    if (!expectedError || !message.includes(expectedError)) {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 3;
      return;
    }
    record({ type: "expected-error", marker: expectedError });
    console.log("public startGateway stopped at " + expectedError);
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
  const events = fs.existsSync(tracePath)
    ? fs
        .readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CutoverEvent)
    : [];
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(
    result.status,
    0,
    `public startGateway harness failed for ${scenario}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return { events, stderr: result.stderr, stdout: result.stdout };
}

describe("startGateway Docker-driver prelaunch cutover (#5968)", () => {
  it(
    "reaps a stale gateway through the shared stopper before spawning its replacement",
    testTimeoutOptions(20_000),
    () => {
      const { events, stdout } = runStartGatewayHarness("stale-reap-before-spawn");
      assert.match(stdout, /public startGateway stopped at __fresh_launch_reached__/);
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

  it(
    "does not reuse a healthy pid-file gateway through the sole-binder shortcut when an extra verified listener exists",
    testTimeoutOptions(20_000),
    () => {
      const { events, stdout } = runStartGatewayHarness("extra-listener-bypasses-sole-binder");
      const duplicateReap = events.find((event) => event.type === "duplicate-reap");

      assert.match(stdout, /public startGateway resolved for extra-listener-bypasses-sole-binder/);
      assert.equal(duplicateReap?.keepPid, 4242);
      assert.ok(
        duplicateReap?.extraPids?.includes(4343),
        `extra verified listener did not reach duplicate cleanup: ${JSON.stringify(events)}`,
      );
      assert.ok(events.some((event) => event.type === "verify-sandbox-bridge"));
      assert.ok(events.some((event) => event.type === "start-resolved"));
      assert.ok(!events.some((event) => event.type === "prelaunch-reap"));
      assert.ok(!events.some((event) => event.type === "spawn-fresh"));
    },
  );

  it(
    "aborts before fresh spawn when reapHostGatewayBeforeLaunchOrFail throws",
    testTimeoutOptions(20_000),
    () => {
      const { events, stdout } = runStartGatewayHarness("prelaunch-reap-throws");

      assert.match(stdout, /public startGateway stopped at __prelaunch_reap_failed__/);
      assert.ok(events.some((event) => event.type === "prelaunch-reap"));
      assert.ok(!events.some((event) => event.type === "open-log"));
      assert.ok(!events.some((event) => event.type === "prepare-launch"));
      assert.ok(!events.some((event) => event.type === "spawn-fresh"));
      assert.ok(!events.some((event) => event.type === "start-resolved"));
    },
  );

  it(
    "prevents adopted-listener reuse success when reapDuplicateHostGatewaysExceptOrFail throws",
    testTimeoutOptions(20_000),
    () => {
      const { events, stdout } = runStartGatewayHarness("duplicate-reap-throws");

      assert.match(stdout, /public startGateway stopped at __duplicate_reap_failed__/);
      assert.deepEqual(
        events.find((event) => event.type === "duplicate-reap"),
        { type: "duplicate-reap", keepPid: 4343, extraPids: [null, 4343] },
      );
      assert.ok(!events.some((event) => event.type === "verify-sandbox-bridge"));
      assert.ok(!events.some((event) => event.type === "start-resolved"));
      assert.ok(!events.some((event) => event.type === "prelaunch-reap"));
      assert.ok(!events.some((event) => event.type === "spawn-fresh"));
      assert.doesNotMatch(stdout, /Reusing existing Docker-driver gateway process/);
    },
  );
});
