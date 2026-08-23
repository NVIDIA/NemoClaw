// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE } from "../../onboard/docker-driver-gateway-service";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";
import { readGatewayRegistryFile } from "../../state/gateway-registry";
import { migrateLegacyPortState } from "../../state/legacy-port-migration";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

const STATIC_TEST_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-segregation-static-"),
);

afterAll(() => {
  fs.rmSync(STATIC_TEST_HOME, { recursive: true, force: true });
});

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function expectGatewayScopedDelete(
  calls: readonly string[][],
  gatewayName: string,
  sandboxName: string,
): void {
  expect(calls).toContainEqual(["sandbox", "delete", "-g", gatewayName, sandboxName]);
  expect(calls.some((args) => args[0] === "gateway" && args[1] === "select")).toBe(false);
}

function externalGatewayProofRunResult(
  command: string,
  args: readonly string[],
  externalPid: number,
  commandLine: string,
): RunResult {
  return (
    (command === "openshell" &&
      args[0] === "gateway" &&
      args[1] === "list" &&
      ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]))) ||
    (command === "systemctl" &&
      args.includes("--property=MainPID") &&
      ok(`${String(externalPid)}\n`)) ||
    (command === "ps" && args.includes("uid=") && ok(`${String(process.getuid?.() ?? -1)}\n`)) ||
    (command === "ps" && args.includes("args=") && ok(`${commandLine}\n`)) ||
    ok()
  );
}

function writeScopedGatewayState(home: string, port = 8080): string {
  const stateDir = path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(port));
  const configPath = path.join(stateDir, "openshell-gateway.toml");
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    configPath,
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: `https://127.0.0.1:${String(port)}`,
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
  writeManagedGatewayRuntimeProof(stateDir, port);
  return configPath;
}

function withManagedGatewayAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  return withProvenManagedGatewayProcess({
    isPortFree: () => true,
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
  });
}

function bindManagedGatewayAuthority(run: typeof runUninstallPlanBase) {
  return (options: UninstallRunOptions, deps: UninstallRunDeps) =>
    run(options, withManagedGatewayAuthority(deps));
}

