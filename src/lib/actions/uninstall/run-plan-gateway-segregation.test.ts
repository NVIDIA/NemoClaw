// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayRegistryFile } from "../../state/gateway-registry";
import { migrateLegacyPortState } from "../../state/legacy-port-migration";
import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("uninstall gateway-port segregation (#3053)", () => {
  it.each([
    ["full", "systemd-system"],
    ["full", "systemd-user"],
    ["scoped", "systemd-system"],
    ["scoped", "systemd-user"],
  ] as const)("preserves the gateway process, Docker resources, and OpenShell binaries during %s uninstall for a %s-supervised gateway (#6576)", (scope, kind) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-external-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
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

      const result = runUninstallPlan(
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
            stateDir: "/var/lib/openshell/gateway",
            supervisor: {
              kind,
              serviceName: "openshell-gateway.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }),
          rmSync: fs.rmSync,
          run: (command, args) => {
            calls.push({ args, command });
            return ok();
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
      expect(calls.some(({ args }) => args.join(" ").includes("openshell-gateway"))).toBe(false);
      expect(kill).not.toHaveBeenCalled();
      expect(dockerCalls).toEqual([]);
      expect(
        calls.some(
          ({ command, args }) =>
            command === "rm" && args.includes("/usr/local/bin/openshell-gateway"),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not use legacy gateway destroy when external registration removal is unsupported (#6576)", () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const responses = new Map<string, RunResult>([
      [
        "openshell gateway remove nemoclaw",
        { status: 2, stdout: "", stderr: "unrecognized subcommand 'remove'" },
      ],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell",
        env: { HOME: "/home/test" } as NodeJS.ProcessEnv,
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
        env: { HOME: "/home/test" } as NodeJS.ProcessEnv,
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
      [
        "openshell gateway remove nemoclaw",
        { status: 2, stdout: "", stderr: "unrecognized subcommand 'remove'" },
      ],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
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
      ["openshell gateway remove nemoclaw", { status: 1, stdout: "", stderr: "permission denied" }],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
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
      const logs: string[] = [];
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
          log: (line) => logs.push(line),
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(otherEnv, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
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
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
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
        run: (_command: string, args: string[]) => {
          runCalls.push(args);
          return ok();
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
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const selectedEnv = path.join(stateDir, "gateways", String(port));
      const siblingEnv = path.join(stateDir, "gateways", "9124");
      fs.mkdirSync(selectedEnv, { recursive: true });
      fs.mkdirSync(siblingEnv, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
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
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
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
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
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
      expect(openshellCalls).toContainEqual([
        "gateway",
        "select",
        `nemoclaw-${String(selectedPort)}`,
      ]);
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "selected-box"]);
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
      const { runUninstallPlan: runDefaultUninstall } = await import("./run-plan");
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
      expect(openshellCalls).toContainEqual(["gateway", "select", "nemoclaw"]);
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "default-box"]);
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
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const shared = path.join(tmpHome, ".nemoclaw");
      const selected = path.join(shared, "gateways", String(port));
      const openshellConfig = path.join(tmpHome, ".config", "openshell");
      const nemoclawConfig = path.join(tmpHome, ".config", "nemoclaw");
      fs.mkdirSync(selected, { recursive: true });
      fs.mkdirSync(openshellConfig, { recursive: true });
      fs.mkdirSync(nemoclawConfig, { recursive: true });
      fs.writeFileSync(path.join(openshellConfig, "keep"), "default");
      fs.writeFileSync(path.join(nemoclawConfig, "keep"), "default");
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

      const runCalls: Array<{ command: string; args: string[] }> = [];
      const dockerCalls: string[][] = [];
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
          log: vi.fn(),
          run: (command, args) => {
            runCalls.push({ command, args });
            return ok();
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
      expect(openshellCalls).toContainEqual(["gateway", "select", `nemoclaw-${String(port)}`]);
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "port-box"]);
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
      expect(fs.existsSync(path.join(nemoclawConfig, "keep"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves selected state when the owning gateway cannot be selected", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-select-fail-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const shared = path.join(tmpHome, ".nemoclaw");
      const selected = path.join(shared, "gateways", String(port));
      fs.mkdirSync(selected, { recursive: true });
      fs.writeFileSync(
        path.join(shared, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "default-box",
          sandboxes: { "default-box": { name: "default-box" } },
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
      const calls: string[][] = [];

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) } as NodeJS.ProcessEnv,
          error: vi.fn(),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (_command, args) => {
            calls.push(args);
            return args[0] === "gateway" && args[1] === "select"
              ? { status: 1, stdout: "", stderr: "unreachable" }
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(calls).toEqual([["gateway", "select", `nemoclaw-${String(port)}`]]);
      expect(fs.existsSync(path.join(selected, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(shared, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
