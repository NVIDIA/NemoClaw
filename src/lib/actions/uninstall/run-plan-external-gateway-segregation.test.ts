// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  withSuccessfulPreUninstallBackup,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";
import {
  type RunResult,
  runUninstallPlanProduction as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeScopedGatewayState(home: string): string {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(8080));
  const configPath = path.join(stateDir, "openshell-gateway.toml");
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    configPath,
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(stateDir),
    ),
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);
  writeManagedGatewayRuntimeProof(stateDir, 8080);
  return configPath;
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(
    options,
    withSuccessfulPreUninstallBackup(
      withProvenManagedGatewayProcess({
        isPortFree: () => true,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          source: "packaged-service",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        ...deps,
      }),
    ),
  );
}

describe("externally supervised gateway-port segregation (#3053)", () => {
  it.each([
    ["full", "systemd-system"],
    ["full", "systemd-user"],
    ["scoped", "systemd-system"],
    ["scoped", "systemd-user"],
  ] as const)(
    "preserves the gateway process, Docker resources, OpenShell binaries, and gateway state during %s uninstall for a %s-supervised gateway (#6576)",
    async (scope, kind) => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-external-"));
      try {
        const stateDir = path.join(tmpHome, ".nemoclaw");
        const gatewayStatePath = writeScopedGatewayState(tmpHome);
        const gatewayState = fs.readFileSync(gatewayStatePath, "utf-8");
        fs.mkdirSync(stateDir, { recursive: true });
        const prepareScope = {
          full: () => undefined,
          scoped: () =>
            fs.writeFileSync(
              path.join(stateDir, "sandboxes.json"),
              JSON.stringify({
                defaultSandbox: "alpha",
                sandboxes: {
                  alpha: { name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
                  beta: { name: "beta", gatewayName: "nemoclaw-8091", gatewayPort: 8091 },
                },
              }),
            ),
        } as const;
        prepareScope[scope]();
        const calls: Array<{ args: string[]; command: string }> = [];
        const dockerCalls: string[][] = [];
        const kill = vi.fn(() => true);
        const externalPid = 4242;
        const externalStateDir = path.dirname(gatewayStatePath);

        const result = await runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: false },
          {
            commandExists: () => true,
            env: { HOME: tmpHome, LOGNAME: "tester" } as NodeJS.ProcessEnv,
            existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
            isTty: false,
            kill,
            log: vi.fn(),
            resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
              gatewayName,
              gatewayPort,
              mode: "externally-supervised",
              source: "declared",
              endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
              stateDir: externalStateDir,
              supervisor: {
                kind,
                serviceName: "openshell-gateway.service",
                execPath: "/usr/local/bin/openshell-gateway",
              },
              requiredCapabilities: [],
            }),
            readProcessEnvironment: (pid) =>
              pid === externalPid
                ? {
                    NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(externalStateDir),
                  }
                : null,
            readProcessExecutable: () => "/usr/local/bin/openshell-gateway",
            rmSync: fs.rmSync,
            run: (command, args) => {
              calls.push({ args, command });
              return (
                (command === "systemctl" &&
                  args.includes("--property=MainPID") &&
                  ok(`${String(externalPid)}\n`)) ||
                (command === "ps" &&
                  args.includes("uid=") &&
                  ok(`${String(process.getuid?.() ?? -1)}\n`)) ||
                (command === "ps" &&
                  args.includes("args=") &&
                  ok("/usr/local/bin/openshell-gateway --name nemoclaw --port 8080\n")) ||
                ok()
              );
            },
            runDocker: (args) => {
              dockerCalls.push(args);
              return ok();
            },
          },
        );

        expect(result.exitCode).toBe(0);
        const openshellCalls = calls
          .filter(({ command }) => command === "openshell")
          .map(({ args }) => args);
        expect(openshellCalls).toContainEqual(["gateway", "remove", "nemoclaw"]);
        expect(openshellCalls).not.toContainEqual(["gateway", "destroy", "-g", "nemoclaw"]);
        expect(
          calls.some(
            ({ command, args }) =>
              !(command === "systemctl" && args.includes("--property=MainPID")) &&
              args.join(" ").includes("openshell-gateway"),
          ),
        ).toBe(false);
        expect(kill).not.toHaveBeenCalled();
        expect(dockerCalls).toEqual([]);
        expect(
          calls.some(
            ({ command, args }) =>
              command === "rm" && args.includes("/usr/local/bin/openshell-gateway"),
          ),
        ).toBe(false);
        expect(fs.existsSync(gatewayStatePath)).toBe(true);
        expect(fs.readFileSync(gatewayStatePath, "utf8")).toBe(gatewayState);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );
});