const runUninstallPlan = bindManagedGatewayAuthority(runUninstallPlanBase);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("uninstall gateway-port segregation (#3053)", () => {
  it.each([
    {
      title: "the executable differs from the declared supervisor executable",
      executable: "/usr/bin/openshell-gateway",
      commandLine: "/usr/local/bin/openshell-gateway --name nemoclaw --port 8080",
    },
    {
      title: "the command line names another gateway",
      executable: "/usr/local/bin/openshell-gateway",
      commandLine: "/usr/local/bin/openshell-gateway --name nemoclaw-8091 --port 8080",
    },
    {
      title: "the command line names another port",
      executable: "/usr/local/bin/openshell-gateway",
      commandLine: "/usr/local/bin/openshell-gateway --name nemoclaw --port 8091",
    },
  ])("refuses scoped cleanup when $title", ({ executable, commandLine }) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-external-proof-"));
    try {
      const shared = path.join(tmpHome, ".nemoclaw");
      const gatewayStatePath = writeScopedGatewayState(tmpHome);
      const externalStateDir = path.dirname(gatewayStatePath);
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(
        path.join(shared, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "alpha",
          sandboxes: {
            alpha: { name: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
            beta: { name: "beta", gatewayName: "nemoclaw-8091", gatewayPort: 8091 },
          },
        }),
      );
      const calls: Array<{ args: string[]; command: string }> = [];
      const warnings: string[] = [];
      const externalPid = 4242;

      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          readProcessEnvironment: () => ({
            NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE: gatewayIdForStateDir(externalStateDir),
          }),
          readProcessExecutable: () => executable,
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "externally-supervised",
            source: "declared",
            endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
            stateDir: externalStateDir,
            supervisor: {
              kind: "systemd-system",
              serviceName: "openshell-gateway.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }),
          rmSync: fs.rmSync,
          run: (command, args) => {
            calls.push({ args, command });
            return externalGatewayProofRunResult(command, args, externalPid, commandLine);
          },
          runDocker: () => ok(),
          error: (message) => warnings.push(message),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(
        calls.some(
          ({ command, args }) =>
            command === "openshell" && args[0] === "sandbox" && args[1] === "delete",
        ),
      ).toBe(false);
      expect(warnings.join("\n")).toContain(
        "Refusing scoped gateway cleanup because the externally supervised process identity cannot be proven",
      );
      expect(fs.existsSync(gatewayStatePath)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not use legacy gateway destroy when external registration removal is unsupported (#6576)", () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const responses = new Map<string, RunResult>([
      ["openshell gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
      [
        "openshell gateway remove nemoclaw",
        { status: 2, stdout: "", stderr: "unrecognized subcommand 'remove'" },
      ],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell",
        env: { HOME: STATIC_TEST_HOME } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "externally-supervised",
          source: "declared",
          endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
          stateDir: "/var/lib/openshell/gateway",
          supervisor: {
            kind: "systemd-system",
            serviceName: "openshell-gateway.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
        rmSync: vi.fn(),
        run: (command, args) => {
          calls.push({ args, command });
          return responses.get([command, ...args].join(" ")) ?? ok();
        },
        runDocker: () => ok(),
      },
    );

    expect(result.exitCode).toBe(0);
    const openshellCalls = calls
      .filter(({ command }) => command === "openshell")
      .map(({ args }) => args);
    expect(openshellCalls).toContainEqual(["gateway", "remove", "nemoclaw"]);
    expect(openshellCalls).not.toContainEqual(["gateway", "destroy", "-g", "nemoclaw"]);
  });

  it("fails before uninstall effects when gateway authority revalidation fails (#6576)", () => {
    const run = vi.fn(() => ok());
    const runDocker = vi.fn(() => ok());
    const rmSync = vi.fn();

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: STATIC_TEST_HOME } as NodeJS.ProcessEnv,
        error: vi.fn(),
        existsSync: () => false,
        resolveGatewayTeardownAuthority: () => {
          throw new Error("authority drift");
        },
        rmSync,
        run,
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(runDocker).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("falls back to legacy gateway destroy only when gateway remove is unsupported", () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const responses = new Map<string, RunResult>([
      ["openshell gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
      [
        "openshell gateway remove nemoclaw",
        { status: 2, stdout: "", stderr: "unrecognized subcommand 'remove'" },
      ],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: STATIC_TEST_HOME, TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        rmSync: vi.fn(),
        run: (command, args) => {
          calls.push({ args, command });
          return responses.get([command, ...args].join(" ")) ?? ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    const openshellCalls = calls
      .filter(({ command }) => command === "openshell")
      .map(({ args }) => args);
    expect(openshellCalls).toContainEqual(["gateway", "remove", "nemoclaw"]);
    expect(openshellCalls).toContainEqual(["gateway", "destroy", "-g", "nemoclaw"]);
  });

  it("does not hide a current gateway remove failure behind the legacy verb", () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const warnings: string[] = [];
    const responses = new Map<string, RunResult>([
      ["openshell gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
      ["openshell gateway remove nemoclaw", { status: 1, stdout: "", stderr: "permission denied" }],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: STATIC_TEST_HOME, TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        rmSync: vi.fn(),
        run: (command, args) => {
          calls.push({ args, command });
          return responses.get([command, ...args].join(" ")) ?? ok();
        },
        runDocker: () => ok(""),
        error: (line) => warnings.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    const openshellCalls = calls
      .filter(({ command }) => command === "openshell")
      .map(({ args }) => args);
    expect(openshellCalls).toContainEqual(["gateway", "remove", "nemoclaw"]);
    expect(openshellCalls.some((args) => args[1] === "destroy")).toBe(false);
    expect(warnings.join("\n")).toContain("Gateway 'nemoclaw' already removed or unreachable");
  });

  it("preserves the gateways/ subtree so uninstalling one environment leaves the others", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gwpreserve-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const otherEnv = path.join(stateDir, "gateways", "8091");
      fs.mkdirSync(otherEnv, { recursive: true });
      fs.writeFileSync(
        path.join(otherEnv, "sandboxes.json"),
        JSON.stringify({ defaultSandbox: null, sandboxes: {} }),
      );
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({ defaultSandbox: null, sandboxes: {} }),
      );
      writeScopedGatewayState(tmpHome);
      const adapterStateEntries = [
        "https-pin-runtime-adapter.pid",
        "https-pin-runtime-adapter-token",
        "https-pin-runtime-adapter.json",
        "https-pin-runtime-adapter.lock",
        "https-pin-runtime-adapter.log",
      ];
      adapterStateEntries.forEach((name) => {
        fs.writeFileSync(path.join(stateDir, name), name.endsWith(".pid") ? "4242" : "state");
      });
      const logs: string[] = [];
      const kill = vi.fn(() => true);
      const run = vi.fn((_command: string, _args: string[]) => ok());
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: {
            HOME: tmpHome,
            NEMOCLAW_NON_INTERACTIVE: "",
            NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1",
          } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill,
          log: (line) => logs.push(line),
          run,
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(otherEnv, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
      expect(adapterStateEntries.every((name) =>
          Object.is(fs.existsSync(path.join(stateDir, name)), true))).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      expect(
        run.mock.calls.some(
          ([command, args]) =>
            command === "ps" && JSON.stringify(args).includes("https-pin-runtime-adapter"),
        ),
      ).toBe(false);
      expect(logs).toContain("Sibling gateways remain; kept the shared HTTPS Pin Runtime adapter.");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not scan or signal a sibling Bedrock adapter during selected-gateway uninstall (#9552)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bedrock-scope-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "gateways", "8091"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "default-box",
          sandboxes: {
            "default-box": { name: "default-box", gatewayName: "nemoclaw", gatewayPort: 8080 },
            "sibling-box": {
              name: "sibling-box",
              gatewayName: "nemoclaw-8091",
              gatewayPort: 8091,
            },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const scannedPorts: string[] = [];
      const kill = vi.fn((_pid: number) => true);
      let adapterExited = false;

      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "lsof" || command === "openshell",
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill: (pid, _signal) => {
            adapterExited ||= pid === 95520;
            return kill(pid);
          },
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (command, args) => {
            switch (command) {
              case "openshell":
                return ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]));
              case "lsof":
                scannedPorts.push(args[1] ?? "");
                return args[1] === ":11436" ? ok("95520\n") : ok();
              case "ps":
                switch (args.at(-1)) {
                  case "args=":
                    return ok("/usr/bin/node /opt/nemoclaw/bedrock-runtime-adapter.js\n");
                  case "user=":
                    return ok("testuser\n");
                  case "pid=":
                    return adapterExited ? { status: 1, stdout: "", stderr: "" } : ok("95520\n");
                  default:
                    return ok();
                }
              default:
                return ok();
            }
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(scannedPorts).not.toContain(":11436");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps the host-shared /swapfile when other gateway-port environments remain", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-swap-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "gateways", "8091"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      writeScopedGatewayState(tmpHome);
      const logs: string[] = [];
      const runCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command !== "docker" && command !== "pgrep",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "" } as NodeJS.ProcessEnv,
          existsSync: (target) =>
            target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
          isTty: true,
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            runCalls.push(args);
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(
        "Other NemoClaw gateway-port environments remain; keeping the host-shared /swapfile.",
      );
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes managed swap when the selected non-default port is the final environment", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-final-port-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const selectedEnv = path.join(stateDir, "gateways", String(port));
      fs.mkdirSync(selectedEnv, { recursive: true });
      fs.mkdirSync(path.join(stateDir, "backups"));
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({ defaultSandbox: null, sandboxes: {} }),
      );
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      const defaultSession = path.join(stateDir, "onboard-session.json");
      fs.writeFileSync(defaultSession, "{}");
      writeScopedGatewayState(tmpHome, port);
      const runCalls: string[][] = [];

      const deps = {
        commandExists: (command: string) => command !== "docker" && command !== "pgrep",
        env: {
          HOME: tmpHome,
          NEMOCLAW_GATEWAY_PORT: String(port),
          NEMOCLAW_NON_INTERACTIVE: "",
        } as NodeJS.ProcessEnv,
        existsSync: (target: string) =>
          target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
        isTty: true,
        log: vi.fn(),
        rmSync: fs.rmSync,
        run: (command: string, args: string[]) => {
          runCalls.push(args);
          return command === "openshell" && args[0] === "gateway" && args[1] === "list"
            ? ok(JSON.stringify([{ name: `nemoclaw-${String(port)}` }]))
            : ok();
        },
        runDocker: () => ok(""),
      };
      const options = { assumeYes: true, deleteModels: false, keepOpenShell: true };

      const protectedResult = runPortUninstall(options, deps);
      expect(protectedResult.exitCode).toBe(0);
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);

      fs.rmSync(defaultSession);
      fs.mkdirSync(selectedEnv, { recursive: true });
      runCalls.length = 0;
      const result = runPortUninstall(options, deps);

      expect(result.exitCode).toBe(0);
      expect(runCalls).toContainEqual(["swapoff", "/swapfile"]);
      expect(runCalls).toContainEqual(["rm", "-f", "/swapfile"]);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(false);
      expect(fs.existsSync(selectedEnv)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps managed swap when a sibling non-default port remains", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-sibling-port-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const selectedEnv = path.join(stateDir, "gateways", String(port));
      const siblingEnv = path.join(stateDir, "gateways", "9124");
      fs.mkdirSync(selectedEnv, { recursive: true });
      fs.mkdirSync(siblingEnv, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      writeScopedGatewayState(tmpHome, port);
      const runCalls: string[][] = [];

      const result = runPortUninstall(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command !== "docker" && command !== "pgrep",
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_NON_INTERACTIVE: "",
          } as NodeJS.ProcessEnv,
          existsSync: (target) =>
            target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
          isTty: true,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            runCalls.push(args);
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);
      expect(fs.existsSync(selectedEnv)).toBe(false);
      expect(fs.existsSync(siblingEnv)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("treats a populated default registry as a sibling even without a default session", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-default-registry-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      const selected = path.join(shared, "gateways", String(port));
      fs.mkdirSync(selected, { recursive: true });
      fs.writeFileSync(
        path.join(shared, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "default-box",
          sandboxes: {
            "default-box": {
              name: "default-box",
              gatewayName: "nemoclaw",
              gatewayPort: 8080,
            },
          },
        }),
      );
      fs.writeFileSync(path.join(shared, "managed_swap"), "/swapfile");
      writeScopedGatewayState(tmpHome, port);
      const runCalls: string[][] = [];

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: true,
        },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) } as NodeJS.ProcessEnv,
          existsSync: (target) =>
            target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
          isTty: true,
          log: vi.fn(),
          run: (_command, args) => {
            runCalls.push(args);
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runCalls).not.toContainEqual(["swapoff", "/swapfile"]);
      expect(fs.existsSync(path.join(shared, "managed_swap"))).toBe(true);
      expect(fs.existsSync(path.join(shared, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps a legacy non-default sibling after migrating and uninstalling the selected port", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-legacy-sibling-"));
    const selectedPort = 9123;
    const siblingPort = 9124;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(selectedPort));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      const sharedRegistryFile = path.join(shared, "sandboxes.json");
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(
        sharedRegistryFile,
        JSON.stringify({
          defaultSandbox: "selected-box",
          sandboxes: {
            "selected-box": {
              name: "selected-box",
              gatewayName: `nemoclaw-${String(selectedPort)}`,
              gatewayPort: selectedPort,
            },
            "sibling-box": {
              name: "sibling-box",
              gatewayName: `nemoclaw-${String(siblingPort)}`,
              gatewayPort: siblingPort,
            },
          },
        }),
      );

      const migration = migrateLegacyPortState({
        gatewayPort: selectedPort,
        home: tmpHome,
      });
      expect(migration.migratedSandboxNames).toEqual(["selected-box"]);
      writeScopedGatewayState(tmpHome, selectedPort);
      const calls: Array<{ command: string; args: string[] }> = [];
      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(selectedPort)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => command === "openshell",
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(selectedPort),
          } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (command, args) => {
            calls.push({ command, args });
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      const openshellCalls = calls
        .filter(({ command }) => command === "openshell")
        .map(({ args }) => args);
      expectGatewayScopedDelete(openshellCalls, `nemoclaw-${String(selectedPort)}`, "selected-box");
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(openshellCalls.some((args) => args[0] === "provider")).toBe(false);
      expect(readGatewayRegistryFile(tmpHome, sharedRegistryFile)?.sandboxes).toEqual({
        "sibling-box": {
          name: "sibling-box",
          gatewayName: `nemoclaw-${String(siblingPort)}`,
          gatewayPort: siblingPort,
        },
      });
      expect(fs.existsSync(path.join(shared, "gateways", String(selectedPort)))).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps shared legacy sibling state when uninstalling the default gateway", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-default-legacy-"));
    const siblingPort = 9124;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
      vi.resetModules();
      const runDefaultUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      const sharedRegistryFile = path.join(shared, "sandboxes.json");
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, "credentials.json"), "{}\n");
      fs.writeFileSync(
        sharedRegistryFile,
        JSON.stringify({
          defaultSandbox: "default-box",
          sandboxes: {
            "default-box": {
              name: "default-box",
              gatewayName: "nemoclaw",
              gatewayPort: 8080,
            },
            "sibling-box": {
              name: "sibling-box",
              gatewayName: `nemoclaw-${String(siblingPort)}`,
              gatewayPort: siblingPort,
            },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const calls: Array<{ command: string; args: string[] }> = [];

      const result = runDefaultUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: "nemoclaw",
          keepOpenShell: false,
        },
        {
          commandExists: (command) => command === "openshell",
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: "8080",
          } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (command, args) => {
            calls.push({ command, args });
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      const openshellCalls = calls
        .filter(({ command }) => command === "openshell")
        .map(({ args }) => args);
      expectGatewayScopedDelete(openshellCalls, "nemoclaw", "default-box");
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(openshellCalls.some((args) => args[0] === "provider")).toBe(false);
      expect(readGatewayRegistryFile(tmpHome, sharedRegistryFile)?.sandboxes).toEqual({
        "sibling-box": {
          name: "sibling-box",
          gatewayName: `nemoclaw-${String(siblingPort)}`,
          gatewayPort: siblingPort,
        },
      });
      expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("uninstalls only the selected gateway while preserving host-shared and default resources", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-selected-only-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      const selected = path.join(shared, "gateways", String(port));
      const openshellConfig = path.join(tmpHome, ".config", "openshell");
      const nemoclawConfig = path.join(tmpHome, ".config", "nemoclaw");
      const servicePath = path.join(
        tmpHome,
        ".config",
        "systemd",
        "user",
        "nemoclaw-openshell-gateway.service",
      );
      fs.mkdirSync(selected, { recursive: true });
      fs.mkdirSync(openshellConfig, { recursive: true });
      fs.mkdirSync(nemoclawConfig, { recursive: true });
      fs.mkdirSync(path.dirname(servicePath), { recursive: true });
      fs.writeFileSync(path.join(openshellConfig, "keep"), "default");
      fs.writeFileSync(path.join(openshellConfig, "gateway.env"), "OPENSHELL_SERVER_PORT=8080\n");
      fs.writeFileSync(path.join(nemoclawConfig, "keep"), "default");
      fs.writeFileSync(
        servicePath,
        `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}\n[Service]\nExecStart=/usr/bin/openshell-gateway\n`,
      );
      fs.writeFileSync(
        path.join(shared, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "default-box",
          sandboxes: {
            "default-box": {
              name: "default-box",
              gatewayName: "nemoclaw",
              gatewayPort: 8080,
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(selected, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "port-box",
          sandboxes: {
            "port-box": {
              name: "port-box",
              gatewayName: `nemoclaw-${String(port)}`,
              gatewayPort: port,
            },
          },
        }),
      );
      writeScopedGatewayState(tmpHome, port);
      const proxyStateEntries = [
        "ollama-proxy-token",
        "ollama-backend",
        "ollama-backend.json",
        "ollama-auth-proxy.pid",
        "ollama-auth-proxy.status",
      ];
      proxyStateEntries.forEach((entry) => {
        const value = entry === "ollama-auth-proxy.pid" ? "4242\n" : `${entry}\n`;
        fs.writeFileSync(path.join(shared, entry), value);
        fs.writeFileSync(path.join(selected, entry), `legacy-${value}`);
      });

      const runCalls: Array<{ command: string; args: string[] }> = [];
      const dockerCalls: string[][] = [];
      const logs: string[] = [];
      const kill = vi.fn((_pid: number, _signal?: NodeJS.Signals | number) => true);
      const dockerOutputByCommand: Record<string, string> = {
        images: "shared-image nemoclaw:latest",
        ps: [
          "default-id image openshell-cluster-nemoclaw",
          `selected-id image openshell-cluster-nemoclaw-${String(port)}`,
        ].join("\n"),
      };
      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: true,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => ["docker", "npm", "ollama", "openshell"].includes(command),
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill,
          log: (line) => logs.push(line),
          run: (command, args) => {
            runCalls.push({ command, args });
            return command === "ps" && args.includes("4242") && args.includes("args=")
              ? ok("node /opt/nemoclaw/scripts/ollama-auth-proxy.mts\n")
              : ok();
          },
          runDocker: (args) => {
            dockerCalls.push(args);
            return ok(dockerOutputByCommand[args[0]] ?? "");
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const openshellCalls = runCalls
        .filter(({ command }) => command === "openshell")
        .map(({ args }) => args);
      expectGatewayScopedDelete(openshellCalls, `nemoclaw-${String(port)}`, "port-box");
      expect(openshellCalls).toContainEqual(["gateway", "remove", `nemoclaw-${String(port)}`]);
      expect(openshellCalls.some((args) => args[1] === "destroy")).toBe(false);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(openshellCalls.some((args) => args[0] === "provider")).toBe(false);
      expect(runCalls.some(({ command }) => command === "npm" || command === "ollama")).toBe(false);
      expect(dockerCalls).toContainEqual(["rm", "-f", "selected-id"]);
      expect(dockerCalls).not.toContainEqual(["rm", "-f", "default-id"]);
      expect(dockerCalls.some((args) => args[0] === "rmi")).toBe(false);
      expect(fs.existsSync(selected)).toBe(false);
      expect(fs.existsSync(path.join(shared, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(openshellConfig, "keep"))).toBe(true);
      expect(fs.existsSync(path.join(openshellConfig, "gateway.env"))).toBe(true);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(runCalls.some(({ command }) => command === "systemctl")).toBe(false);
      expect(fs.existsSync(path.join(nemoclawConfig, "keep"))).toBe(true);
      expect(kill.mock.calls.every(([pid]) => pid !== 4242)).toBe(true);
      expect(proxyStateEntries.every((entry) =>
          Object.is(fs.existsSync(path.join(shared, entry)), true))).toBe(true);
      expect(logs).toContain(
        "Preserving the shared Ollama auth proxy for the remaining gateway ports",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes host-shared resources when the only gateways/ entries are OpenShell orphans (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-orphan-sibling-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      // A leftover per-port env directory with no matching live OpenShell
      // gateway (e.g. a shared CI runner reusing ~/.nemoclaw across jobs).
      fs.mkdirSync(path.join(stateDir, "gateways", "18790"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const logs: string[] = [];
      const openshellCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            // OpenShell knows only the default gateway; nemoclaw-18790 is gone.
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      // The orphan directory must not scope the uninstall: it runs the full
      // (non-scoped) teardown that removes host-shared OpenShell binaries.
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "--all"]);
      expect(logs.join("\n")).not.toContain("Sibling gateways remain");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes host-shared resources when the only sibling registry row is an OpenShell orphan (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-orphan-registry-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
            // Stale row from an interrupted migration; nemoclaw-9124 is gone.
            "ghost-box": { name: "ghost-box", gatewayName: "nemoclaw-9124", gatewayPort: 9124 },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const logs: string[] = [];
      const openshellCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            // OpenShell knows only the default gateway; nemoclaw-9124 is gone.
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      // The stale registry row must not scope the uninstall: it runs the full
      // (non-scoped) teardown that removes host-shared OpenShell binaries.
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "--all"]);
      expect(logs.join("\n")).not.toContain("Sibling gateways remain");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps host-shared resources when a sibling registry row is a live OpenShell gateway (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-live-registry-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const logs: string[] = [];
      const openshellCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            // nemoclaw-9124 is a genuinely live sibling gateway.
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9124" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(logs.join("\n")).toContain("Sibling gateways remain");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses host-wide cleanup when OpenShell is unavailable and no sibling files exist (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-no-openshell-"));
    try {
      const servicePath = path.join(
        tmpHome,
        ".config",
        "systemd",
        "user",
        "nemoclaw-openshell-gateway.service",
      );
      fs.mkdirSync(path.dirname(servicePath), { recursive: true });
      fs.writeFileSync(servicePath, `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER_LINE}\n`);
      const calls: Array<{ args: string[]; command: string }> = [];
      const kill = vi.fn();
      const logs: string[] = [];
      const rmSync = vi.fn();
      const warnings: string[] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "npm" || command === "systemctl",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          error: (line) => warnings.push(line),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill,
          log: (line) => logs.push(line),
          platform: "linux",
          rmSync,
          run: (command, args) => {
            calls.push({ args, command });
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("resources owned by gateway 'nemoclaw'");
      expect(warnings.join("\n")).toContain(
        "openshell command not found. Restore it to PATH and re-run nemoclaw uninstall.",
      );
      expect(calls).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.each([
    {
      case: "the gateway list is partially malformed",
      gatewayListResponse: ok(JSON.stringify([{ name: "nemoclaw" }, {}])),
    },
    {
      case: "the gateway-list command fails",
      gatewayListResponse: { status: 1, stdout: "", stderr: "gateway query failed" },
    },
    {
      case: "the gateway list is invalid JSON",
      gatewayListResponse: ok("{not-json"),
    },
    {
      case: "the gateway list is not an array",
      gatewayListResponse: ok(JSON.stringify({ name: "nemoclaw" })),
    },
  ])("keeps host-shared resources when $case (#7315)", ({ gatewayListResponse }) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-malformed-list-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
            "sibling-box": { name: "sibling-box", gatewayName: "nemoclaw-9124", gatewayPort: 9124 },
          },
        }),
      );
      const runtimeReceipt = path.join(stateDir, "managed-cluster-vllm-runtime.json");
      const runtimeBinding = `${runtimeReceipt}.rank-1.ssh-binding`;
      const discoveryBinding = path.join(
        stateDir,
        "managed-cluster-managed-serving.json.spark-worker.ssh-binding",
      );
      const managedApiKey = path.join(stateDir, "dual-station-vllm-api-key");
      fs.writeFileSync(runtimeReceipt, "{}\n", { mode: 0o600 });
      fs.mkdirSync(runtimeBinding, { mode: 0o700 });
      fs.mkdirSync(discoveryBinding, { mode: 0o700 });
      fs.writeFileSync(path.join(runtimeBinding, "known_hosts"), "host-key\n", { mode: 0o600 });
      fs.writeFileSync(managedApiKey, `${"a".repeat(64)}\n`, { mode: 0o600 });
      writeScopedGatewayState(tmpHome);
      const logs: string[] = [];
      const openshellCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            return args[0] === "gateway" && args[1] === "list" ? gatewayListResponse : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(logs.join("\n")).toContain("Sibling gateways remain");
      expect(fs.existsSync(runtimeReceipt)).toBe(true);
      expect(fs.existsSync(runtimeBinding)).toBe(true);
      expect(fs.existsSync(discoveryBinding)).toBe(true);
      expect(fs.existsSync(managedApiKey)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("switches to scoped cleanup when a sibling gateway appears before destruction (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-new-sibling-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
          },
        }),
      );
      const runtimeReceipt = path.join(stateDir, "dual-station-vllm-runtime.json");
      const runtimeBinding = `${runtimeReceipt}.ssh-binding`;
      fs.writeFileSync(runtimeReceipt, "{}\n", { mode: 0o600 });
      fs.mkdirSync(runtimeBinding, { mode: 0o700 });
      fs.writeFileSync(path.join(runtimeBinding, "known_hosts"), "host-key\n", { mode: 0o600 });
      writeScopedGatewayState(tmpHome);
      const openshellCalls: string[][] = [];
      const warnings: string[] = [];
      let gatewayListCalls = 0;
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            const isGatewayList = args[0] === "gateway" && args[1] === "list";
            gatewayListCalls += isGatewayList ? 1 : 0;
            return isGatewayList
              ? ok(
                  JSON.stringify(
                    gatewayListCalls === 1
                      ? [{ name: "nemoclaw" }]
                      : [{ name: "nemoclaw" }, { name: "nemoclaw-9124" }],
                  ),
                )
              : ok();
          },
          runDocker: () => ok(""),
          error: (line) => warnings.push(line),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(gatewayListCalls).toBe(2);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(warnings.join("\n")).toContain("switching to gateway-scoped cleanup");
      expect(fs.existsSync(runtimeReceipt)).toBe(true);
      expect(fs.existsSync(runtimeBinding)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps host-shared resources when a gateways/ entry is a live OpenShell gateway (#7315)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-live-sibling-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "gateways", "8091"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "my-assistant",
          sandboxes: {
            "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
          },
        }),
      );
      writeScopedGatewayState(tmpHome);
      const proxyStateEntries = [
        "ollama-proxy-token",
        "ollama-backend",
        "ollama-backend.json",
        "ollama-auth-proxy.pid",
        "ollama-auth-proxy.status",
      ];
      proxyStateEntries.forEach((entry) => {
        fs.writeFileSync(
          path.join(stateDir, entry),
          entry === "ollama-auth-proxy.pid" ? "4242\n" : "seeded\n",
        );
      });
      const logs: string[] = [];
      const openshellCalls: string[][] = [];
      let proxyProcessIsRunning = true;
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          kill: () => {
            proxyProcessIsRunning = false;
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            // nemoclaw-8091 is a genuinely live sibling gateway.
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(logs.join("\n")).toContain("Sibling gateways remain");
      expect(fs.existsSync(path.join(stateDir, "gateways", "8091"))).toBe(true);
      expect(proxyProcessIsRunning).toBe(true);
      expect(proxyStateEntries.every((entry) =>
          Object.is(fs.existsSync(path.join(stateDir, entry)), true))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
