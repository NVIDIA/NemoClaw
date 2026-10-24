// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createDockerRuntimeProviderBundle } from "../../src/lib/onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../src/lib/onboard/runtime-provider/registry";
import { managedStartupStateRoots } from "../../src/lib/onboard/managed-startup/state-roots";
import { withSuccessfulPreUninstallBackup } from "./uninstall-managed-gateway-test-support";
import {
  type RunResult,
  runUninstallPlanProduction as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "../../src/lib/actions/uninstall/run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

async function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return await runUninstallPlanBase(
    options,
    withSuccessfulPreUninstallBackup({
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: gatewayPort === 8080 ? "packaged-service" : "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      ...deps,
    }),
  );
}

export async function runManagedHermesVolumeUninstall(
  mode: "foreign" | "owned" | "remove-fails" | "remove-fails-once",
  destroyUserData: boolean,
  containerMode: "absent" | "foreign" | "owned" = "absent",
  agent: "hermes" | "openclaw" = "hermes",
  workspace = "default",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-hermes-volume-"));
  const stateDir = path.join(home, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const root = managedStartupStateRoots({
    agent,
    sandboxName: "hermes",
    agentIdentity: { uid: 1000, gid: 1000 },
  })[0]!;
  const volumeName = root.resourceIdentity;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "hermes",
      sandboxes: {
        hermes: {
          agent,
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          name: "hermes",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        },
      },
    }),
  );

  const dockerCalls: string[][] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const containerId = "hermes-sandbox-container";
  let containerPresent = containerMode !== "absent";
  let gatewayRegistered = true;
  let volumeRemovalAttempts = 0;
  let volumePresent = true;
  const run = vi.fn((command: string, args: string[]) => {
    events.push(`${command} ${args.join(" ")}`);
    switch (`${command} ${args.join(" ")}`) {
      case "openshell gateway list":
      case "openshell gateway list -o json":
        return ok(JSON.stringify(gatewayRegistered ? [{ name: "nemoclaw" }] : []));
      case "openshell gateway remove nemoclaw":
        gatewayRegistered = false;
        return ok();
      case "openshell sandbox delete --all":
        return gatewayRegistered
          ? ok()
          : { status: 1, stdout: "", stderr: "Unknown gateway 'nemoclaw'" };
      default:
        return ok();
    }
  });
  const runDocker = vi.fn((args: string[]) => {
    dockerCalls.push(args);
    events.push(`docker ${args.join(" ")}`);
    switch (args.join(" ")) {
      case "ps -a --format {{.ID}} {{.Image}} {{.Names}}":
        switch (containerPresent ? containerMode : "absent") {
          case "owned":
            return ok(
              `${containerId} ghcr.io/nvidia/nemoclaw/hermes-sandbox:latest openshell-default--hermes-runtime-id\n`,
            );
          case "foreign":
            return ok(`${containerId} redis:7 foreign-service\n`);
          default:
            return ok();
        }
      case `rm -f ${containerId}`:
        containerPresent = false;
        return ok(`${containerId}\n`);
      case `volume inspect --format {{json .}} ${volumeName}`:
        return volumePresent
          ? ok(
              `${JSON.stringify({
                Labels:
                  mode === "foreign" ? { "com.example.owner": "foreign" } : root.ownershipLabels,
                Name: volumeName,
              })}\n`,
            )
          : { status: 1, stdout: "", stderr: `Error: no such volume: ${volumeName}` };
      case `volume rm ${volumeName}`:
        switch (containerPresent ? "attached" : mode) {
          case "attached":
          case "remove-fails":
            return { status: 1, stdout: "", stderr: "volume is still in use" };
          case "remove-fails-once":
            volumeRemovalAttempts += 1;
            switch (volumeRemovalAttempts) {
              case 1:
                return { status: 1, stdout: "", stderr: "volume is still in use" };
              default:
                volumePresent = false;
                return ok(`${volumeName}\n`);
            }
          default:
            volumePresent = false;
            return ok(`${volumeName}\n`);
        }
      case "volume inspect openshell-cluster-nemoclaw":
        return { status: 1, stdout: "", stderr: "Error: no such volume" };
      default:
        return ok();
    }
  });

  const execute = () =>
    runUninstallPlan(
      { assumeYes: true, deleteModels: false, destroyUserData, keepOpenShell: false },
      {
        commandExists: () => true,
        env: {
          HOME: home,
          OPENSHELL_WORKSPACE: workspace === "default" ? undefined : workspace,
        } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: fs.rmSync,
        run,
        runDocker,
        runtimeProviders: createRuntimeProviderBundleRegistry([
          [
            "docker",
            createDockerRuntimeProviderBundle({
              captureHostCommand: (_command, args) => {
                const result = runDocker(args);
                return {
                  status: result.status ?? 1,
                  stdout: result.stdout,
                  stderr: result.stderr,
                };
              },
            }),
          ],
        ]),
      },
    );
  const result = await execute();

  return {
    cleanup: () => fs.rmSync(home, { force: true, recursive: true }),
    stateDir,
    containerId,
    containerPresent: () => containerPresent,
    dockerCalls,
    errors,
    events,
    gatewayRegistered: () => gatewayRegistered,
    logs,
    registryFile,
    result,
    retry: execute,
    volumeName,
    volumePresent: () => volumePresent,
  };
}
