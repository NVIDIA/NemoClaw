// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
import {
  ensureManagedGatewayStateRoot,
  resolveGatewayStateDirName,
} from "../../onboard/gateway-binding";
import {
  acquireManagedGatewayStateLifecycleLock,
  managedGatewayStateLifecycleLockPath,
  releaseManagedGatewayStateLifecycleLock,
  tryAcquireManagedGatewayStateLifecycleLock,
} from "../../onboard/gateway/state-lifecycle-lock";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeScopedGatewayState(
  home: string,
  port = 8080,
  stateDir = path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(port)),
): void {
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
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-self-sibling-"));
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
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-self-and-sibling-"),
    );
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

  it.each([
    {
      expectedExit: 0,
      liveGatewayNames: ["nemoclaw", "nemoclaw-9123"],
      processProven: true,
      scenario: "removes configured gateway state during gateway-scoped cleanup",
      siblingKept: true,
    },
    {
      expectedExit: 0,
      liveGatewayNames: ["nemoclaw-9123"],
      processProven: true,
      scenario: "removes configured gateway state during full cleanup",
      siblingKept: false,
    },
    {
      expectedExit: 1,
      liveGatewayNames: ["nemoclaw-9123", "nemoclaw"],
      processProven: false,
      scenario: "preserves configured gateway state during unproven gateway-scoped cleanup",
      siblingKept: true,
    },
    {
      expectedExit: 1,
      liveGatewayNames: ["nemoclaw-9123"],
      processProven: false,
      scenario: "preserves configured gateway state during unproven full cleanup",
      siblingKept: true,
    },
  ])(
    "$scenario without a registered sandbox (#10544)",
    async ({ expectedExit, liveGatewayNames, processProven, siblingKept }) => {
      const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-custom-state-"));
      const port = 9123;
      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
        vi.resetModules();
        const runPortUninstall = bindManagedGatewayAuthority(
          (await import("./run-plan")).runUninstallPlan,
        );
        const selectedStateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
        const customGatewayState = path.join(tmpHome, "custom-gateway-state");
        const siblingGatewayState = path.join(
          tmpHome,
          ".local",
          "state",
          "nemoclaw",
          "openshell-docker-gateway",
        );
        fs.mkdirSync(selectedStateRoot, { mode: 0o700, recursive: true });
        fs.mkdirSync(siblingGatewayState, { mode: 0o700, recursive: true });
        fs.writeFileSync(path.join(siblingGatewayState, "keep"), "sibling\n");
        writeScopedGatewayState(tmpHome, port, customGatewayState);
        const openshellCalls: string[][] = [];
        const errors = vi.fn();

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
            env: {
              HOME: tmpHome,
              NEMOCLAW_GATEWAY_PORT: String(port),
              NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
            } as NodeJS.ProcessEnv,
            error: errors,
            existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
            hasPortableRuntimeCleanup: () => false,
            isTty: false,
            log: vi.fn(),
            readProcessEnvironment: processProven ? undefined : () => null,
            rmSync: fs.rmSync,
            run: (_command, args) => {
              openshellCalls.push(args);
              return args[0] === "gateway" && args[1] === "list"
                ? ok(JSON.stringify(liveGatewayNames.map((name) => ({ name }))))
                : ok();
            },
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(expectedExit);
        const registrationCall = ["gateway", "remove", `nemoclaw-${String(port)}`];
        expect(
          openshellCalls.some((args) => JSON.stringify(args) === JSON.stringify(registrationCall)),
        ).toBe(processProven);
        expect(
          errors.mock.calls
            .flat()
            .some((message) =>
              String(message).includes("selected process identity cannot be proven"),
            ),
        ).toBe(!processProven);
        expect(fs.existsSync(customGatewayState)).toBe(!processProven);
        expect(fs.existsSync(selectedStateRoot)).toBe(!processProven);
        expect(fs.existsSync(siblingGatewayState)).toBe(siblingKept);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      expectedExit: 0,
      gatewayRemoved: true,
      portFree: true,
      scenario: "removes stopped marked gateway state when its port is free",
      stateKept: false,
    },
    {
      expectedExit: 1,
      gatewayRemoved: false,
      portFree: false,
      scenario: "preserves stopped marked gateway state when its port is occupied",
      stateKept: true,
    },
  ])("$scenario (#10544)", async ({ expectedExit, gatewayRemoved, portFree, stateKept }) => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-stopped-state-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = (await import("./run-plan")).runUninstallPlan;
      const customGatewayState = path.join(tmpHome, "stopped-gateway-state");
      ensureManagedGatewayStateRoot({
        gatewayName: `nemoclaw-${String(port)}`,
        gatewayPort: port,
        stateDir: customGatewayState,
      });
      writeScopedGatewayState(tmpHome, port, customGatewayState);
      const calls: string[][] = [];
      const logs: string[] = [];

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => ["openshell", "pgrep"].includes(command),
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
          },
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          getTrustedActiveOpenShellGatewayUserServiceIdentity: () => null,
          hasPortableRuntimeCleanup: () => false,
          isPortFree: () => portFree,
          isTty: false,
          log: (message) => logs.push(message),
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            endpoint: null,
            gatewayName,
            gatewayPort,
            mode: "nemoclaw-managed",
            requiredCapabilities: [],
            source: "standalone",
            stateDir: null,
            supervisor: null,
          }),
          rmSync: fs.rmSync,
          run: (command, args) => {
            calls.push([command, ...args]);
            return command === "pgrep" || command === "ps"
              ? { ...ok(), status: 1 }
              : command === "openshell" && args[0] === "gateway" && args[1] === "list"
                ? ok(JSON.stringify([{ name: `nemoclaw-${String(port)}` }]))
                : ok();
          },
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(expectedExit);
      expect(fs.existsSync(customGatewayState)).toBe(stateKept);
      expect(
        calls.some(
          ([command, ...args]) =>
            command === "openshell" &&
            JSON.stringify(args) ===
              JSON.stringify(["gateway", "remove", `nemoclaw-${String(port)}`]),
        ),
      ).toBe(gatewayRemoved);
      expect(logs.join("\n").includes("continuing cleanup from its port-bound managed state")).toBe(
        gatewayRemoved,
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("removes a marker-only configured reservation without OpenShell gateway cleanup", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-reservation-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const customGatewayState = path.join(tmpHome, "reserved-gateway-state");
      ensureManagedGatewayStateRoot({
        gatewayName: `nemoclaw-${String(port)}`,
        gatewayPort: port,
        stateDir: customGatewayState,
      });
      const logs: string[] = [];
      const run = vi.fn(() => ok());

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        {
          commandExists: () => false,
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
          },
          hasPortableRuntimeCleanup: () => false,
          isPortFree: () => true,
          isTty: false,
          log: (message) => logs.push(message),
          rmSync: fs.rmSync,
          run,
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(customGatewayState)).toBe(false);
      expect(logs.join("\n")).toContain("no gateway resources were created");
      expect(run).not.toHaveBeenCalledWith("openshell", expect.any(Array), expect.anything());
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves a marker-only reservation while onboarding holds its lifecycle lock (#10544)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-onboard-lock-"));
    const port = 9123;
    const customGatewayState = path.join(tmpHome, "reserved-gateway-state");
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      ensureManagedGatewayStateRoot({
        gatewayName: `nemoclaw-${String(port)}`,
        gatewayPort: port,
        stateDir: customGatewayState,
      });
      const onboardingLock = acquireManagedGatewayStateLifecycleLock(customGatewayState);
      const warnings = vi.fn();

      try {
        const result = runPortUninstall(
          {
            assumeYes: true,
            deleteModels: false,
            destroyUserData: true,
            gatewayName: `nemoclaw-${String(port)}`,
            keepOpenShell: false,
          },
          {
            commandExists: () => false,
            env: {
              HOME: tmpHome,
              NEMOCLAW_GATEWAY_PORT: String(port),
              NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
            },
            error: warnings,
            hasPortableRuntimeCleanup: () => false,
            isPortFree: () => true,
            isTty: false,
            log: vi.fn(),
            rmSync: fs.rmSync,
            run: () => ok(),
            runDocker: () => ok(),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(customGatewayState)).toBe(true);
        expect(warnings).toHaveBeenCalledWith(
          expect.stringContaining("active onboarding lifecycle"),
        );
      } finally {
        releaseManagedGatewayStateLifecycleLock(onboardingLock);
      }
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("holds the configured state lifecycle lock through destructive cleanup (#10544)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-plan-lock-"));
    const port = 9123;
    const customGatewayState = path.join(tmpHome, "managed-gateway-state");
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      writeScopedGatewayState(tmpHome, port, customGatewayState);
      let competingOnboardingWasBlocked = false;

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
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
          },
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          log: (message) => {
            const competingLock = message.startsWith("[")
              ? tryAcquireManagedGatewayStateLifecycleLock(customGatewayState)
              : null;
            expect(competingLock).toBeNull();
            competingOnboardingWasBlocked ||= message.startsWith("[1/");
          },
          rmSync: fs.rmSync,
          run: (_command, args) =>
            args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: `nemoclaw-${String(port)}` }]))
              : ok(),
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(competingOnboardingWasBlocked).toBe(true);
      expect(fs.existsSync(customGatewayState)).toBe(false);
      const postUninstallLock = acquireManagedGatewayStateLifecycleLock(customGatewayState);
      releaseManagedGatewayStateLifecycleLock(postUninstallLock);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedDiagnostic: "not a real directory",
      mutate: (_home: string, stateDir: string) => {
        fs.writeFileSync(managedGatewayStateLifecycleLockPath(stateDir), "invalid lock\n", {
          mode: 0o600,
        });
        return () => undefined;
      },
      scenario: "a malformed lifecycle lock",
    },
    {
      expectedDiagnostic: "is not a trusted real directory",
      mutate: (_home: string, stateDir: string) => {
        const unsafeAncestor = path.dirname(stateDir);
        fs.chmodSync(unsafeAncestor, 0o777);
        return () => fs.chmodSync(unsafeAncestor, 0o700);
      },
      scenario: "unsafe state-directory ancestry",
    },
  ])(
    "reports $scenario instead of misdiagnosing active onboarding (#10544)",
    async ({ expectedDiagnostic, mutate }) => {
      const tmpHome = fs.mkdtempSync(
        path.join(process.cwd(), "nemoclaw-uninstall-invalid-lifecycle-lock-"),
      );
      const port = 9123;
      const customGatewayState = path.join(tmpHome, "state-parent", "reserved-gateway-state");
      let restore: () => void = () => undefined;
      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
        vi.resetModules();
        const runPortUninstall = bindManagedGatewayAuthority(
          (await import("./run-plan")).runUninstallPlan,
        );
        fs.mkdirSync(path.dirname(customGatewayState), { mode: 0o700, recursive: true });
        ensureManagedGatewayStateRoot({
          gatewayName: `nemoclaw-${String(port)}`,
          gatewayPort: port,
          stateDir: customGatewayState,
        });
        restore = mutate(tmpHome, customGatewayState);
        const warnings = vi.fn();

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
            env: {
              HOME: tmpHome,
              NEMOCLAW_GATEWAY_PORT: String(port),
              NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
            },
            error: warnings,
            hasPortableRuntimeCleanup: () => false,
            isPortFree: () => true,
            isTty: false,
            log: vi.fn(),
            rmSync: fs.rmSync,
            run: (_command, args) =>
              args[0] === "gateway" && args[1] === "list" ? ok("[]") : ok(),
            runDocker: () => ok(),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(customGatewayState)).toBe(true);
        const output = warnings.mock.calls.flat().join("\n");
        expect(output).toContain(expectedDiagnostic);
        expect(output).not.toContain("active onboarding lifecycle");
      } finally {
        restore();
        fs.rmSync(tmpHome, { force: true, recursive: true });
      }
    },
  );

  it("revalidates state ancestry immediately before reservation removal (#10544)", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-revalidate-state-"),
    );
    const port = 9123;
    const customGatewayState = path.join(tmpHome, "reserved-gateway-state");
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      ensureManagedGatewayStateRoot({
        gatewayName: `nemoclaw-${String(port)}`,
        gatewayPort: port,
        stateDir: customGatewayState,
      });
      const warnings = vi.fn();

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(port)}`,
          keepOpenShell: false,
        },
        {
          commandExists: () => false,
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
          },
          error: warnings,
          hasPortableRuntimeCleanup: () => false,
          isPortFree: () => {
            fs.chmodSync(tmpHome, 0o777);
            return true;
          },
          isTty: false,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: () => ok(),
          runDocker: () => ok(),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(customGatewayState)).toBe(true);
      expect(warnings.mock.calls.flat().join("\n")).toContain("became unsafe before removal");
    } finally {
      fs.chmodSync(tmpHome, 0o700);
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedDiagnostic: "sandbox namespace cannot be proven",
      expectedRecovery: "sandbox namespace cannot be proven",
      portFree: true,
      rejectedDiagnostic: "gateway port 9123 has a listener",
      scenario: "generated configuration",
      writeEvidence: (stateDir: string) =>
        fs.writeFileSync(path.join(stateDir, "openshell-gateway.toml"), "[gateway]\n", {
          mode: 0o600,
        }),
    },
    {
      expectedDiagnostic: "sandbox namespace cannot be proven",
      expectedRecovery: "sandbox namespace cannot be proven",
      portFree: true,
      rejectedDiagnostic: "gateway port 9123 has a listener",
      scenario: "runtime marker",
      writeEvidence: (stateDir: string) =>
        fs.writeFileSync(path.join(stateDir, "runtime.json"), "{}\n", { mode: 0o600 }),
    },
    {
      expectedDiagnostic: "sandbox namespace cannot be proven",
      expectedRecovery: "sandbox namespace cannot be proven",
      portFree: true,
      rejectedDiagnostic: "gateway port 9123 has a listener",
      scenario: "PID evidence",
      writeEvidence: (stateDir: string) =>
        fs.writeFileSync(path.join(stateDir, "openshell-gateway.pid"), "4242\n", {
          mode: 0o600,
        }),
    },
    {
      expectedDiagnostic: "gateway port 9123 has a listener",
      expectedRecovery: "rerun uninstall after the port is free",
      portFree: false,
      rejectedDiagnostic: "sandbox namespace cannot be proven",
      scenario: "a live listener",
      writeEvidence: (_stateDir: string) => undefined,
    },
  ])(
    "preserves a configured reservation with $scenario",
    async ({
      expectedDiagnostic,
      expectedRecovery,
      portFree,
      rejectedDiagnostic,
      writeEvidence,
    }) => {
      const tmpHome = fs.mkdtempSync(
        path.join(process.cwd(), "nemoclaw-uninstall-reservation-evidence-"),
      );
      const port = 9123;
      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
        vi.resetModules();
        const runPortUninstall = bindManagedGatewayAuthority(
          (await import("./run-plan")).runUninstallPlan,
        );
        const customGatewayState = path.join(tmpHome, "reserved-gateway-state");
        ensureManagedGatewayStateRoot({
          gatewayName: `nemoclaw-${String(port)}`,
          gatewayPort: port,
          stateDir: customGatewayState,
        });
        writeEvidence(customGatewayState);
        const errors = vi.fn();

        const result = runPortUninstall(
          {
            assumeYes: true,
            deleteModels: false,
            destroyUserData: true,
            gatewayName: `nemoclaw-${String(port)}`,
            keepOpenShell: false,
          },
          {
            commandExists: (command) => portFree && command === "openshell",
            env: {
              HOME: tmpHome,
              NEMOCLAW_GATEWAY_PORT: String(port),
              NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: customGatewayState,
            },
            error: errors,
            hasPortableRuntimeCleanup: () => false,
            isPortFree: () => portFree,
            isTty: false,
            log: vi.fn(),
            rmSync: fs.rmSync,
            run: () => ok("[]"),
            runDocker: () => ok(),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(customGatewayState)).toBe(true);
        const output = errors.mock.calls.flat().join("\n");
        expect(output).toContain(expectedDiagnostic);
        expect(output).toContain(expectedRecovery);
        expect(output).not.toContain(rejectedDiagnostic);
      } finally {
        fs.rmSync(tmpHome, { force: true, recursive: true });
      }
    },
  );

  it.each(["relative", "shared-root", "shared-parent"])(
    "rejects an unsafe %s gateway state override before cleanup",
    async (scenario) => {
      const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-unsafe-state-"));
      const port = 9123;
      try {
        const configured =
          scenario === "relative"
            ? "relative-gateway-state"
            : scenario === "shared-root"
              ? path.join(tmpHome, ".local", "state", "nemoclaw")
              : path.join(tmpHome, ".local", "state");
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
        vi.resetModules();
        const runPortUninstall = (await import("./run-plan")).runUninstallPlan;
        const run = vi.fn(() => ok());
        const rmSync = vi.fn();
        const errors = vi.fn();

        const result = runPortUninstall(
          {
            assumeYes: true,
            deleteModels: false,
            destroyUserData: true,
            gatewayName: `nemoclaw-${String(port)}`,
            keepOpenShell: false,
          },
          {
            env: {
              HOME: tmpHome,
              NEMOCLAW_GATEWAY_PORT: String(port),
              NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: configured,
            },
            error: errors,
            rmSync,
            run,
          },
        );

        expect(result.exitCode).toBe(1);
        expect(errors).toHaveBeenCalledWith(
          expect.stringContaining("Refusing uninstall before cleanup"),
        );
        expect(run).not.toHaveBeenCalled();
        expect(rmSync).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpHome, { force: true, recursive: true });
      }
    },
  );

  it("refuses a registered-sandbox cleanup when the override belongs to another gateway", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-wrong-state-"));
    const selectedPort = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(selectedPort));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const selectedStateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(selectedPort));
      const selectedGatewayState = path.join(tmpHome, "selected-gateway-state");
      const otherGatewayState = path.join(tmpHome, "other-gateway-state");
      fs.mkdirSync(selectedStateRoot, { mode: 0o700, recursive: true });
      fs.mkdirSync(selectedGatewayState, { mode: 0o700 });
      fs.writeFileSync(path.join(selectedGatewayState, "keep"), "selected\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(selectedStateRoot, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "selected-box",
          sandboxes: {
            "selected-box": {
              gatewayName: `nemoclaw-${String(selectedPort)}`,
              gatewayPort: selectedPort,
              name: "selected-box",
            },
          },
        }),
        { mode: 0o600 },
      );
      writeScopedGatewayState(tmpHome, 8080, otherGatewayState);
      const openshellCalls: string[][] = [];
      const warnings = vi.fn();

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
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: otherGatewayState,
          },
          error: warnings,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            openshellCalls.push(args);
            return args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9123" }]))
              : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(openshellCalls).not.toContainEqual(["sandbox", "delete", "selected-box"]);
      expect(openshellCalls).not.toContainEqual(["gateway", "remove", "nemoclaw-9123"]);
      expect(warnings.mock.calls.flat().join("\n")).toContain(
        "selected process identity cannot be proven",
      );
      expect(fs.existsSync(selectedStateRoot)).toBe(true);
      expect(fs.existsSync(selectedGatewayState)).toBe(true);
      expect(fs.existsSync(otherGatewayState)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves selected state when a gateway-scoped sandbox deletion fails", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-select-fail-"));
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
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-stale-lock-"));
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
