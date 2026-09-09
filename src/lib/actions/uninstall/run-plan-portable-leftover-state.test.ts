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
  const host = {
    homeDir,
    stateDir: path.join(homeDir, ".nemoclaw"),
    portableFenceHeld: false,
    kill: vi.fn(() => true),
    rmSync: vi.fn(),
    run: vi.fn(knownGatewayList),
    runDocker: vi.fn(() => ok()),
    runModelCleanup: vi.fn(() => ok()),
    runPortableCleanup: vi.fn(),
  };
  host.rmSync.mockImplementation((target: fs.PathLike, options?: fs.RmDirOptions) => {
    const resolvedTarget = path.resolve(String(target));
    expect(resolvedTarget.startsWith(`${homeDir}${path.sep}`)).toBe(true);
    expect(host.portableFenceHeld).toBe(true);
    fs.rmSync(resolvedTarget, options);
  });
  return host;
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
    withPortableHostFence: async (_home, operation) => {
      host.portableFenceHeld = true;
      try {
        return await operation();
      } finally {
        host.portableFenceHeld = false;
      }
    },
  };
}

function uninstall(host: ReturnType<typeof scope>, destroyUserData = false) {
  return runUninstallPlanBase(
    { assumeYes: true, deleteModels: false, destroyUserData, keepOpenShell: false },
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

  it("preserves a nontraversable Portable directory while ordinary uninstall completes (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-config-");
    stateRoot(host);
    const directory = abandonedPortableConfig(host, 0o600);
    const before = fs.lstatSync(directory);

    await expectOrdinaryUninstall(host);

    const after = fs.lstatSync(directory);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(
      host.rmSync.mock.calls.some(([target]) =>
        path.resolve(String(target)).startsWith(`${directory}${path.sep}`),
      ),
    ).toBe(false);
  });

  it.each<[string, (host: ReturnType<typeof scope>) => void]>([
    ["a prior onboard failed", failedPreflightSession],
    ["onboarding never wrote a session", (host) => void stateRoot(host)],
    ["the state directory is absent", () => undefined],
  ])("preserves abandoned Portable configuration when %s (#10545)", async (_case, prepare) => {
    const host = scope("nemoclaw-uninstall-preserved-config-");
    prepare(host);
    const directory = abandonedPortableConfig(host, 0o700);

    await expectOrdinaryUninstall(host);

    expect(fs.readFileSync(path.join(directory, "containers.conf"), "utf-8")).toBe(
      "[containers]\n",
    );
  });

  it("completes ordinary uninstall after completed default OpenClaw onboarding", async () => {
    const host = scope("nemoclaw-uninstall-completed-openclaw-");
    completedOpenClawAuthority(host, "default");

    await expectOrdinaryUninstall(host);
  });

  it("preserves abandoned Portable configuration after completed ordinary onboarding (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-completed-config-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);

    await expectOrdinaryUninstall(host);

    expect(fs.readFileSync(path.join(directory, "containers.conf"), "utf-8")).toBe(
      "[containers]\n",
    );
  });

  it("preserves unexpected ambient Portable content without traversing it (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-unexpected-config-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);
    fs.mkdirSync(path.join(directory, "containers.conf.d"), { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "unexpected.conf"), "unexpected\n", { mode: 0o600 });
    fs.linkSync(
      path.join(directory, "containers.conf"),
      path.join(directory, "containers.conf.hard-link"),
    );

    await expectOrdinaryUninstall(host);

    expect(fs.readFileSync(path.join(directory, "unexpected.conf"), "utf-8")).toBe("unexpected\n");
    expect(fs.lstatSync(path.join(directory, "containers.conf")).nlink).toBe(2);
    expect(fs.lstatSync(path.join(directory, "containers.conf.d")).isDirectory()).toBe(true);
  });

  it("preserves a symbolic-link Portable path without following it (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-symlink-config-");
    completedOpenClawAuthority(host, "default");
    const target = path.join(host.homeDir, "portable-target");
    const directory = path.join(host.homeDir, ".config/nemoclaw/portable");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "unrelated.conf"), "unrelated\n", { mode: 0o600 });
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.symlinkSync(target, directory);

    await expectOrdinaryUninstall(host);

    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, "unrelated.conf"), "utf-8")).toBe("unrelated\n");
  });

  it("preserves abandoned Portable configuration when user-data destruction is requested (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-destroy-config-");
    completedOpenClawAuthority(host, "default");
    const directory = abandonedPortableConfig(host, 0o700);

    const result = await uninstall(host, true);

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(directory, "containers.conf"), "utf-8")).toBe(
      "[containers]\n",
    );
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

  it("preserves an ambient portable-uninstall-like configuration artifact without treating it as lifecycle evidence (#10545)", async () => {
    const host = scope("nemoclaw-uninstall-hidden-");
    stateRoot(host);
    const directory = abandonedPortableConfig(host, 0o755);
    fs.writeFileSync(
      path.join(directory, `.containers.conf.portable-uninstall-${"e".repeat(64)}.cleanup`),
      "unknown",
      { mode: 0o600 },
    );

    await expectOrdinaryUninstall(host);

    expect(
      fs.readFileSync(
        path.join(directory, `.containers.conf.portable-uninstall-${"e".repeat(64)}.cleanup`),
        "utf-8",
      ),
    ).toBe("unknown");
    expect(host.runPortableCleanup).not.toHaveBeenCalled();
  });

  it("reports no portable cleanup without demanding a completed onboarding session (#9573)", () => {
    const host = scope("nemoclaw-uninstall-gate-");
    failedPreflightSession(host);

    expect(hasPortableRuntimeCleanup(host.stateDir)).toBe(false);
  });
});
