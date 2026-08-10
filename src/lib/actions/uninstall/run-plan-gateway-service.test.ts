// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getNemoclawOpenShellGatewayUserServicePath,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
} from "../../onboard/docker-driver-gateway-service";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import { type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

type RunResponder = () => RunResult;

function commandSignature(command: string, args: readonly string[]): string {
  return [command, ...args].join("\0");
}

function systemctlShowSignature(serviceName: string): string {
  return commandSignature("systemctl", [
    "--user",
    "show",
    serviceName,
    "--property=FragmentPath",
    "--property=ExecStart",
    "--property=ExecStop",
    "--property=ExecStopPost",
    "--property=ActiveState",
    "--property=MainPID",
    "--property=Restart",
    "--property=KillSignal",
    "--property=KillMode",
  ]);
}

function runFromResponses(
  responses: ReadonlyMap<string, RunResponder>,
  calls: string[][],
  fallback: NonNullable<UninstallRunDeps["run"]> = () => ok(),
): NonNullable<UninstallRunDeps["run"]> {
  return (command, args, options) => {
    calls.push([command, ...args]);
    return (
      responses.get(commandSignature(command, args)) ?? (() => fallback(command, args, options))
    )();
  };
}

interface Fixture {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
}

const tempRoots: string[] = [];
const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : 0;

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
  const configPath = path.join(
    test.home,
    ".local",
    "state",
    "nemoclaw",
    "openshell-docker-gateway",
    "openshell-gateway.toml",
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'listen_address = "127.0.0.1:8080"\n');
  return configPath;
}

