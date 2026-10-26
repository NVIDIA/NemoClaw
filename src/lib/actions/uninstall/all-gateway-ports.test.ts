// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_GATEWAY_PORTS_ENV,
  type AllGatewayPortsDeps,
  allGatewayPortsRequested,
  runUninstallAllGatewayPorts,
  uninstallChildArgs,
  uninstallChildEnv,
} from "./all-gateway-ports";
import type { UninstallRunDeps, UninstallRunOptions } from "./run-plan";
import { listGatewayStateRoots, readGatewayOpenShellStateDir } from "../../state/gateway-registry";
import {
  resolveGatewayStateDirForPort,
  writeDockerDriverGatewayBinding,
} from "../../onboard/gateway/state-dir";

const OPTIONS: UninstallRunOptions = {
  assumeYes: true,
  deleteModels: false,
  keepOpenShell: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function sweepDeps(overrides: AllGatewayPortsDeps = {}) {
  const error = vi.fn();
  const runPortPass = vi.fn(
    (
      _port: number,
      _options: UninstallRunOptions,
      _env: NodeJS.ProcessEnv,
      _retainedGatewayPorts?: readonly number[],
      _sweepDefaultGatewayAbsent?: boolean,
    ) => 0,
  );
  const runSelectedPass = vi.fn(async (_options: UninstallRunOptions, _deps: UninstallRunDeps) => ({
    exitCode: 0,
  }));
  const deps: AllGatewayPortsDeps = {
    env: { HOME: "/home/tester" } as NodeJS.ProcessEnv,
    error,
    gatewayStateDirForPort: () => null,
    home: "/home/tester",
    listGatewayPorts: () => [8080, 18080, 9000],
    log: vi.fn(),
    runPortPass,
    runSelectedPass,
    ...overrides,
  };
  return { deps, error, runPortPass, runSelectedPass };
}

describe("uninstall across every gateway port (#7791)", () => {
  it.each([
    ["the flag alone", undefined, {}, false],
    ["the flag set", true, {}, true],
    ["the environment variable set", undefined, { [ALL_GATEWAY_PORTS_ENV]: "1" }, true],
    ["the environment variable disabled", undefined, { [ALL_GATEWAY_PORTS_ENV]: "0" }, false],
  ] as const)("requests the sweep from %s", (_scenario, flag, env, expected) => {
    expect(allGatewayPortsRequested(flag, env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it("uninstalls each other gateway port in ascending order and the current port last", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps();

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(0);
    expect(result.ports).toEqual([9000, 18080, 8080]);
    expect(runPortPass.mock.calls.map(([port]) => port)).toEqual([9000, 18080]);
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
  });

  it("lets the final discovered child clean the host when the selected port is absent (#13332)", async () => {
    const log = vi.fn();
    const { deps, runPortPass, runSelectedPass } = sweepDeps({
      listGatewayPorts: () => [9123],
      log,
      readLine: () => "y",
    });

    const result = await runUninstallAllGatewayPorts({ ...OPTIONS, assumeYes: false }, deps);

    expect(result).toEqual({ exitCode: 0, ports: [9123] });
    expect(runPortPass.mock.calls.map(([port]) => port)).toEqual([9123]);
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("port 8080"));
    expect(log).toHaveBeenCalledWith(
      "Each listed port is uninstalled in order; the last listed port runs last.",
    );
  });

  it("carries an earlier failed port into the final child when the selected port is absent", async () => {
    const runPortPass = vi.fn(
      (
        port: number,
        _options: UninstallRunOptions,
        _env: NodeJS.ProcessEnv,
        _retainedGatewayPorts?: readonly number[],
      ) => (port === 9000 ? 1 : 0),
    );
    const { deps } = sweepDeps({
      listGatewayPorts: () => [9000, 18080],
      runPortPass,
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result).toEqual({ exitCode: 1, ports: [9000, 18080] });
    expect(runPortPass.mock.calls[0]?.[3]).toEqual([]);
    expect(runPortPass.mock.calls[1]?.[3]).toEqual([9000]);
  });

  it("forces confirmation-free child passes after one whole-host confirmation", async () => {
    const { deps, runSelectedPass } = sweepDeps({ readLine: () => "y" });

    await runUninstallAllGatewayPorts({ ...OPTIONS, assumeYes: false }, deps);

    expect(runSelectedPass.mock.calls[0]?.[0]).toMatchObject({
      assumeYes: true,
    });
  });

  it("does not run any pass when the whole-host confirmation is declined", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps({
      readLine: () => "n",
    });

    const result = await runUninstallAllGatewayPorts({ ...OPTIONS, assumeYes: false }, deps);

    expect(result.exitCode).toBe(0);
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
  });

  it("rejects a mismatched gateway check before any port pass", async () => {
    const { deps, error, runPortPass, runSelectedPass } = sweepDeps();

    const result = await runUninstallAllGatewayPorts(
      { ...OPTIONS, gatewayName: "nemoclaw-9000" },
      deps,
    );

    expect(result).toEqual({ exitCode: 1, ports: [] });
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Refusing to uninstall gateway"));
  });

  it("restores each recorded custom state directory only for its gateway child (#10665)", async () => {
    const { deps, runPortPass } = sweepDeps({
      gatewayStateDirForPort: (_home, port) =>
        port === 9000 ? "/home/tester/custom-gateway-9000" : null,
    });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    const envByPort = new Map(
      runPortPass.mock.calls.map(([port, _options, env]) => [
        port,
        env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
      ]),
    );
    expect(envByPort.get(9000)).toBe("/home/tester/custom-gateway-9000");
    expect(envByPort.get(18080)).toBeUndefined();
  });

  it.each([
    ["incomplete create", {}, false],
    [
      "matching completed metadata",
      { openshellGatewayStateDir: "/srv/nemoclaw/custom-9000" },
      false,
    ],
    [
      "conflicting completed metadata",
      { openshellGatewayStateDir: "/srv/nemoclaw/other-9000" },
      true,
    ],
    ["foreign sandbox", { name: "other" }, true],
    ["foreign gateway", { gatewayName: "nemoclaw-18080", gatewayPort: 18080 }, true],
    ["completed row with a checkpoint", { pendingRouteReservation: false }, true],
    ["missing reservation owner", { reservationSessionId: undefined }, true],
    ["changed lifecycle", { lifecycleGeneration: "changed" }, true],
    [
      "malformed checkpoint",
      { pendingCreateIdentity: { openshellGatewayStateDir: "relative" } },
      true,
    ],
  ] as const)(
    "recovers checkpoint directories or rejects %s before any uninstall pass",
    async (_scenario, override, reject) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pending-uninstall-"));
      try {
        const root = path.join(home, ".nemoclaw", "gateways", "9000");
        fs.mkdirSync(root, { recursive: true });
        const entry = {
          name: "pending",
          gatewayName: "nemoclaw-9000",
          gatewayPort: 9000,
          pendingRouteReservation: true,
          reservationSessionId: "session-owner",
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
          pendingCreateIdentity: {
            schemaVersion: 1,
            state: "verified-create",
            sandboxName: "pending",
            gatewayName: "nemoclaw-9000",
            gatewayPort: 9000,
            lifecycleGeneration: "generation-1",
            sandboxIdentityFingerprint: "a".repeat(64),
            route: "none",
            openshellGatewayStateDir: "/srv/nemoclaw/custom-9000",
          },
          ...override,
        };
        fs.writeFileSync(
          path.join(root, "sandboxes.json"),
          JSON.stringify({ defaultSandbox: null, sandboxes: { [entry.name]: entry } }),
        );
        const { deps, runPortPass, runSelectedPass } = sweepDeps({
          home,
          env: { HOME: home },
          listGatewayPorts: () => [8080, 9000],
          gatewayStateDirForPort: readGatewayOpenShellStateDir,
        });
        const result = await runUninstallAllGatewayPorts(OPTIONS, deps);
        expect(result.exitCode).toBe(reject ? 1 : 0);
        expect(
          runPortPass.mock.calls.map(([port, _options, env]) => [
            port,
            env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
          ]),
        ).toEqual(reject ? [] : [[9000, "/srv/nemoclaw/custom-9000"]]);
        expect(runSelectedPass).toHaveBeenCalledTimes(reject ? 0 : 1);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("restores a recorded custom state directory for the selected pass (#10665)", async () => {
    const { deps, runSelectedPass } = sweepDeps({
      gatewayStateDirForPort: (_home, port) =>
        port === 8080 ? "/home/tester/custom-gateway-8080" : null,
      listGatewayPorts: () => [8080],
    });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1].env).toMatchObject({
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/home/tester/custom-gateway-8080",
    });
  });

  it("keeps an explicit selected-port override ahead of recorded state (#10665)", async () => {
    const { deps, runSelectedPass } = sweepDeps({
      env: {
        HOME: "/home/tester",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/home/tester/explicit-gateway-8080",
      },
      gatewayStateDirForPort: (_home, port) =>
        port === 8080 ? "/home/tester/recorded-gateway-8080" : null,
      listGatewayPorts: () => [8080],
    });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1].env).toMatchObject({
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/home/tester/explicit-gateway-8080",
    });
  });

  it("fails before any pass when recorded state directories conflict (#10665)", async () => {
    const { deps, error, runPortPass, runSelectedPass } = sweepDeps({
      gatewayStateDirForPort: () => {
        throw new Error("conflicting OpenShell state directories");
      },
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result).toEqual({ exitCode: 1, ports: [9000, 18080, 8080] });
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conflicting OpenShell"));
  });

  it("reports a failed port pass and still finishes the remaining ports", async () => {
    const failingPortPass = vi.fn((port: number) => (port === 9000 ? 1 : 0));
    const { deps, error, runSelectedPass } = sweepDeps({
      runPortPass: failingPortPass,
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(failingPortPass.mock.calls.map(([port]) => port)).toEqual([9000, 18080]);
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("9000"));
  });

  it("carries a failed port into the final pass so shared cleanup stays scoped (#7791)", async () => {
    const { deps, runSelectedPass } = sweepDeps({
      runPortPass: vi.fn((port: number) => (port === 9000 ? 1 : 0)),
    });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      retainedGatewayPorts: [9000],
    });
  });

  it("returns nonzero when the final pass still observes another gateway environment", async () => {
    const { deps, error } = sweepDeps({
      runSelectedPass: vi.fn(async () => ({
        exitCode: 0,
        otherGatewayEnvironmentsRemain: true,
      })),
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Whole-host uninstall is incomplete"),
    );
  });

  it("retains no port for the final pass when every other port uninstalled", async () => {
    const { deps, runSelectedPass } = sweepDeps();

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      requireCompleteGatewayProcessCleanup: true,
      retainedGatewayPorts: [],
    });
  });

  it("runs a single scoped pass when no other gateway port exists", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps({
      listGatewayPorts: () => [8080],
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.ports).toEqual([8080]);
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      requireCompleteGatewayProcessCleanup: true,
      retainedGatewayPorts: [],
    });
  });

  it("removes host-global dual-Station credentials when a non-default port finishes the sweep", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-all-ports-"));
    const sharedStateDir = path.join(home, ".nemoclaw");
    const selectedStateDir = path.join(sharedStateDir, "gateways", "9123");
    const apiKeyPath = path.join(sharedStateDir, "dual-station-vllm-api-key");
    fs.mkdirSync(selectedStateDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(selectedStateDir, "selected-only"), "remove me\n");
    fs.writeFileSync(apiKeyPath, "ab".repeat(32), { mode: 0o600 });
    fs.writeFileSync(path.join(sharedStateDir, "unrecognized-old-state"), "stale\n");

    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const { runUninstallAllGatewayPorts: runNonDefaultSweep } =
        await import("./all-gateway-ports");
      const result = await runNonDefaultSweep(OPTIONS, {
        commandExists: () => true,
        env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
        existsSync: fs.existsSync,
        hasPortableRuntimeCleanup: () => false,
        home,
        isTty: false,
        kill: () => true,
        log: vi.fn(),
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        rmSync: fs.rmSync,
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? {
                status: 0,
                stdout: JSON.stringify([{ name: "nemoclaw-9123" }]),
                stderr: "",
              }
            : { status: 0, stdout: "", stderr: "" },
        runDocker: () => ({ status: 0, stdout: "", stderr: "" }),
        runLocalModelRuntimeCleanup: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: true, removed: [], skipped: [] }),
          stderr: "",
        }),
        runPortPass: () => 0,
        withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
      });

      expect(result).toEqual({ exitCode: 0, ports: [9123] });
      expect(fs.existsSync(apiKeyPath)).toBe(false);
      expect(fs.existsSync(selectedStateDir)).toBe(false);
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "registry",
      (home: string): void => {
        const sharedRoot = path.join(home, ".nemoclaw");
        fs.writeFileSync(
          path.join(sharedRoot, "sandboxes.json"),
          JSON.stringify({
            defaultSandbox: "default-box",
            sandboxes: { "default-box": { name: "default-box", gatewayPort: 8080 } },
          }),
        );
      },
    ],
    [
      "configuration",
      (home: string): void => {
        const stateDir = resolveGatewayStateDirForPort({ home, port: 8080 });
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, "openshell-gateway.toml"), "gateway config\n");
      },
    ],
    ["live gateway", (_home: string): void => undefined],
  ] as const)(
    "retains shared cleanup when %s proves a default gateway after the sweep omitted it",
    async (evidence, writeEvidence) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-default-race-"));
      const sharedRoot = path.join(home, ".nemoclaw");
      const selectedRoot = path.join(sharedRoot, "gateways", "9123");
      const apiKeyPath = path.join(sharedRoot, "dual-station-vllm-api-key");
      fs.mkdirSync(selectedRoot, { recursive: true });
      fs.writeFileSync(apiKeyPath, "ab".repeat(32), { mode: 0o600 });
      fs.writeFileSync(path.join(sharedRoot, "unrecognized-old-state"), "stale\n");
      writeEvidence(home);
      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
        vi.resetModules();
        const { runUninstallAllGatewayPorts: runSweep } = await import("./all-gateway-ports");
        const result = await runSweep(OPTIONS, {
          commandExists: () => true,
          env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
          existsSync: fs.existsSync,
          hasPortableRuntimeCleanup: () => false,
          home,
          isTty: false,
          kill: () => true,
          listGatewayPorts: () => [9123],
          log: vi.fn(),
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "nemoclaw-managed",
            source: "standalone",
            endpoint: null,
            stateDir: null,
            supervisor: null,
            requiredCapabilities: [],
          }),
          rmSync: fs.rmSync,
          run: (command, args) =>
            command === "openshell" && args.join(" ") === "gateway list -o json"
              ? {
                  status: 0,
                  stdout: JSON.stringify([
                    { name: "nemoclaw-9123" },
                    ...(evidence === "live gateway" ? [{ name: "nemoclaw" }] : []),
                  ]),
                  stderr: "",
                }
              : { status: 0, stdout: "", stderr: "" },
          runDocker: () => ({ status: 0, stdout: "", stderr: "" }),
          runLocalModelRuntimeCleanup: () => ({
            status: 0,
            stdout: JSON.stringify({ ok: true, removed: [], skipped: [] }),
            stderr: "",
          }),
          withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
        });

        expect(result).toEqual({ exitCode: 1, ports: [9123] });
        expect(fs.existsSync(apiKeyPath)).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("does not treat the shared home root as a default gateway without gateway evidence (#13332)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-no-default-"));
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "9123");
    fs.mkdirSync(gatewayRoot, { recursive: true });

    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const { runUninstallAllGatewayPorts: runSweep } = await import("./all-gateway-ports");
      expect(listGatewayStateRoots(home).map(({ gatewayPort }) => gatewayPort)).toEqual([
        8080, 9123,
      ]);
      const { deps, runPortPass, runSelectedPass } = sweepDeps({
        env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
        home,
        listGatewayPorts: undefined,
        gatewayStateDirForPort: () => null,
      });

      const result = await runSweep(OPTIONS, deps);

      expect(result).toEqual({ exitCode: 0, ports: [9123] });
      expect(runPortPass).not.toHaveBeenCalled();
      expect(runSelectedPass).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["default", (_home: string) => undefined],
    [
      "custom",
      (home: string) =>
        writeDockerDriverGatewayBinding(home, 8080, {
          stateDir: path.join(home, "custom-default-gateway"),
          dockerNetworkName: "mvca-nemoclaw-b1",
        }),
    ],
  ])(
    "retains a default gateway when its config is present without a registry (%s state) (#13332)",
    async (_stateKind, configureStateDir) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-default-config-"));
      const sharedRoot = path.join(home, ".nemoclaw");
      const gatewayRoot = path.join(sharedRoot, "gateways", "9123");
      fs.mkdirSync(gatewayRoot, { recursive: true });
      configureStateDir(home);
      const gatewayStateDir = resolveGatewayStateDirForPort({ home, port: 8080 });
      fs.mkdirSync(gatewayStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(gatewayStateDir, "openshell-gateway.toml"),
        "legacy gateway config\n",
      );

      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
        vi.resetModules();
        const { runUninstallAllGatewayPorts: runSweep } = await import("./all-gateway-ports");
        const { deps, runPortPass, runSelectedPass } = sweepDeps({
          env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
          home,
          listGatewayPorts: undefined,
          gatewayStateDirForPort: () => null,
        });

        const result = await runSweep(OPTIONS, deps);

        expect(result.ports).toEqual([8080, 9123]);
        expect(runPortPass.mock.calls.map(([port]) => port)).toEqual([8080]);
        expect(runSelectedPass).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["directory", (configPath: string) => fs.mkdirSync(configPath)],
    [
      "symbolic link",
      (configPath: string) => {
        const target = path.join(path.dirname(configPath), "actual-config.toml");
        fs.writeFileSync(target, "legacy gateway config\n");
        fs.symlinkSync(target, configPath);
      },
    ],
  ])(
    "does not treat a %s as default gateway config evidence (#13332)",
    async (_entryKind, createConfigEntry) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-invalid-config-"));
      const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "9123");
      const gatewayStateDir = resolveGatewayStateDirForPort({ home, port: 8080 });
      fs.mkdirSync(gatewayRoot, { recursive: true });
      fs.mkdirSync(gatewayStateDir, { recursive: true });
      createConfigEntry(path.join(gatewayStateDir, "openshell-gateway.toml"));

      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
        vi.resetModules();
        const { runUninstallAllGatewayPorts: runSweep } = await import("./all-gateway-ports");
        const { deps, runPortPass, runSelectedPass } = sweepDeps({
          env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
          home,
          listGatewayPorts: undefined,
          gatewayStateDirForPort: () => null,
        });

        const result = await runSweep(OPTIONS, deps);

        expect(result).toEqual({ exitCode: 0, ports: [9123] });
        expect(runPortPass).not.toHaveBeenCalled();
        expect(runSelectedPass).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("includes a default gateway with a registered sandbox in the whole-host sweep (#13332)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-default-present-"));
    const sharedRoot = path.join(home, ".nemoclaw");
    const gatewayRoot = path.join(sharedRoot, "gateways", "9123");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sharedRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "default-sandbox",
        sandboxes: {
          "default-sandbox": {
            name: "default-sandbox",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
          },
        },
      }),
    );

    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const { runUninstallAllGatewayPorts: runSweep } = await import("./all-gateway-ports");
      const { deps, runPortPass, runSelectedPass } = sweepDeps({
        env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
        home,
        listGatewayPorts: undefined,
        gatewayStateDirForPort: () => null,
      });

      const result = await runSweep(OPTIONS, deps);

      expect(result.ports).toEqual([8080, 9123]);
      expect(runPortPass.mock.calls.map(([port]) => port)).toEqual([8080]);
      expect(runSelectedPass).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns nonzero when an undiscovered environment remains after the only selected pass", async () => {
    const { deps, error } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: vi.fn(async () => ({
        exitCode: 0,
        otherGatewayEnvironmentsRemain: true,
      })),
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Whole-host uninstall is incomplete"),
    );
  });

  it("fails without uninstalling anything when the gateway ports cannot be enumerated", async () => {
    const { deps, error, runPortPass, runSelectedPass } = sweepDeps({
      listGatewayPorts: () => {
        throw new Error("gateways/ is a symbolic link");
      },
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result).toEqual({ exitCode: 1, ports: [] });
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("symbolic link"));
  });

  it("awaits the selected pass when no sibling gateway exists (#9189)", async () => {
    let finish!: () => void;
    const selected = vi.fn(
      () =>
        new Promise<{ exitCode: number }>((resolve) => (finish = () => resolve({ exitCode: 0 }))),
    );
    const { deps, runPortPass } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: selected,
    });
    let completed = false;
    const pending = runUninstallAllGatewayPorts(OPTIONS, deps).then((result) => {
      completed = true;
      return result;
    });

    await Promise.resolve();
    expect(selected).toHaveBeenCalledOnce();
    expect(runPortPass).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    finish();
    await expect(pending).resolves.toEqual({ exitCode: 0, ports: [8080] });
  });

  it("finishes child passes before the awaited selected pass and retains failures (#9189)", async () => {
    const order: string[] = [];
    const { deps } = sweepDeps({
      runPortPass: (port) => {
        order.push(`child:${String(port)}`);
        return port === 9000 ? 1 : 0;
      },
      runSelectedPass: async (_options, selectedDeps) => {
        order.push(`selected:${selectedDeps.retainedGatewayPorts?.join(",")}`);
        await Promise.resolve();
        order.push("selected:done");
        return { exitCode: 0 };
      },
    });

    await expect(runUninstallAllGatewayPorts(OPTIONS, deps)).resolves.toMatchObject({
      exitCode: 1,
    });
    expect(order).toEqual(["child:9000", "child:18080", "selected:9000", "selected:done"]);
  });

  it("maps a selected-pass rejection to exit 1 without a follow-on pass (#9189)", async () => {
    const selected = vi.fn(async () => {
      throw new Error("host fence release failed");
    });
    const { deps, error, runPortPass } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: selected,
    });

    await expect(runUninstallAllGatewayPorts(OPTIONS, deps)).resolves.toEqual({
      exitCode: 1,
      ports: [8080],
    });
    expect(selected).toHaveBeenCalledOnce();
    expect(runPortPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("host fence release failed"));
  });

  it("binds each child pass to its own gateway port and drops selected-only state", () => {
    const env = {
      HOME: "/home/tester",
      NEMOCLAW_GATEWAY_PORT: "8080",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/srv/nemoclaw/selected-gateway",
      [ALL_GATEWAY_PORTS_ENV]: "1",
    } as NodeJS.ProcessEnv;

    const childEnv = uninstallChildEnv(env, 9000);

    expect(childEnv.NEMOCLAW_GATEWAY_PORT).toBe("9000");
    expect(childEnv.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBeUndefined();
    expect(childEnv[ALL_GATEWAY_PORTS_ENV]).toBeUndefined();
    expect(env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBe("/srv/nemoclaw/selected-gateway");
  });

  it("binds a recorded custom state directory to the matching child only (#10665)", () => {
    const env = {
      HOME: "/home/tester",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/srv/nemoclaw/selected-gateway",
      [ALL_GATEWAY_PORTS_ENV]: "1",
    } as NodeJS.ProcessEnv;

    const childEnv = uninstallChildEnv(env, 9000, "/srv/nemoclaw/recorded-gateway-9000");

    expect(childEnv).toMatchObject({
      NEMOCLAW_GATEWAY_PORT: "9000",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/srv/nemoclaw/recorded-gateway-9000",
    });
    expect(childEnv[ALL_GATEWAY_PORTS_ENV]).toBeUndefined();
    expect(env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBe("/srv/nemoclaw/selected-gateway");
  });

  it.each([
    [
      "no extra flags",
      {},
      ["internal", "uninstall", "run-plan", "--yes", "--all-gateway-ports-child"],
    ],
    [
      "every passthrough flag",
      {
        deleteModels: true,
        destroyUserData: true,
        forceFreshReset: true,
        keepOpenShell: true,
      },
      [
        "internal",
        "uninstall",
        "run-plan",
        "--yes",
        "--all-gateway-ports-child",
        "--delete-models",
        "--destroy-user-data",
        "--force-fresh-reset",
        "--keep-openshell",
      ],
    ],
  ] as const)("passes %s to a child gateway-port pass", (_scenario, overrides, expected) => {
    expect(uninstallChildArgs({ ...OPTIONS, ...overrides })).toEqual(expected);
  });

  it("passes retained failed ports to the final child gateway-port pass", () => {
    expect(uninstallChildArgs(OPTIONS, [9000, 18080])).toEqual([
      "internal",
      "uninstall",
      "run-plan",
      "--yes",
      "--all-gateway-ports-child",
      "--retained-gateway-port",
      "9000",
      "--retained-gateway-port",
      "18080",
    ]);
  });

  it("passes validated default-gateway absence only to the final child", async () => {
    const { deps, runPortPass } = sweepDeps({ listGatewayPorts: () => [9000, 9123] });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runPortPass.mock.calls.map(([port, , , , absent]) => [port, absent])).toEqual([
      [9000, false],
      [9123, true],
    ]);
    expect(uninstallChildArgs(OPTIONS, [], true)).toContain("--sweep-default-gateway-absent");
  });
});
