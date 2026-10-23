// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  withProvenManagedGatewayProcess,
  withSuccessfulPreUninstallBackup,
} from "./uninstall-managed-gateway-test-support";
import {
  runUninstallPlanProduction,
  type RunResult,
} from "../../src/lib/actions/uninstall/run-plan";

type CleanupFailure =
  | "missing-lsof"
  | "inventory-error"
  | "malformed-pid"
  | "stop-failed"
  | "sibling";
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const missing = (): RunResult => ({ status: 1, stdout: "", stderr: "" });

/** Real receipt files and independent fake processes for the multi-port uninstall tests. */
export function createRouterMigrationHarness(options: {
  oldPort: number;
  latestReceipt: "present" | "cleared" | "absent";
  failure?: CleanupFailure;
}) {
  const { oldPort, latestReceipt, failure } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-router-migration-"));
  const stateDir = path.join(root, ".nemoclaw");
  const sessionFile = path.join(stateDir, "onboard-session.json");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const routerRuntime = path.join(stateDir, "model-router-venv", "pyvenv.cfg");
  fs.mkdirSync(path.dirname(routerRuntime), { recursive: true });
  fs.writeFileSync(routerRuntime, "shared router runtime\n");
  if (latestReceipt !== "absent") {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify(
        latestReceipt === "cleared"
          ? { routerPid: null, routerPort: null, routerCredentialHash: null }
          : { provider: "nvidia-router", routerPid: 55682, routerPort: 15000 },
      ),
    );
  }
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      sandboxes: {
        alpha: {
          name: "alpha",
          provider: "nvidia-router",
          endpointUrl: `http://host.openshell.internal:${oldPort}`,
          gatewayPort: 8080,
        },
      },
      defaultSandbox: "alpha",
    }),
  );
  const live = new Map([
    [55681, oldPort],
    [55682, 15000],
  ]);
  if (latestReceipt !== "present") live.delete(55682);
  const killed: number[] = [];
  const errors: string[] = [];
  let recoveryBlocked = failure !== undefined;
  const run = (command: string, args: string[]): RunResult => {
    switch (command) {
      case "lsof": {
        if (recoveryBlocked && args[1] === `:${oldPort}`) {
          if (failure === "inventory-error")
            return { status: 2, stdout: "", stderr: "inventory unavailable" };
          if (failure === "malformed-pid") return ok("not-a-pid\n");
        }
        const matches = [...live].filter(([, port]) => `:${port}` === args[1]).map(([pid]) => pid);
        return matches.length ? ok(matches.join("\n")) : missing();
      }
      case "ps": {
        const port = live.get(Number(args[1]));
        if (port === undefined) return missing();
        if (args[3] === "user=") return ok("testuser\n");
        if (args[3] === "args=")
          return ok(
            `/home/test/.nemoclaw/model-router-venv/bin/python /home/test/.nemoclaw/model-router-venv/bin/model-router proxy --port ${port}\n`,
          );
        return ok(`${args[1]}\n`);
      }
      case "openshell":
        return args[0] === "gateway" && args[1] === "list"
          ? ok(
              JSON.stringify(
                recoveryBlocked && failure === "sibling"
                  ? [{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]
                  : [{ name: "nemoclaw" }],
              ),
            )
          : ok();
      default:
        return args[0] === "-c" ? ok("/fake/bin/tool\n") : ok();
    }
  };
  const uninstall = () =>
    runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true, destroyUserData: true },
      withSuccessfulPreUninstallBackup(
        withProvenManagedGatewayProcess({
          commandExists: (command) =>
            command !== "lsof" || failure !== "missing-lsof" || !recoveryBlocked,
          env: { HOME: root, LOGNAME: "testuser" },
          error: (message) => errors.push(message),
          existsSync: fs.existsSync,
          isTty: false,
          kill: (pid) => {
            if (recoveryBlocked && failure === "stop-failed" && pid === 55681) return false;
            killed.push(pid);
            live.delete(pid);
            return true;
          },
          log: () => undefined,
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            endpoint: null,
            gatewayName,
            gatewayPort,
            mode: "nemoclaw-managed",
            requiredCapabilities: [],
            source: "packaged-service",
            stateDir: null,
            supervisor: null,
          }),
          rmSync: fs.rmSync,
          run,
          runDocker: () => ok(),
        }),
      ),
    );
  return {
    errors,
    killed,
    live,
    registryFile,
    routerRuntime,
    sessionFile,
    uninstall,
    allowCleanup: () => {
      recoveryBlocked = false;
    },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