function managedSystemdShow(
  test: Fixture,
  options: {
    active: boolean;
    effectiveScopedStop?: boolean;
    execStartPath?: string;
    fragmentPath?: string;
    mainPid: number;
  },
): string {
  const gatewayBin = options.execStartPath ?? `${test.home}/.local/bin/openshell-gateway`;
  const servicePath =
    options.fragmentPath ?? getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
  return [
    `FragmentPath=${servicePath}`,
    `ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
    "ExecStop=",
    "ExecStopPost=",
    `ActiveState=${options.active ? "active" : "inactive"}`,
    `MainPID=${String(options.active ? options.mainPid : 0)}`,
    `Restart=${options.effectiveScopedStop ? "no" : "on-failure"}`,
    `KillSignal=${options.effectiveScopedStop ? "SIGKILL" : "SIGTERM"}`,
    "KillMode=control-group",
  ].join("\n");
}

function uninstall(
  test: Fixture,
  keepOpenShell: boolean,
  deps: Partial<UninstallRunDeps> = {},
  gateways: { name: string }[] = [{ name: "nemoclaw" }],
) {
  const {
    commandExists = () => false,
    isPortFree = () => true,
    run = () => ok(),
    ...overrides
  } = deps;
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
  const gatewayBin = `${test.home}/.local/bin/openshell-gateway`;
  const inactiveSystemdShow = ok(
    [
      `FragmentPath=${servicePath}`,
      `ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
      "ExecStop=",
      "ExecStopPost=",
      "ActiveState=inactive",
      "MainPID=0",
      "Restart=on-failure",
      "KillSignal=15",
      "KillMode=control-group",
    ].join("\n"),
  );
  const defaultSystemdShows = new Map<string, RunResult>([
    [systemctlShowSignature(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE), inactiveSystemdShow],
  ]);
  const gatewayListSignature = commandSignature("openshell", ["gateway", "list", "-o", "json"]);
  const defaultResponses = new Map<string, RunResult>([
    [gatewayListSignature, ok(JSON.stringify(gateways))],
  ]);
  return runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell },
    {
      env: test.env,
      existsSync: (target) => String(target).startsWith(test.root) && fs.existsSync(target),
      isTty: false,
      isPortFree,
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
      ...overrides,
      // A scoped uninstall with no PID evidence may only conclude that the
      // gateway is absent after a complete empty listener observation.
      commandExists: (command) =>
        command === "openshell" || command === "lsof" || commandExists(command),
      run: (command, args, options) => {
        const signature = commandSignature(command, args);
        const response = defaultResponses.get(signature) ?? run(command, args, options);
        const defaultSystemdShow =
          response.status === 0 && response.stdout === ""
            ? defaultSystemdShows.get(signature)
            : undefined;
        return defaultSystemdShow ?? response;
      },
    },
  );
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps the service, env, gateway process, and state with --keep-openshell (#7830)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const run = vi.fn((_command: string, _args: string[]) => ok());

    expect(uninstall(test, true, { commandExists: () => true, run }).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
    expect(run.mock.calls.map(([, args]) => args)).not.toContainEqual([
      "-f",
      HOST_GATEWAY_PGREP_PATTERN,
    ]);
  });

  it("keeps selected gateway state when sibling gateways require scoped cleanup (#7830)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);

    const result = uninstall(test, true, { commandExists: () => true }, [
      { name: "nemoclaw" },
      { name: "sibling" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("keeps selected gateway state during scoped cleanup under external supervision (#6576)", () => {
    const test = fixture(true);
    const gatewayStatePath = writeGatewayState(test);

    const result = uninstall(
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
          stateDir: path.dirname(gatewayStatePath),
          supervisor: {
            kind: "systemd-user",
            serviceName: "external-openshell.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
      },
      [{ name: "nemoclaw" }, { name: "sibling" }],
    );

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
  });

  it("deletes the selected sandbox before it disables the marked Linux unit on scoped uninstall (#8220)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];
    const dockerCalls: string[][] = [];
    let gatewayStopped = false;

    const result = uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl" || command === "docker",
        run: (command, args) => {
          calls.push([command, ...args]);
          gatewayStopped ||= command === "systemctl" && args.includes("disable");
          // Scoped cleanup must finish its OpenShell calls before disabling
          // the unit. The disable intentionally omits --now.
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
    expect(calls[disabledAt]).toEqual([
      "systemctl",
      "--user",
      "disable",
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
    ]);
    expect(calls[disabledAt]).not.toContain("--now");
    expect(dockerCalls).toContainEqual(["rm", "-f", "sandbox-id"]);
    expect(fs.existsSync(servicePath)).toBe(false);
  });

  it("proves and SIGKILL-stops only the active managed service after scoped sandbox cleanup (#8663)", () => {
    const test = fixture(true);
    test.env.LOGNAME = "gateway-owner";
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const gatewayBin = `${test.home}/.local/bin/openshell-gateway`;
    const mainPid = 41_101;
    const calls: string[][] = [];
    const events: string[] = [];
    let scopedOverrideLoaded = false;
    let serviceStopped = false;
    const isPortFree = vi.fn(() => serviceStopped);
    const kill = vi.fn(() => true);
    const readProcessExecutable = vi.fn(() => gatewayBin);
    const readProcessStartIdentity = vi.fn(() => "boot-identity:12345");
    const daemonReload = vi
      .fn<() => RunResult>()
      .mockImplementationOnce(() => {
        events.push("daemon-reload");
        const dropInPath = path.join(`${servicePath}.d`, "99-nemoclaw-scoped-uninstall.conf");
        expect(fs.readFileSync(dropInPath, "utf-8")).toBe(
          "[Service]\nRestart=no\nKillSignal=SIGKILL\nKillMode=control-group\n",
        );
        scopedOverrideLoaded = true;
        return ok();
      })
      .mockImplementation(() => {
        events.push("daemon-reload");
        return ok();
      });
    const runResponses = new Map<string, RunResponder>([
      [
        commandSignature("openshell", ["sandbox", "delete", "my-assistant"]),
        () => {
          events.push("sandbox-delete");
          return ok();
        },
      ],
      [
        systemctlShowSignature(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
        () =>
          ok(
            managedSystemdShow(test, {
              active: !serviceStopped,
              effectiveScopedStop: scopedOverrideLoaded,
              mainPid,
            }),
          ),
      ],
      [commandSignature("systemctl", ["--user", "daemon-reload"]), daemonReload],
      [
        commandSignature("systemctl", [
          "--user",
          "disable",
          "--now",
          NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
        ]),
        () => {
          events.push("disable-now");
          expect(scopedOverrideLoaded).toBe(true);
          serviceStopped = true;
          return ok();
        },
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "uid="]),
        () => ok(`${String(CURRENT_UID)}\n`),
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "pid="]),
        () => (serviceStopped ? { status: 1, stdout: "", stderr: "" } : ok(`${mainPid}\n`)),
      ],
      [
        commandSignature("lsof", ["-ti", ":8080", "-sTCP:LISTEN"]),
        () => (serviceStopped ? ok() : ok(`${mainPid}\n`)),
      ],
    ]);

    const result = uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        isPortFree,
        kill,
        readProcessExecutable,
        readProcessStartIdentity,
        run: runFromResponses(runResponses, calls),
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(0);
    expect(events.slice(0, 3)).toEqual(["sandbox-delete", "daemon-reload", "disable-now"]);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
    ]);
    expect(readProcessExecutable).toHaveBeenCalledTimes(2);
    expect(readProcessExecutable).toHaveBeenNthCalledWith(1, mainPid);
    expect(readProcessExecutable).toHaveBeenNthCalledWith(2, mainPid);
    expect(readProcessStartIdentity).toHaveBeenCalledTimes(2);
    expect(readProcessStartIdentity).toHaveBeenNthCalledWith(1, mainPid);
    expect(readProcessStartIdentity).toHaveBeenNthCalledWith(2, mainPid);
    expect(serviceStopped).toBe(true);
    expect(isPortFree).toHaveBeenCalledWith(8080);
    expect(
      calls.some(
        (call) =>
          call[0] === "ps" &&
          call[1] === "-p" &&
          call[2] === String(mainPid) &&
          call.at(-1) === "pid=",
      ),
    ).toBe(true);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(`${servicePath}.d`)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(calls.some((call) => call[0] === "pgrep")).toBe(false);
  });

  it("SIGKILL-stops but preserves a trusted package-owned gateway service (#8663)", () => {
    const test = fixture(true);
    test.env.LOGNAME = "gateway-owner";
    writeSelectedSandboxRegistry(test, "my-assistant");
    const servicePath = "/usr/lib/systemd/user/openshell-gateway.service";
    const gatewayBin = "/usr/bin/openshell-gateway";
    const mainPid = 41_301;
    const dropInPath = path.join(
      getOpenShellUserConfigHome(test.home, test.env),
      "systemd",
      "user",
      "openshell-gateway.service.d",
      "99-nemoclaw-scoped-uninstall.conf",
    );
    const calls: string[][] = [];
    let scopedOverrideLoaded = false;
    let serviceStopped = false;
    const runResponses = new Map<string, RunResponder>([
      [
        systemctlShowSignature("openshell-gateway"),
        () =>
          ok(
            managedSystemdShow(test, {
              active: !serviceStopped,
              effectiveScopedStop: scopedOverrideLoaded,
              execStartPath: gatewayBin,
              fragmentPath: servicePath,
              mainPid,
            }),
          ),
      ],
      [
        commandSignature("systemctl", ["--user", "daemon-reload"]),
        () => {
          scopedOverrideLoaded = fs.existsSync(dropInPath);
          return ok();
        },
      ],
      [
        commandSignature("systemctl", ["--user", "stop", "openshell-gateway"]),
        () => {
          expect(scopedOverrideLoaded).toBe(true);
          serviceStopped = true;
          return ok();
        },
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "uid="]),
        () => ok(`${String(CURRENT_UID)}\n`),
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "pid="]),
        () => (serviceStopped ? { status: 1, stdout: "", stderr: "" } : ok(`${mainPid}\n`)),
      ],
      [
        commandSignature("lsof", ["-ti", ":8080", "-sTCP:LISTEN"]),
        () => (serviceStopped ? ok() : ok(`${mainPid}\n`)),
      ],
    ]);

    const result = uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        existsSync: (target) =>
          target === servicePath ||
          (String(target).startsWith(test.root) && fs.existsSync(String(target))),
        isPortFree: () => serviceStopped,
        readProcessExecutable: () => gatewayBin,
        readProcessStartIdentity: () => "boot-identity:package-service",
        run: runFromResponses(runResponses, calls),
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toContainEqual(["systemctl", "--user", "stop", "openshell-gateway"]);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(false);
    expect(calls.some((call) => call[0] === "pgrep")).toBe(false);
    expect(serviceStopped).toBe(true);
    expect(fs.existsSync(dropInPath)).toBe(false);
  });

  it("removes an owned scoped-stop override when retrying inactive service cleanup (#8663)", () => {
    const test = fixture(true);
    test.env.LOGNAME = "gateway-owner";
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const gatewayBin = `${test.home}/.local/bin/openshell-gateway`;
    const mainPid = 41_302;
    const dropInPath = path.join(`${servicePath}.d`, "99-nemoclaw-scoped-uninstall.conf");
    let failFirstDropInRemoval = true;
    let scopedOverrideLoaded = false;
    let serviceStopped = false;
    const calls: string[][] = [];
    const runResponses = new Map<string, RunResponder>([
      [
        systemctlShowSignature(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
        () =>
          ok(
            managedSystemdShow(test, {
              active: !serviceStopped,
              effectiveScopedStop: scopedOverrideLoaded,
              mainPid,
            }),
          ),
      ],
      [
        commandSignature("systemctl", ["--user", "daemon-reload"]),
        () => {
          scopedOverrideLoaded = fs.existsSync(dropInPath);
          return ok();
        },
      ],
      [
        commandSignature("systemctl", [
          "--user",
          "disable",
          "--now",
          NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
        ]),
        () => {
          serviceStopped = true;
          return ok();
        },
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "uid="]),
        () => ok(`${String(CURRENT_UID)}\n`),
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "pid="]),
        () => (serviceStopped ? { status: 1, stdout: "", stderr: "" } : ok(`${mainPid}\n`)),
      ],
      [
        commandSignature("lsof", ["-ti", ":8080", "-sTCP:LISTEN"]),
        () => (serviceStopped ? ok() : ok(`${mainPid}\n`)),
      ],
    ]);
    const run = runFromResponses(runResponses, calls);
    const failDropInRemoval = (): never => {
      throw new Error("injected drop-in removal failure");
    };
    const deps: Partial<UninstallRunDeps> = {
      commandExists: (command) => command === "systemctl",
      isPortFree: () => serviceStopped,
      readProcessExecutable: () => gatewayBin,
      readProcessStartIdentity: () => "boot-identity:retry",
      rmSync: (target, options) => {
        const failThisRemoval = String(target) === dropInPath && failFirstDropInRemoval;
        failFirstDropInRemoval = failFirstDropInRemoval && !failThisRemoval;
        return failThisRemoval ? failDropInRemoval() : fs.rmSync(target, options);
      },
      run,
    };

    const first = uninstall(test, false, deps, [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }]);

    expect(first.exitCode).toBe(1);
    expect(serviceStopped).toBe(true);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(dropInPath)).toBe(true);

    const retry = uninstall(test, false, deps, [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }]);

    expect(retry.exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(dropInPath)).toBe(false);
  });

  it.each([
    {
      label: "the port-8080 listener belongs to a sibling MainPID",
      listenerPid: 41_202,
    },
    {
      fragmentPath: "/tmp/foreign-openshell-gateway.service",
      label: "the loaded unit fragment is ambiguous",
      listenerPid: 41_201,
    },
    {
      label: "the managed process owner differs from the current user",
      listenerPid: 41_201,
      processUid: CURRENT_UID + 1,
    },
  ])("fails closed and preserves the active managed unit when $label (#8663)", (identity) => {
    const test = fixture(true);
    test.env.LOGNAME = "gateway-owner";
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const gatewayBin = `${test.home}/.local/bin/openshell-gateway`;
    const mainPid = 41_201;
    const calls: string[][] = [];
    const kill = vi.fn(() => true);
    const runResponses = new Map<string, RunResponder>([
      [
        systemctlShowSignature(NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE),
        () =>
          ok(
            managedSystemdShow(test, {
              active: true,
              fragmentPath: identity.fragmentPath,
              mainPid,
            }),
          ),
      ],
      [
        commandSignature("ps", ["-p", String(mainPid), "-o", "uid="]),
        () => ok(`${String(identity.processUid ?? CURRENT_UID)}\n`),
      ],
      [
        commandSignature("lsof", ["-ti", ":8080", "-sTCP:LISTEN"]),
        () => ok(`${identity.listenerPid}\n`),
      ],
    ]);

    const result = uninstall(
      test,
      false,
      {
        commandExists: (command) => command === "systemctl",
        isPortFree: () => false,
        kill,
        readProcessExecutable: () => gatewayBin,
        readProcessStartIdentity: () => "boot-identity:12345",
        run: runFromResponses(runResponses, calls),
      },
      [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }],
    );

    expect(result.exitCode).toBe(1);
    expect(calls).toContainEqual(["openshell", "sandbox", "delete", "my-assistant"]);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(false);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("daemon-reload"))).toBe(
      false,
    );
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(`${servicePath}.d`)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(calls.some((call) => call[0] === "pgrep")).toBe(false);
  });

  it("preserves the marked Linux unit when scoped sandbox deletion fails (#8220)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];

    const result = uninstall(
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

  it("preserves the marked Linux unit when scoped gateway registration removal fails (#8220)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    writeSelectedSandboxRegistry(test, "my-assistant");
    const calls: string[][] = [];

    const result = uninstall(
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
    expect(calls).toContainEqual(["openshell", "sandbox", "delete", "my-assistant"]);
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(false);
  });

  it("retries scoped cleanup after marked Linux unit cleanup fails (#8220)", () => {
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

    const result = uninstall(test, false, deps, [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }]);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(fs.existsSync(gatewayStatePath)).toBe(true);
    expect(calls.some((call) => call[0] === "systemctl" && call.includes("disable"))).toBe(true);
    expect(calls.some((call) => call[0] === "pgrep")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(runDocker).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(registryPath, "utf-8")).sandboxes).toEqual({});

    const retry = uninstall(test, false, deps, [{ name: "nemoclaw" }, { name: "nemoclaw-8081" }]);

    expect(retry.exitCode).toBe(0);
    expect(disableService).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(servicePath)).toBe(false);
    expect(fs.existsSync(gatewayStatePath)).toBe(false);
    expect(
      calls.filter(
        (call) => call[0] === "openshell" && call[1] === "gateway" && call[2] === "select",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call[0] === "openshell" && call[1] === "sandbox" && call[2] === "delete",
      ),
    ).toHaveLength(1);
    expect(kill).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalled();
  });

  it("removes only the marked Linux unit and managed env on full uninstall (#6903)", () => {
    const test = fixture(true);
    const servicePath = writeManagedService(test);
    const envPath = writeGatewayEnv(test);
    const gatewayStatePath = writeGatewayState(test);
    const calls: string[][] = [];

    const result = uninstall(test, false, {
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

  it("opts full uninstall gateway teardown into missing packaged-service recovery (#8215)", () => {
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

    const result = uninstall(test, false, {
      commandExists: () => true,
      resolveGatewayTeardownAuthority,
    });

    expect(result.exitCode).toBe(0);
    expect(resolveGatewayTeardownAuthority).toHaveBeenCalledWith(
      { gatewayName: "nemoclaw", gatewayPort: 8080 },
      expect.objectContaining({ allowMissingPackagedServiceTeardown: true }),
    );
  });

  it("reports an incomplete uninstall when the marked service cannot be disabled (#6903)", () => {
    const test = fixture();
    const servicePath = writeManagedService(test);
    const errors: string[] = [];

    const result = uninstall(test, false, {
      commandExists: (command) => command === "systemctl",
      error: (line) => errors.push(line),
      run: (command, args) =>
        command === "systemctl" && args.includes("disable")
          ? { status: 1, stdout: "", stderr: "failed" }
          : ok(),
    });

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(servicePath)).toBe(true);
    expect(errors).toContain(
      "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
    );
  });

  it("preserves a foreign unit at the NemoClaw service path (#6903)", () => {
    const test = fixture();
    const servicePath = getNemoclawOpenShellGatewayUserServicePath(test.home, test.env);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, "# foreign service\n");

    expect(uninstall(test, false).exitCode).toBe(0);
    expect(fs.readFileSync(servicePath, "utf-8")).toBe("# foreign service\n");
  });

  it("refuses to follow symlinked service and env files (#6903)", () => {
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

    expect(uninstall(test, false).exitCode).toBe(1);
    expect(fs.readFileSync(serviceTarget, "utf-8")).toContain(
      NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
    );
    expect(fs.readFileSync(envTarget, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("removes managed env keys while preserving unrelated content (#6903)", () => {
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

    expect(uninstall(test, false).exitCode).toBe(0);
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KEEP_ME=1\n");
  });

  it("does not remove the Linux unit on macOS (#6903)", () => {
    const test = fixture();
    const servicePath = writeManagedService(test);

    expect(uninstall(test, false, { platform: "darwin" }).exitCode).toBe(0);
    expect(fs.existsSync(servicePath)).toBe(true);
  });
});
