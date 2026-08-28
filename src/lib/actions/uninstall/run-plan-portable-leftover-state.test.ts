// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { withSuccessfulPreUninstallBackup } from "../../../../test/support/uninstall-managed-gateway-test-support";

import { createSession } from "../../state/onboard-session";
import { hasPortableRuntimeCleanup } from "./portable-runtime-cleanup";
import {
  type RunResult,
  runUninstallPlanProduction as runUninstallPlanBase,
  type UninstallRunDeps,
} from "./run-plan";

const temporaryDirectories: string[] = [];
const restoredDirectories: string[] = [];

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function knownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

function scope(prefix: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(homeDir);
  return {
    homeDir,
    stateDir: path.join(homeDir, ".nemoclaw"),
    kill: vi.fn(() => true),
    rmSync: vi.fn(),
    run: vi.fn(knownGatewayList),
    runDocker: vi.fn(() => ok()),
    runModelCleanup: vi.fn(() => ok()),
    runPortableCleanup: vi.fn(),
  };
}

function deps(host: ReturnType<typeof scope>): UninstallRunDeps {
  return {
    commandExists: (command) => command === "openshell",
    env: { HOME: host.homeDir },
    hasPortableRuntimeCleanup,
    isTty: false,
    kill: host.kill,
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
    rmSync: host.rmSync,
    run: host.run,
    runDocker: host.runDocker,
    runDualStationRuntimeCleanup: host.runModelCleanup,
    runHuggingFaceCacheDataCleanup: host.runModelCleanup,
    runLocalModelRuntimeCleanup: host.runModelCleanup,
    runManagedLlamaCppRuntimeCleanup: host.runModelCleanup,
    runPortableRuntimeCleanupTransaction: host.runPortableCleanup,
    withPortableHostFence: async (_home, operation) => await operation(),
  };
}

function uninstall(host: ReturnType<typeof scope>) {
  return runUninstallPlanBase(
    { assumeYes: true, deleteModels: false, destroyUserData: false, keepOpenShell: false },
    withSuccessfulPreUninstallBackup(deps(host)),
  );
}

function stateRoot(host: ReturnType<typeof scope>): string {
  fs.mkdirSync(host.stateDir, { mode: 0o700, recursive: true });
  return host.stateDir;
}

function failedPreflightSession(host: ReturnType<typeof scope>): void {
  const session = createSession({ sessionId: "interrupted-at-preflight" });
  session.status = "failed";
  session.lastStepStarted = "preflight";
  session.failure = {
    step: "preflight",
    message: "Onboarding exited before the step completed.",
    interrupted: true,
  } as never;
  session.checkpoint = {
    schemaVersion: 4,
    sessionId: "interrupted-at-preflight",
    machineState: "preflight",
    updatedAt: "2026-08-19T00:00:00.000Z",
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
    sandboxIdentity: { kind: "unset" },
    webSearch: { kind: "unset" },
    messaging: { kind: "unset" },
    resourceProfile: { kind: "unset" },
    gatewayAuthority: { kind: "unset" },
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate: null,
  } as never;
  fs.writeFileSync(
    path.join(stateRoot(host), "onboard-session.json"),
    `${JSON.stringify(session)}\n`,
    { mode: 0o600 },
  );
}

function abandonedPortableConfig(host: ReturnType<typeof scope>, mode: number): string {
  const directory = path.join(host.homeDir, ".config/nemoclaw/portable");
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(directory, "containers.conf"), "[containers]\n", { mode: 0o600 });
  fs.chmodSync(directory, mode);
  restoredDirectories.push(directory);
  return directory;
}

