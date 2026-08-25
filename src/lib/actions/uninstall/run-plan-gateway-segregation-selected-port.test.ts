// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
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
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeScopedGatewayState(home: string, port = 8080): void {
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

function bindManagedGatewayAuthority<T>(
  run: (options: UninstallRunOptions, deps: UninstallRunDeps) => T,
) {
  return (options: UninstallRunOptions, deps: UninstallRunDeps) =>
    run(options, withManagedGatewayAuthority(deps));
}

const runUninstallPlan = bindManagedGatewayAuthority(runUninstallPlanBase);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("uninstall selected gateway-port segregation (#3053)", () => {
  it("does not treat the selected gateway's own port directory as a sibling (#7987)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-self-sibling-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      // The selected gateway runs on the default port, so its state root is the
      // shared root rather than gateways/8080. A leftover directory named for
      // its own port must not make it count itself as a sibling.
      fs.mkdirSync(path.join(stateDir, "gateways", "8080"), { recursive: true });
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
            // Only the selected gateway is live; there is no sibling at all.
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(logs.join("\n")).not.toContain("Sibling gateways remain");
      expect(logs.join("\n")).not.toContain("resources owned by gateway 'nemoclaw'");
      // A single-gateway host must get the full teardown, not the scoped one.
      expect(openshellCalls).toContainEqual(["sandbox", "delete", "--all"]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("still detects a live sibling alongside the selected gateway's own port directory (#7987)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-self-and-sibling-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "gateways", "8080"), { recursive: true });
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
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-8091" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      // Excluding our own port must not suppress a genuine sibling.
      expect(logs.join("\n")).toContain("Sibling gateways remain");
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "--all"]);
      expect(fs.existsSync(path.join(stateDir, "gateways", "8091"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves selected state when a gateway-scoped sandbox deletion fails", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-select-fail-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlanProduction,
      );
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
      writeScopedGatewayState(tmpHome, port);
      const calls: string[][] = [];

      const result = await runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        withSuccessfulPreUninstallBackup({
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) } as NodeJS.ProcessEnv,
          error: vi.fn(),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (_command, args) => {
            calls.push(args);
            return args[0] === "sandbox" && args[1] === "delete"
              ? { status: 1, stdout: "", stderr: "unreachable" }
              : ok();
          },
          runDocker: () => ok(""),
        }),
      );

      expect(result.exitCode).toBe(1);
      // Read-only gateway-list and live-process identity probes may run first;
      // the only state-changing OpenShell call is the gateway-scoped delete. (#7315)
      const meaningful = calls.filter(
        (args) => args[0] !== "-p" && !(args[0] === "gateway" && args[1] === "list"),
      );
      expect(meaningful).toEqual([
        ["sandbox", "delete", "-g", `nemoclaw-${String(port)}`, "port-box"],
      ]);
      expect(fs.existsSync(path.join(selected, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(shared, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("prunes selected rows after recovering an abandoned registry lock", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-stale-lock-"));
    const port = 8080;
    const siblingPort = 9125;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlanProduction,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(shared, "gateways", String(siblingPort)), { recursive: true });
      const selectedRegistry = path.join(shared, "sandboxes.json");
      fs.writeFileSync(
        selectedRegistry,
        JSON.stringify({
          defaultSandbox: "port-box",
          sandboxes: {
            "port-box": {
              name: "port-box",
              gatewayName: "nemoclaw",
              gatewayPort: port,
            },
            "sibling-box": {
              name: "sibling-box",
              gatewayName: `nemoclaw-${String(siblingPort)}`,
              gatewayPort: siblingPort,
            },
          },
        }),
      );
      // An uninstall killed inside its own critical section leaves an
      // owner-less lock directory that no live process holds.
      const abandonedLock = `${selectedRegistry}.lock`;
      fs.mkdirSync(abandonedLock, { mode: 0o700 });
      const abandonedAt = new Date(Date.now() - 600_000);
      fs.utimesSync(abandonedLock, abandonedAt, abandonedAt);
      writeScopedGatewayState(tmpHome, port);

      const result = await runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: false,
          gatewayName: "nemoclaw",
          keepOpenShell: true,
        },
        withSuccessfulPreUninstallBackup({
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) } as NodeJS.ProcessEnv,
          error: vi.fn(),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (_command, args) =>
            args[0] === "gateway" && args[1] === "list"
              ? ok(
                  JSON.stringify([
                    { name: "nemoclaw" },
                    { name: `nemoclaw-${String(siblingPort)}` },
                  ]),
                )
              : ok(),
          runDocker: () => ok(""),
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(abandonedLock)).toBe(false);
      expect(JSON.parse(fs.readFileSync(selectedRegistry, "utf8"))).toMatchObject({
        defaultSandbox: "sibling-box",
        sandboxes: {
          "sibling-box": {
            name: "sibling-box",
            gatewayName: `nemoclaw-${String(siblingPort)}`,
            gatewayPort: siblingPort,
          },
        },
      });
      expect(JSON.parse(fs.readFileSync(selectedRegistry, "utf8"))).not.toHaveProperty(
        "sandboxes.port-box",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
