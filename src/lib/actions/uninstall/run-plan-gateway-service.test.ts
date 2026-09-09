// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../../onboard/docker-driver-gateway-config";
import { getDockerDriverGatewayRuntimeMarkerPath } from "../../onboard/docker-driver-gateway-runtime-marker";
import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
} from "../../onboard/docker-driver-gateway-service";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import { type RunResult, runUninstallPlanProduction, type UninstallRunDeps } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

interface Fixture {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(useXdg = false): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: useXdg ? path.join(root, "xdg-config") : "",
    },
    home,
    root,
  };
}

function writeManagedService(test: Fixture): string {
  writeGatewayState(test);
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(
    servicePath,
    `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n[Service]\nExecStart=${test.home}/.local/bin/openshell-gateway\n`,
  );
  return servicePath;
}

function writeGatewayEnv(test: Fixture, contents = "OPENSHELL_SERVER_PORT=8080\n"): string {
  const envPath = path.join(
    getOpenShellUserConfigHome(test.home, test.env),
    "openshell",
    "gateway.env",
  );
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, contents);
  return envPath;
}

function writeSelectedSandboxRegistry(test: Fixture, sandboxName: string): string {
  const registryPath = path.join(test.home, ".nemoclaw", "sandboxes.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: { name: sandboxName, gatewayName: "nemoclaw", gatewayPort: 8080 },
      },
    })}\n`,
  );
  return registryPath;
}

function writeGatewayState(test: Fixture): string {
  const stateDir = path.join(test.home, ".local", "state", "nemoclaw", "openshell-docker-gateway");
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

function uninstall(
  test: Fixture,
  keepOpenShell: boolean,
  deps: Partial<UninstallRunDeps> = {},
  gateways: { name: string }[] = [{ name: "nemoclaw" }],
) {
  const { commandExists = () => false, run = () => ok(), ...overrides } = deps;
  return runUninstallPlanProduction(
    { assumeYes: true, deleteModels: false, keepOpenShell },
    withProvenManagedGatewayProcess({
      backupAllBeforeUninstall: async () => undefined,
      env: test.env,
      existsSync: (target) => String(target).startsWith(test.root) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isPortFree: () => true,
      isTty: false,
      platform: "linux",
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
      rmSync: fs.rmSync,
      runDocker: () => ok(),
      withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
      ...overrides,
      commandExists: (command) => command === "openshell" || commandExists(command),
      run: (command, args, options) => {
        const delegated = run(command, args, options);
        return (
          (command === "openshell" &&
            args[0] === "gateway" &&
            args[1] === "list" &&
            ok(JSON.stringify(gateways))) ||
          (command === "systemctl" &&
            args.includes("--property=MainPID") &&
            delegated.stdout === "" &&
            ok("0\n")) ||
          delegated
        );
      },
    }),
  );
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps the service, env, gateway process, and state with --keep-openshell (#7830)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const run = vi.fn((_command: string, _args: string[]) => ok());

    expect((await uninstall(test, true, { commandExists: () => true, run })).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
    expect(run.mock.calls.map(([, args]) => args)).not.toContainEqual([
      "-f",
      HOST_GATEWAY_PGREP_PATTERN,
    ]);
  });

  it("keeps selected gateway state when sibling gateways require scoped cleanup (#7830)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);

    const result = await uninstall(test, true, { commandExists: () => true }, [
      { name: "nemoclaw" },
      { name: "sibling" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("deletes a scoped sandbox through the package-managed service without standalone runtime files", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const stateDir = path.join(
      test.home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
    );
    fs.rmSync(path.join(stateDir, "openshell-gateway.pid"));
    fs.rmSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir));
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        run: (command, args) => {
          calls.push([command, ...args]);
          return ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toContainEqual([
      "openshell",
      "sandbox",
      "delete",
      "-g",
      "nemoclaw",
      "my-assistant",
    ]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("does not delete a sandbox when the package-managed service identity changes", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const stateDir = path.join(
      test.home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
    );
    fs.rmSync(path.join(stateDir, "openshell-gateway.pid"));
    fs.rmSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir));
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");
    const calls: string[][] = [];
    const errors: string[] = [];
    const serviceIdentity = vi
      .fn()
      .mockReturnValueOnce({ executablePath: "/usr/bin/openshell-gateway", pid: 4242 })
      .mockReturnValue({ executablePath: "/usr/bin/openshell-gateway", pid: 4243 });

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        error: (message) => errors.push(message),
        getTrustedActiveOpenShellGatewayUserServiceIdentity: serviceIdentity,
        readProcessEnvironment: () => ({
          [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(stateDir),
        }),
        readProcessExecutable: () => "/usr/bin/openshell-gateway",
        run: (command, args) => {
          calls.push([command, ...args]);
          return command === "ps" && args.includes("uid=")
            ? ok(`${String(process.getuid?.() ?? -1)}\n`)
            : ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(1);
    expect(
      calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
    ).toBe(false);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
    expect(errors.join("\n")).toContain(
      "package-managed OpenShell gateway service identity changed",
    );
  });

  it("does not delete a sandbox when the package-managed service changes namespace", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const stateDir = path.join(
      test.home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway",
    );
    fs.rmSync(path.join(stateDir, "openshell-gateway.pid"));
    fs.rmSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir));
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");
    const calls: string[][] = [];
    const errors: string[] = [];
    let namespaceReads = 0;
    const realpathSync = vi.fn((target: string) => target);

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        error: (message) => errors.push(message),
        getTrustedActiveOpenShellGatewayUserServiceIdentity: () => ({
          executablePath: "/usr/bin/openshell-gateway",
          pid: 4242,
        }),
        readProcessEnvironment: () => {
          namespaceReads += 1;
          return {
            [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]:
              namespaceReads === 1 ? gatewayIdForStateDir(stateDir) : "default",
          };
        },
        readProcessExecutable: () => "/usr/bin/openshell-gateway",
        realpathSync,
        run: (command, args) => {
          calls.push([command, ...args]);
          return command === "ps" && args.includes("uid=")
            ? ok(`${String(process.getuid?.() ?? -1)}\n`)
            : ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(1);
    expect(namespaceReads).toBe(2);
    expect(realpathSync).toHaveBeenCalledWith("/usr/bin/openshell-gateway");
    expect(
      calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
    ).toBe(false);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
    expect(errors.join("\n")).toContain(
      "package-managed OpenShell gateway service sandbox namespace changed",
    );
  });

  it("keeps selected gateway state during scoped cleanup under external supervision (#6576)", async () => {
    const test = fixture(true);
    const gatewayStatePath = writeGatewayState(test);
    const stateDir = path.dirname(gatewayStatePath);
    const pid = 4242;

    const result = await uninstall(
      test,
      false,
      {
        commandExists: () => true,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "externally-supervised",
          source: "declared",
          endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
          stateDir,
          supervisor: {
            kind: "systemd-user",
            serviceName: "external-openshell.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
        readProcessEnvironment: () => ({
          NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(stateDir),
        }),
        readProcessExecutable: () => "/usr/local/bin/openshell-gateway",
        run: (command, args) =>
          command === "systemctl" && args.includes("--property=MainPID")
            ? ok(`${String(pid)}\n`)
            : command === "ps" && args.includes("uid=")
              ? ok(`${String(process.getuid?.() ?? -1)}\n`)
              : command === "ps" && args.includes("args=")
                ? ok("/usr/local/bin/openshell-gateway --name nemoclaw --port 8080\n")
                : ok(),
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("does not mutate scoped resources when an external authority names another state root", async () => {
    const test = fixture(true);
    const localConfigPath = writeGatewayState(test);
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");
    const calls: string[][] = [];
    const errors: string[] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: () => true,
        error: (message) => errors.push(message),
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "externally-supervised",
          source: "declared",
          endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
          stateDir: path.join(test.root, "external-gateway-state"),
          supervisor: {
            kind: "systemd-user",
            serviceName: "external-openshell.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          return ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(localConfigPath)).toBe(true);
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
    expect(
      calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
    ).toBe(false);
    expect(errors).toContain(
      "Refusing scoped gateway cleanup because the externally supervised process's loaded sandbox namespace cannot be proven.",
    );
  });

  it("does not delete a sandbox when an external service changes namespace before deletion", async () => {
    const test = fixture(true);
    const configPath = writeGatewayState(test);
    const stateDir = path.dirname(configPath);
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");
    const pid = 4242;
    let namespaceReads = 0;
    const calls: string[][] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: () => true,
        readProcessEnvironment: () => {
          namespaceReads += 1;
          return {
            NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE:
              namespaceReads === 1 ? gatewayIdForStateDir(stateDir) : "default",
          };
        },
        readProcessExecutable: () => "/usr/local/bin/openshell-gateway",
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "externally-supervised",
          source: "declared",
          endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
          stateDir,
          supervisor: {
            kind: "systemd-user",
            serviceName: "external-openshell.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          return (
            (command === "systemctl" &&
              args.includes("--property=MainPID") &&
              ok(`${String(pid)}\n`)) ||
            (command === "ps" &&
              args.includes("uid=") &&
              ok(`${String(process.getuid?.() ?? -1)}\n`)) ||
            (command === "ps" &&
              args.includes("args=") &&
              ok("/usr/local/bin/openshell-gateway --name nemoclaw --port 8080\n")) ||
            ok()
          );
        },
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(1);
    expect(
      calls.some(
        ([command, resource, action]) =>
          command === "openshell" && resource === "gateway" && action === "select",
      ),
    ).toBe(false);
    expect(
      calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
    ).toBe(false);
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
  });

  it("does not delete a sandbox when a managed gateway namespace is unproven before deletion", async () => {
    const test = fixture(true);
    writeGatewayState(test);
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const registryBefore = fs.readFileSync(registryPath, "utf-8");
    const calls: string[][] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: () => true,
        readProcessEnvironment: () => ({
          [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: "default",
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          return ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(1);
    expect(
      calls.some(
        ([command, resource, action]) =>
          command === "openshell" && resource === "gateway" && action === "select",
      ),
    ).toBe(false);
    expect(
      calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
    ).toBe(false);
    expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
  });

  it("deletes the selected sandbox before it disables the marked Linux unit on scoped uninstall (#8220)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];
    const dockerCalls: string[][] = [];
    let gatewayStopped = false;

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl" || command === "docker",
        run: (command, args) => {
          calls.push([command, ...args]);
          gatewayStopped ||= command === "systemctl" && args.includes("disable");
          // `systemctl disable --now` also stops the OpenShell gateway service,
          // so every scoped `openshell` call fails once the unit is disabled.
          return command === "openshell" && gatewayStopped
            ? { status: 1, stdout: "", stderr: "gateway unreachable" }
            : ok();
        },
        runDocker: (args) => {
          dockerCalls.push(args);
          return args[0] === "ps"
            ? ok("sandbox-id openshell/sandbox openshell-cluster-nemoclaw\n")
            : ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    const deletedAt = calls.findIndex(
      (call) => call[0] === "openshell" && call[1] === "sandbox" && call[2] === "delete",
    );
    const disabledAt = calls.findIndex(
      (call) => call[0] === "systemctl" && call.includes("disable"),
    );

    expect(result.exitCode).toBe(0);
    expect(deletedAt).toBeGreaterThanOrEqual(0);
    expect(disabledAt).toBeGreaterThan(deletedAt);
    expect(dockerCalls).toContainEqual(["rm", "-f", "sandbox-id"]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it.each([
    { externallySupervised: false, keepOpenShell: false, mode: "managed cleanup" },
    { externallySupervised: false, keepOpenShell: true, mode: "--keep-openshell" },
    { externallySupervised: true, keepOpenShell: false, mode: "external supervision" },
  ])(
    "does not mutate scoped resources with an unproven sandbox namespace under $mode (#8663)",
    async ({ externallySupervised, keepOpenShell }) => {
      const test = fixture(true);
      const servicePath = writeManagedService(test);
      const configPath = writeGatewayState(test);
      const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
      const registryBefore = fs.readFileSync(registryPath, "utf-8");
      fs.writeFileSync(configPath, '[openshell.drivers.docker]\nsandbox_namespace = "default"\n');
      const calls: string[][] = [];
      const errors: string[] = [];

      const externalAuthority = externallySupervised
        ? {
            resolveGatewayTeardownAuthority: ({
              gatewayName,
              gatewayPort,
            }: {
              gatewayName: string;
              gatewayPort: number;
            }) => ({
              gatewayName,
              gatewayPort,
              mode: "externally-supervised" as const,
              source: "declared" as const,
              endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
              stateDir: path.dirname(configPath),
              supervisor: {
                kind: "systemd-user" as const,
                serviceName: "external-openshell.service",
                execPath: "/usr/local/bin/openshell-gateway",
              },
              requiredCapabilities: [],
            }),
          }
        : {};
      const deps: Partial<UninstallRunDeps> = {
        commandExists: (command) => command === "systemctl",
        run: (command, args) => {
          calls.push([command, ...args]);
          return ok();
        },
        error: (message) => errors.push(message),
        ...externalAuthority,
      };

      const result = await uninstall(test, keepOpenShell, deps, [
        { name: "nemoclaw" },
        { name: "nemoclaw-8081" },
      ]);

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.readFileSync(registryPath, "utf-8")).toBe(registryBefore);
      expect(
        calls.some(([command, resource]) => command === "openshell" && resource === "sandbox"),
      ).toBe(false);
      expect(
        calls.some(
          ([command, resource, action]) =>
            command === "openshell" && resource === "gateway" && action === "remove",
        ),
      ).toBe(false);
      expect(
        calls.some(
          ([command, ...args]) => command === "systemctl" && !args.includes("--property=MainPID"),
        ),
      ).toBe(false);
      expect(errors).toContain(
        externallySupervised
          ? "Refusing scoped gateway cleanup because the externally supervised process's loaded sandbox namespace cannot be proven."
          : "Refusing scoped gateway cleanup because its sandbox namespace cannot be proven.",
      );
    },
  );

  it("preserves the marked Linux unit when scoped sandbox deletion fails (#8220)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        run: (command, args) => {
          calls.push([command, ...args]);
          return command === "openshell" && args[0] === "sandbox"
            ? { status: 1, stdout: "", stderr: "sandbox unreachable" }
            : ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    // Sandbox deletion failed, so uninstall returns before it removes the gateway registration.
    // It preserves the marked Linux unit and the running OpenShell gateway service for a retry.
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(false);
  });

  it("preserves the marked Linux unit when scoped gateway registration removal fails (#8220)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];

    const result = await uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        run: (command, args) => {
          calls.push([command, ...args]);
          return command === "openshell" && args[0] === "gateway" && args[1] === "remove"
            ? { status: 1, stdout: "", stderr: "gateway registration is busy" }
            : ok();
        },
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    // Sandbox deletion succeeded, so this pins the second cleanup boundary: registration
    // removal failed, and uninstall still returns before it removes the gateway service.
    expect(calls).toContainEqual([
      "openshell",
      "sandbox",
      "delete",
      "-g",
      "nemoclaw",
      "my-assistant",
    ]);
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(false);
  });

  it("retries scoped cleanup after marked Linux unit cleanup fails (#8220)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const gatewayStatePath = writeGatewayState(test);
    const registryPath = writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];
    const kill = vi.fn();
    const runDocker = vi.fn(() => ok());
    const disableService = vi
      .fn<() => RunResult>()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "service is busy" })
      .mockReturnValue(ok());
    const deps = {
      commandExists: (command: string) =>
        command === "systemctl" || command === "pgrep" || command === "docker",
      kill,
      runDocker,
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return command === "systemctl" && args.includes("disable") ? disableService() : ok();
      },
    };

    const result = await uninstall(test, false, deps, [
      { name: "nemoclaw" },
      { name: "nemoclaw-8081" },
    ]);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(true);
    expect(calls.some((call) => call[0] === "pgrep")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(runDocker).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(registryPath, "utf-8")).sandboxes).toEqual({});

    const retry = await uninstall(test, false, deps, [
      { name: "nemoclaw" },
      { name: "nemoclaw-8081" },
    ]);

    expect(retry.exitCode).toBe(0);
    expect(disableService).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(gatewayStatePath)).toBe(false);
    expect(
      calls.filter(
        (call) => call[0] === "openshell" && call[1] === "gateway" && call[2] === "select",
      ),
    ).toHaveLength(0);
    expect(
      calls.filter(
        (call) => call[0] === "openshell" && call[1] === "sandbox" && call[2] === "delete",
      ),
    ).toHaveLength(1);
    expect(kill).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalled();
  });

  it("removes only the marked Linux unit and managed env on full uninstall (#6903)", async () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const calls: string[][] = [];

    const result = await uninstall(test, false, {
      commandExists: (command) => command === "systemctl",
      run: (command, args) => {
        calls.push([command, ...args]);
        return ok();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(fs.existsSync(gatewayStatePath)).toBe(false);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
    ]);
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });

  it("opts full uninstall gateway teardown into missing packaged-service recovery (#8215)", async () => {
    const test = fixture(true);
    const resolveGatewayTeardownAuthority = vi.fn(({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed" as const,
      source: "standalone" as const,
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }));

    const result = await uninstall(test, false, {
      commandExists: () => true,
      resolveGatewayTeardownAuthority,
    });

    expect(result.exitCode).toBe(0);
    expect(resolveGatewayTeardownAuthority).toHaveBeenCalledWith(
      { gatewayName: "nemoclaw", gatewayPort: 8080 },
      expect.objectContaining({ allowMissingPackagedServiceTeardown: true }),
    );
  });

  it("reports an incomplete uninstall when the marked service cannot be disabled (#6903)", async () => {
    const test = fixture();
    const servicePath = writeManagedService(test);
    const errors: string[] = [];
    const run = vi.fn((command: string, args: string[]) =>
      command === "systemctl" && args.includes("disable")
        ? { status: 1, stdout: "", stderr: "failed" }
        : ok(),
    );

    const result = await uninstall(test, false, {
      commandExists: (command) => ["systemctl", "npm"].includes(command),
      error: (line) => errors.push(line),
      run,
    });

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    const failedDisableIndex = run.mock.calls.findIndex(
      ([command, args]) => command === "systemctl" && args.includes("disable"),
    );
    const npmCleanupIndex = run.mock.calls.findIndex(
      ([command, args], index) =>
        index > failedDisableIndex &&
        command === "npm" &&
        args.join(" ") === "uninstall -g --loglevel=error nemoclaw",
    );
    expect(failedDisableIndex).toBeGreaterThanOrEqual(0);
    expect(npmCleanupIndex).toBeGreaterThan(failedDisableIndex);
    expect(errors).toContain(
      "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
    );
  });

  it("preserves a foreign unit at the NemoClaw service path (#6903)", async () => {
    const test = fixture();
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, "# foreign service\n");

    expect((await uninstall(test, false)).exitCode).toBe(0);
    expect(fs.readFileSync(servicePath, "utf-8")).toBe("# foreign service\n");
  });

  it("refuses to follow symlinked service and env files (#6903)", async () => {
    const test = fixture();
    const serviceTarget = path.join(test.root, "foreign.service");
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
    const envTarget = path.join(test.root, "foreign.env");
    const envPath = path.join(
      getOpenShellUserConfigHome(test.home, test.env),
      "openshell",
      "gateway.env",
    );
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(serviceTarget, `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`);
    fs.writeFileSync(envTarget, "KEEP_ME=1\n");
    fs.symlinkSync(serviceTarget, servicePath);
    fs.symlinkSync(envTarget, envPath);

    expect((await uninstall(test, false)).exitCode).toBe(1);
    expect(fs.readFileSync(serviceTarget, "utf-8")).toContain(
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
    );
    expect(fs.readFileSync(envTarget, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("removes managed env keys while preserving unrelated content (#6903)", async () => {
    const test = fixture();
    const envPath = writeGatewayEnv(
      test,
      [
        "KEEP_ME=1",
        "OPENSHELL_SERVER_PORT=8080",
        "OPENSHELL_BIND_ADDRESS=127.0.0.1",
        "DOCKER_HOST='unix:///tmp/docker.sock'",
        "",
      ].join("\n"),
    );

    expect((await uninstall(test, false)).exitCode).toBe(0);
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("does not remove the Linux unit on macOS (#6903)", async () => {
    const test = fixture();
    const servicePath = writeManagedService(test);

    expect((await uninstall(test, false, { platform: "darwin" })).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
  });
});
