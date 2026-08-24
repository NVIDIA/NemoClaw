// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UninstallRunDeps } from "../../src/lib/actions/uninstall/run-plan";
import {
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../../src/lib/onboard/docker-driver-gateway-config";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "../../src/lib/onboard/docker-driver-gateway-runtime-marker";
import { resolveGatewayStateDirName } from "../../src/lib/onboard/gateway-binding";

const MANAGED_GATEWAY_PID = 9_999_671;

export function writeManagedGatewayRuntimeProof(stateDir: string, port: number): void {
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.pid"),
    `${String(MANAGED_GATEWAY_PID)}\n`,
    {
      mode: 0o600,
    },
  );
  writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
    desiredEnv: {},
    endpoint: `https://127.0.0.1:${String(port)}`,
    pid: MANAGED_GATEWAY_PID,
  });
}

export function withProvenManagedGatewayProcess(deps: UninstallRunDeps): UninstallRunDeps {
  const env = deps.env ?? process.env;
  const gatewayPort = Number(env.NEMOCLAW_GATEWAY_PORT || 8080);
  const gatewayName = gatewayPort === 8080 ? "nemoclaw" : `nemoclaw-${String(gatewayPort)}`;
  const gatewayBin = env.NEMOCLAW_OPENSHELL_GATEWAY_BIN?.trim() || "/usr/bin/openshell-gateway";
  const stateDir = path.join(
    env.HOME || os.homedir(),
    ".local",
    "state",
    "nemoclaw",
    resolveGatewayStateDirName(gatewayPort),
  );
  const run = deps.run ?? (() => ({ status: 0, stdout: "", stderr: "" }));
  let managedGatewayRunning = true;
  return {
    ...deps,
    getTrustedActiveOpenShellGatewayUserServiceIdentity:
      deps.getTrustedActiveOpenShellGatewayUserServiceIdentity ??
      (() => ({ executablePath: gatewayBin, pid: MANAGED_GATEWAY_PID })),
    kill: (pid, signal) => {
      if (pid !== MANAGED_GATEWAY_PID) return deps.kill?.(pid, signal) ?? true;
      managedGatewayRunning = false;
      return true;
    },
    readProcessExecutable: (pid) => {
      const provided = deps.readProcessExecutable?.(pid);
      if (provided !== undefined) return provided;
      return pid === MANAGED_GATEWAY_PID ? gatewayBin : null;
    },
    readProcessEnvironment: (pid) => {
      const provided = deps.readProcessEnvironment?.(pid);
      if (provided !== undefined) return provided;
      return pid === MANAGED_GATEWAY_PID
        ? {
            [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(stateDir),
          }
        : null;
    },
    run: (command, args, options) => {
      const delegated = run(command, args, options);
      if (
        command === "systemctl" &&
        args.includes("disable") &&
        args.includes("--now") &&
        delegated.status === 0
      ) {
        managedGatewayRunning = false;
      }
      if (command !== "ps" || args[1] !== String(MANAGED_GATEWAY_PID)) return delegated;
      if (args.includes("stat=")) {
        return managedGatewayRunning
          ? { status: 0, stdout: "S\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" };
      }
      if (args.includes("uid=")) {
        return { status: 0, stdout: `${String(process.getuid?.() ?? -1)}\n`, stderr: "" };
      }
      if (args.includes("args=")) {
        return {
          status: 0,
          stdout: `openshell-gateway[nemoclaw=${gatewayName};port=${String(gatewayPort)}]\n`,
          stderr: "",
        };
      }
      return delegated;
    },
  };
}
