// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "../../onboard/docker-driver-gateway-runtime-marker";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function withManagedGatewayAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  const commandExists = deps.commandExists;
  return {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
    isPortFree: deps.isPortFree ?? (() => true),
    commandExists: (command) => command === "lsof" || (commandExists?.(command) ?? false),
  };
}

function bindManagedGatewayAuthority(run: typeof runUninstallPlanBase) {
  return (options: UninstallRunOptions, deps: UninstallRunDeps) =>
    run(options, withManagedGatewayAuthority(deps));
}

function writeScopedGatewayPairState(options: {
  markerPid: number;
  pidFilePid: number;
  selectedPort: number;
  siblingPid: number;
  tmpHome: string;
}) {
  const { markerPid, pidFilePid, selectedPort, siblingPid, tmpHome } = options;
  const sharedStateDir = path.join(tmpHome, ".nemoclaw");
  const selectedStateDir = path.join(sharedStateDir, "gateways", String(selectedPort));
  const gatewayRuntimeRoot = path.join(tmpHome, ".local", "state", "nemoclaw");
  const selectedGatewayRuntimeDir = path.join(
    gatewayRuntimeRoot,
    `openshell-docker-gateway-${String(selectedPort)}`,
  );
  const siblingGatewayRuntimeDir = path.join(gatewayRuntimeRoot, "openshell-docker-gateway");
  fs.mkdirSync(selectedStateDir, { recursive: true });
  fs.mkdirSync(selectedGatewayRuntimeDir, { recursive: true });
  fs.mkdirSync(siblingGatewayRuntimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedStateDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "sibling-box",
      sandboxes: {
        "sibling-box": {
          name: "sibling-box",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(selectedStateDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "selected-box",
      sandboxes: {
        "selected-box": {
          name: "selected-box",
          gatewayName: `nemoclaw-${String(selectedPort)}`,
          gatewayPort: selectedPort,
        },
      },
    }),
  );
  const pidFile = path.join(selectedGatewayRuntimeDir, "openshell-gateway.pid");
  fs.writeFileSync(pidFile, `${String(pidFilePid)}\n`);
  writeDockerDriverGatewayRuntimeMarkerForStateDir(selectedGatewayRuntimeDir, {
    desiredEnv: {},
    endpoint: `https://127.0.0.1:${String(selectedPort)}`,
    gatewayBin: "/opt/openshell-gateway",
    pid: markerPid,
  });
  fs.writeFileSync(path.join(selectedGatewayRuntimeDir, "selected-state"), "keep\n");
  fs.writeFileSync(
    path.join(siblingGatewayRuntimeDir, "openshell-gateway.pid"),
    `${String(siblingPid)}\n`,
  );
  fs.writeFileSync(path.join(siblingGatewayRuntimeDir, "sibling-state"), "keep\n");
  return {
    pidFile,
    selectedGatewayRuntimeDir,
    selectedStateDir,
    sharedStateDir,
    siblingGatewayRuntimeDir,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("scoped uninstall gateway process isolation", () => {
  it("proves and stops only the selected gateway process during scoped uninstall (#8663)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-exact-process-"));
    const selectedPort = 18_080;
    const selectedPid = 987_650;
    const siblingPid = 987_651;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(selectedPort));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const {
        selectedGatewayRuntimeDir,
        selectedStateDir,
        sharedStateDir,
        siblingGatewayRuntimeDir,
      } = writeScopedGatewayPairState({
        markerPid: selectedPid,
        pidFilePid: selectedPid,
        selectedPort,
        siblingPid,
        tmpHome,
      });

      const events: string[] = [];
      const signals: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
      const selectedUid = fs.statSync(
        path.join(selectedGatewayRuntimeDir, "openshell-gateway.pid"),
      ).uid;
      let selectedAlive = true;
      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(selectedPort)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => ["lsof", "openshell", "pgrep"].includes(command),
          env: {
            HOME: tmpHome,
            LOGNAME: "tester",
            NEMOCLAW_GATEWAY_PORT: String(selectedPort),
          } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isPortFree: () => !selectedAlive,
          isTty: false,
          kill: (pid, signal) => {
            events.push(`kill ${String(pid)} ${String(signal)}`);
            signals.push({ pid, signal });
            if (pid !== selectedPid || signal !== "SIGKILL") return false;
            selectedAlive = false;
            return true;
          },
          log: vi.fn(),
          run: (command, args) => {
            events.push([command, ...args].join(" "));
            if (command === "openshell" && args[0] === "gateway" && args[1] === "list") {
              return ok(
                JSON.stringify([
                  { name: "nemoclaw" },
                  { name: `nemoclaw-${String(selectedPort)}` },
                ]),
              );
            }
            if (command === "lsof" && args.includes(`:${String(selectedPort)}`)) {
              return selectedAlive ? ok(`${String(selectedPid)}\n`) : { ...ok(), status: 1 };
            }
            if (command === "ps" && args[1] === String(selectedPid)) {
              if (args.includes("pid=")) {
                return selectedAlive ? ok(`${String(selectedPid)}\n`) : { ...ok(), status: 1 };
              }
              if (args.includes("uid=")) return ok(`${String(selectedUid)}\n`);
              if (args.includes("comm=")) return ok("/opt/openshell-gateway\n");
              if (args.includes("lstart=")) return ok("fixture-start-identity\n");
              if (args.includes("args=")) {
                return ok(
                  `openshell-gateway[nemoclaw=nemoclaw-${String(selectedPort)};port=${String(selectedPort)}]\n`,
                );
              }
            }
            if (command === "pgrep") return ok(`${String(siblingPid)}\n${String(selectedPid)}\n`);
            return ok();
          },
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(signals).toEqual([{ pid: selectedPid, signal: "SIGKILL" }]);
      expect(events.some((event) => event.startsWith("pgrep "))).toBe(false);
      expect(events.indexOf("openshell sandbox delete selected-box")).toBeLessThan(
        events.indexOf(`kill ${String(selectedPid)} SIGKILL`),
      );
      expect(fs.existsSync(selectedStateDir)).toBe(false);
      expect(
        fs.readFileSync(path.join(siblingGatewayRuntimeDir, "openshell-gateway.pid"), "utf8"),
      ).toBe(`${String(siblingPid)}\n`);
      expect(fs.readFileSync(path.join(siblingGatewayRuntimeDir, "sibling-state"), "utf8")).toBe(
        "keep\n",
      );
      expect(fs.existsSync(path.join(sharedStateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("fails closed and preserves runtime evidence when scoped PID identities cross-match (#8663)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-crossed-process-"));
    const selectedPort = 18_080;
    const siblingPid = 987_652;
    const selectedMarkerPid = 987_653;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(selectedPort));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const {
        pidFile,
        selectedGatewayRuntimeDir,
        selectedStateDir,
        sharedStateDir,
        siblingGatewayRuntimeDir,
      } = writeScopedGatewayPairState({
        markerPid: selectedMarkerPid,
        pidFilePid: siblingPid,
        selectedPort,
        siblingPid,
        tmpHome,
      });

      const errors: string[] = [];
      const kill = vi.fn(() => true);
      const calls: string[] = [];
      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(selectedPort)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => ["lsof", "openshell", "pgrep"].includes(command),
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(selectedPort) } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill,
          log: vi.fn(),
          run: (command, args) => {
            calls.push([command, ...args].join(" "));
            if (command === "openshell" && args[0] === "gateway" && args[1] === "list") {
              return ok(
                JSON.stringify([
                  { name: "nemoclaw" },
                  { name: `nemoclaw-${String(selectedPort)}` },
                ]),
              );
            }
            if (command === "ps" && args[1] === String(siblingPid) && args.includes("pid=")) {
              return ok(`${String(siblingPid)}\n`);
            }
            if (command === "pgrep") {
              return ok(`${String(siblingPid)}\n${String(selectedMarkerPid)}\n`);
            }
            return ok();
          },
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      expect(calls.some((call) => call.startsWith("pgrep "))).toBe(false);
      expect(errors.join("\n")).toContain(
        `runtime marker PID ${String(selectedMarkerPid)} does not match PID file ${String(siblingPid)}`,
      );
      expect(fs.readFileSync(pidFile, "utf8")).toBe(`${String(siblingPid)}\n`);
      expect(fs.readFileSync(path.join(selectedGatewayRuntimeDir, "selected-state"), "utf8")).toBe(
        "keep\n",
      );
      expect(fs.readFileSync(path.join(siblingGatewayRuntimeDir, "sibling-state"), "utf8")).toBe(
        "keep\n",
      );
      expect(
        fs.readFileSync(path.join(siblingGatewayRuntimeDir, "openshell-gateway.pid"), "utf8"),
      ).toBe(`${String(siblingPid)}\n`);
      expect(fs.existsSync(selectedStateDir)).toBe(true);
      expect(fs.existsSync(path.join(sharedStateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