function completedOpenClawAuthority(
  host: ReturnType<typeof scope>,
  profile: "default" | "portable",
  registryAgent: null | "openclaw" | "hermes" = null,
): void {
  const portable = profile === "portable";
  const uid = process.getuid?.() ?? 1001;
  const sessionId = "completed-openclaw-session";
  const sandboxName = "openclaw-sandbox";
  const generation = "e".repeat(64);
  const gateway = {
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
  const session = createSession({
    agent: null,
    sandboxName,
    sessionId,
    metadata: { gatewayName: gateway.gatewayName, fromDockerfile: null },
  });
  session.status = "complete";
  session.resumable = false;
  session.machine = {
    version: 1,
    state: "complete",
    stateEnteredAt: "2026-08-19T00:00:00.000Z",
    revision: 1,
  };
  session.checkpoint = {
    schemaVersion: 4,
    sessionId,
    machineState: "complete",
    updatedAt: "2026-08-19T00:00:00.000Z",
    profile: { kind: "selected", value: profile },
    runtimeAuthority: portable
      ? {
          kind: "selected",
          value: {
            schemaVersion: 1,
            kind: "podman",
            ownership: "current-user",
            uid,
            homeDir: host.homeDir,
            configHome: path.join(host.homeDir, ".config"),
            runtimeDir: `/run/user/${uid}`,
            socketPath: `/run/user/${uid}/podman/podman.sock`,
          },
        }
      : { kind: "unset" },
    sandboxIdentity: { kind: "selected", value: { name: sandboxName, agent: "openclaw" } },
    webSearch: { kind: "unset" },
    messaging: { kind: "unset" },
    resourceProfile: { kind: "unset" },
    gatewayAuthority: { kind: "selected", value: gateway },
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate: null,
  } as never;
  fs.writeFileSync(
    path.join(stateRoot(host), "onboard-session.json"),
    `${JSON.stringify(session)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(host.stateDir, "sandboxes.json"),
    `${JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          agent: registryAgent,
          dashboardPort: 18789,
          gatewayName: gateway.gatewayName,
          gatewayPort: gateway.gatewayPort,
          lifecycleGeneration: generation,
          openshellDriver: "docker",
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  portable && abandonedPortableConfig(host, 0o700);
  portable && fs.mkdirSync(path.join(host.stateDir, "portable-demo-lifecycle"), { mode: 0o700 });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of restoredDirectories.splice(0)) fs.chmodSync(directory, 0o700);
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});

describe("uninstall on a host that owns no portable lifecycle resource", () => {
  const expectOrdinaryUninstall = async (host: ReturnType<typeof scope>) => {
    const result = await uninstall(host);

    expect(result.exitCode).toBe(0);
    expect(host.run).toHaveBeenCalled();
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  };

  it.each<[string, (host: ReturnType<typeof scope>) => void]>([
    ["a prior onboard failed before it established any authority", failedPreflightSession],
    ["onboarding never wrote a session", (host) => void stateRoot(host)],
    ["no state directory was ever created", () => undefined],
  ])("removes host state when %s (#9573)", async (_case, prepare) => {
    const host = scope("nemoclaw-uninstall-leftover-");
    prepare(host);

    await expectOrdinaryUninstall(host);
  });

  it.each([0o755, 0o600])(
    "removes host state when an abandoned portable configuration directory has mode %i (#9581)",
    async (mode) => {
      const host = scope("nemoclaw-uninstall-config-");
      stateRoot(host);
      const directory = abandonedPortableConfig(host, mode);
      restoredDirectories.pop();
      host.rmSync.mockImplementation((target, options) => {
        const resolvedTarget = path.resolve(String(target));
        expect(resolvedTarget.startsWith(`${host.homeDir}${path.sep}`)).toBe(true);
        fs.rmSync(resolvedTarget, options);
      });

      await expectOrdinaryUninstall(host);
      expect(fs.existsSync(directory)).toBe(false);
    },
  );

  it.each([0o700, 0o755, 0o600])(
    "removes abandoned portable configuration with mode %i after completed ordinary onboarding (#10545)",
    async (mode) => {
      const host = scope("nemoclaw-uninstall-completed-openclaw-");
      completedOpenClawAuthority(host, "default");
      const directory = abandonedPortableConfig(host, mode);
      restoredDirectories.pop();
      host.rmSync.mockImplementation((target, options) => {
        const resolvedTarget = path.resolve(String(target));
        expect(resolvedTarget.startsWith(`${host.homeDir}${path.sep}`)).toBe(true);
        fs.rmSync(resolvedTarget, options);
      });

      await expectOrdinaryUninstall(host);
      expect(fs.existsSync(directory)).toBe(false);
    },
  );

  it("refuses uninstall when an unexpected Portable configuration file remains after ordinary onboarding (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-extra-config-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    fs.writeFileSync(path.join(directory, "unexpected.conf"), "unexpected\n", { mode: 0o600 });

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(path.join(directory, "containers.conf"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "unexpected.conf"))).toBe(true);
    expect(host.runModelCleanup).not.toHaveBeenCalled();
    expect(host.rmSync).not.toHaveBeenCalled();
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("refuses uninstall when Portable configuration changes while preparing ordinary cleanup (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-config-race-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o600);
    const fchmodSync = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
      fchmodSync(descriptor, mode);
      fs.writeFileSync(path.join(directory, "unexpected.conf"), "unexpected\n", { mode: 0o600 });
    });

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(path.join(directory, "containers.conf"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "unexpected.conf"))).toBe(true);
    expect(host.rmSync.mock.calls.map(([target]) => path.resolve(String(target)))).not.toContain(
      path.dirname(directory),
    );
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("preserves replacement Portable configuration after binding abandoned cleanup (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-config-replacement-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    const renameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      const replace = () => {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.writeFileSync(path.join(directory, "replacement.conf"), "replacement\n", {
          mode: 0o600,
        });
      };
      new Map([[path.resolve(directory), replace]]).get(path.resolve(String(source)))?.();
    });
    host.rmSync.mockImplementation((target, options) => {
      const resolvedTarget = path.resolve(String(target));
      expect(resolvedTarget.startsWith(`${host.homeDir}${path.sep}`)).toBe(true);
      fs.rmSync(resolvedTarget, options);
    });

    const result = await uninstall(host);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(directory, "containers.conf"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "replacement.conf"))).toBe(true);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("refuses a quarantined Portable pathname replacement immediately before removal (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-quarantine-replacement-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    restoredDirectories.pop();
    const originalOpenSync = fs.openSync;
    let boundPortableOpenCount = 0;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const descriptor = originalOpenSync(target, flags, mode);
      const resolved = path.resolve(String(target));
      const recoveryEntry = path.basename(path.dirname(resolved));
      const isBoundPortable =
        resolved.endsWith(`${path.sep}portable`) &&
        recoveryEntry.startsWith(".portable-cleanup-v1-bound-");
      const openCount = isBoundPortable ? ++boundPortableOpenCount : boundPortableOpenCount;
      const replace = () => {
        const verifiedDirectory = path.join(path.dirname(resolved), "verified-portable");
        fs.renameSync(resolved, verifiedDirectory);
        fs.mkdirSync(resolved, { mode: 0o700 });
        fs.writeFileSync(path.join(resolved, "replacement.conf"), "replacement\n", {
          mode: 0o600,
        });
      };
      (isBoundPortable && openCount === 2 ? replace : () => undefined)();
      return descriptor;
    });

    const result = await uninstall(host);

    const configDirectory = path.dirname(directory);
    const recoveryEntry = fs
      .readdirSync(configDirectory)
      .find((entry) => entry.startsWith(".portable-cleanup-v1-bound-"));
    expect(result.exitCode).toBe(1);
    expect(recoveryEntry).toBeDefined();
    expect(
      fs.existsSync(
        path.join(configDirectory, recoveryEntry!, "verified-portable", "containers.conf"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(configDirectory, recoveryEntry!, "portable", "replacement.conf")),
    ).toBe(true);
    expect(
      host.rmSync.mock.calls.some(([target]) =>
        path.resolve(String(target)).startsWith(`${configDirectory}${path.sep}`),
      ),
    ).toBe(false);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("retries identity-bound Portable removal after later configuration cleanup fails (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-cleanup-retry-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    const configDirectory = path.dirname(directory);
    const laterConfiguration = path.join(configDirectory, "ordinary.conf");
    fs.writeFileSync(laterConfiguration, "ordinary\n", { mode: 0o600 });
    let failLaterCleanup = true;
    host.rmSync.mockImplementation((target, options) => {
      const resolvedTarget = path.resolve(String(target));
      expect(resolvedTarget.startsWith(`${host.homeDir}${path.sep}`)).toBe(true);
      return resolvedTarget === laterConfiguration && failLaterCleanup
        ? (() => {
            failLaterCleanup = false;
            throw new Error("injected later configuration cleanup failure");
          })()
        : fs.rmSync(resolvedTarget, options);
    });

    const first = await uninstall(host);

    expect(first.exitCode).toBe(1);
    expect(fs.existsSync(directory)).toBe(false);
    expect(
      fs
        .readdirSync(configDirectory)
        .some((entry) => entry.startsWith(".portable-cleanup-v1-removed-")),
    ).toBe(true);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "containers.conf"), "replacement\n", { mode: 0o600 });

    const second = await uninstall(host);

    expect(second.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(directory, "containers.conf"), "utf-8")).toBe("replacement\n");
    expect(fs.existsSync(laterConfiguration)).toBe(false);
    expect(
      fs.readdirSync(configDirectory).some((entry) => entry.startsWith(".portable-cleanup-v1-")),
    ).toBe(false);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("ignores a PATH-preceding Python helper during identity-bound cleanup (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-python-path-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    restoredDirectories.pop();
    const attackerBin = path.join(host.homeDir, "attacker-bin");
    const attackerPython = path.join(attackerBin, "python3");
    fs.mkdirSync(attackerBin, { mode: 0o700 });
    fs.writeFileSync(attackerPython, '#!/bin/sh\n: > "$0.used"\nexit 97\n', { mode: 0o700 });
    vi.stubEnv("PATH", `${attackerBin}${path.delimiter}${process.env.PATH ?? ""}`);
    host.rmSync.mockImplementation((target, options) => {
      const resolvedTarget = path.resolve(String(target));
      expect(resolvedTarget.startsWith(`${host.homeDir}${path.sep}`)).toBe(true);
      fs.rmSync(resolvedTarget, options);
    });

    const result = await uninstall(host);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(`${attackerPython}.used`)).toBe(false);
    expect(fs.existsSync(directory)).toBe(false);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it.each<[string, (configuration: string, homeDir: string) => string]>([
    [
      "a directory at containers.conf",
      (configuration) => {
        fs.unlinkSync(configuration);
        fs.mkdirSync(configuration, { mode: 0o700 });
        const preserved = path.join(configuration, "preserved.txt");
        fs.writeFileSync(preserved, "preserved\n", { mode: 0o600 });
        return preserved;
      },
    ],
    [
      "a symlink at containers.conf",
      (configuration, homeDir) => {
        fs.unlinkSync(configuration);
        const preserved = path.join(homeDir, "symlink-target.conf");
        fs.writeFileSync(preserved, "preserved\n", { mode: 0o600 });
        fs.symlinkSync(preserved, configuration);
        return preserved;
      },
    ],
    [
      "a hard link at containers.conf",
      (configuration, homeDir) => {
        fs.unlinkSync(configuration);
        const preserved = path.join(homeDir, "hard-link-target.conf");
        fs.writeFileSync(preserved, "preserved\n", { mode: 0o600 });
        fs.linkSync(preserved, configuration);
        return preserved;
      },
    ],
  ])("refuses %s before abandoned configuration removal (#10545)", async (_case, prepare) => {
    const host = scope("nemoclaw-uninstall-completed-config-entry-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    const configuration = path.join(directory, "containers.conf");
    const preserved = prepare(configuration, host.homeDir);

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(preserved)).toBe(true);
    expect(fs.existsSync(configuration)).toBe(true);
    expect(
      host.rmSync.mock.calls.some(([target]) =>
        path.resolve(String(target)).startsWith(`${path.dirname(directory)}${path.sep}`),
      ),
    ).toBe(false);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("refuses a foreign-owned containers.conf before abandoned configuration removal (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-foreign-config-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    const configuration = path.join(directory, "containers.conf");
    const lstatSync = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const stat =
        lstatSync(target, options) ??
        (() => {
          throw new Error("lstat returned no metadata");
        })();
      const foreignStat = stat as fs.BigIntStats;
      const substituted = new Proxy(foreignStat, {
        get: (value, property, receiver) =>
          property === "uid" ? foreignStat.uid + 1n : Reflect.get(value, property, receiver),
      });
      return path.resolve(String(target)) === path.resolve(configuration) &&
        typeof stat.uid === "bigint"
        ? substituted
        : stat;
    }) as typeof fs.lstatSync);

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(configuration)).toBe(true);
    expect(
      host.rmSync.mock.calls.some(([target]) =>
        path.resolve(String(target)).startsWith(`${path.dirname(directory)}${path.sep}`),
      ),
    ).toBe(false);
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("completes ordinary uninstall when managed OpenClaw registration records its explicit agent (#10073)", async () => {
    const host = scope("nemoclaw-uninstall-managed-openclaw-");
    completedOpenClawAuthority(host, "default", "openclaw");

    await expectOrdinaryUninstall(host);
  });

  it("reports the registry agent field and recovery when completed onboarding identity drifts (#10073)", async () => {
    const host = scope("nemoclaw-uninstall-agent-drift-");
    completedOpenClawAuthority(host, "default", "hermes");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('registry field "agent"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sandbox "openclaw-sandbox"'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Restore the registry entry from trusted completed-onboarding state, then retry uninstall.",
      ),
    );
    expect(host.runModelCleanup).not.toHaveBeenCalled();
    expect(host.rmSync).not.toHaveBeenCalled();
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("refuses completed portable authority after its lifecycle receipt disappears", async () => {
    const host = scope("nemoclaw-uninstall-completed-portable-");
    completedOpenClawAuthority(host, "portable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Portable lifecycle state is unsafe"),
    );
    expect(host.runModelCleanup).not.toHaveBeenCalled();
    expect(host.rmSync).not.toHaveBeenCalled();
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("removes the state directory a failed onboarding left behind (#9573)", async () => {
    const host = scope("nemoclaw-uninstall-state-");
    failedPreflightSession(host);

    const result = await uninstall(host);

    expect(result.exitCode).toBe(0);
    expect(host.rmSync.mock.calls.map(([target]) => String(target))).toContain(host.stateDir);
  });

  it("refuses an unknown portable uninstall artifact in the configuration directory (#9581)", async () => {
    const host = scope("nemoclaw-uninstall-hidden-");
    stateRoot(host);
    const directory = abandonedPortableConfig(host, 0o755);
    fs.writeFileSync(
      path.join(directory, `.containers.conf.portable-uninstall-${"e".repeat(64)}.cleanup`),
      "unknown",
      { mode: 0o600 },
    );

    const result = await uninstall(host);

    expect(result.exitCode).toBe(1);
    expect(host.rmSync).not.toHaveBeenCalled();
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("reports no portable cleanup without demanding a completed onboarding session (#9573)", () => {
    const host = scope("nemoclaw-uninstall-gate-");
    failedPreflightSession(host);

    expect(hasPortableRuntimeCleanup(host.stateDir)).toBe(false);
  });
});
