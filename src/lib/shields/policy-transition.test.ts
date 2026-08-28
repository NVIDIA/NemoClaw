// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import YAML from "yaml";
import {
  createShieldsFlowHarness,
  externalPolicyAuthorityInspection,
  type ShieldsFlowHarnessOptions,
} from "../../../test/helpers/shields-flow-harness";

const requireSource = createRequire(import.meta.url);
const SHIELDS_MODULE = "./index.js";
const DEEP_AGENTS_LOCK_ERROR_PREFIX = "NEMOCLAW_DEEP_AGENTS_CONFIG_LOCK_ERROR_V1";
const DEEP_AGENTS_LOCK_GENERIC_ERROR = "Deep Agents config lock transaction failed.";

function lockFailure(status: string): string {
  return `${DEEP_AGENTS_LOCK_ERROR_PREFIX}:${status}\n`;
}

function sandboxCommandFailure(
  stderr: string | Buffer | undefined,
  message = "sandbox command failed",
  stdout: string | Buffer | undefined = undefined,
): Error {
  return Object.assign(new Error(message), { stderr, stdout });
}
const TRANSITION_LOCK_MODULE = "./transition-lock.js";

function mockManagedPolicyAuthority(sandboxName: string): void {
  const registry = requireSource("../state/registry.js") as typeof import("../state/registry.js");
  const policyAuthority = requireSource(
    "../adapters/openshell/policy-authority.js",
  ) as typeof import("../adapters/openshell/policy-authority.js");
  const policy = requireSource("../policy/index.js") as typeof import("../policy/index.js");
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    openshellDriver: "docker",
    policyAuthority: "nemoclaw-managed",
  });
  vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
    authority: "nemoclaw-managed",
    effectivePolicy: { version: 1, network_policies: {} },
    policyIdentity: { hash: "sha256:managed", activeVersion: 1 },
  });
  const receipt = {
    authority: "nemoclaw-managed" as const,
    authorityRecordedNow: false,
    gatewayName: "nemoclaw",
    inspection: {
      authority: "nemoclaw-managed" as const,
      effectivePolicy: { version: 1, network_policies: {} },
      policyIdentity: { hash: "sha256:managed", activeVersion: 1 },
    },
  };
  vi.spyOn(policy, "inspectPolicyMutationAuthority").mockReturnValue(receipt);
  vi.spyOn(policy, "inspectPolicyRecoveryAuthority").mockReturnValue(receipt);
  vi.spyOn(policy, "recheckPolicyMutationAuthority").mockReturnValue(receipt);
  vi.spyOn(policy, "finalizePolicyMutationReceipt").mockImplementation(() => undefined);
}

describe("shields policy transition", () => {
  let homeDir: string;
  let runSpy: MockInstance;
  let runCaptureSpy: MockInstance;
  let shields: typeof import("./index.js");

  function writePolicySnapshot(sandboxName: string, fileName: string): string {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, fileName);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath }),
    );
    return snapshotPath;
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-policy-transition-"));
    vi.stubEnv("HOME", homeDir);
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];

    const runner = requireSource("../runner.js");
    const agentConfig = requireSource("../sandbox/agent-config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    runCaptureSpy = vi.spyOn(runner, "runCapture").mockImplementation(() => {
      throw new Error("policy get failed with status 42");
    });
    vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue({
      agentName: "langchain-deepagents-code",
      configDir: "/sandbox/.deepagents",
      configFile: "config.json",
      configPath: "/sandbox/.deepagents/config.json",
      format: "json",
      stateLockPlan: {
        version: 1,
        readOnlyRoots: ["skills"],
        confidentialRoots: [],
        readOnlyPrefixes: [],
        confidentialPrefixes: [],
        writableSubpaths: [],
      },
      stateLockPlanInImage: false,
    });
    vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
      (_sandboxName: unknown, cmd: unknown) => cmd as string[],
    );
    vi.spyOn(dockerExec, "dockerExecFileSync").mockReturnValue("");
    mockManagedPolicyAuthority("openclaw");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    shields = requireSource(SHIELDS_MODULE);
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("rechecks policy authority immediately before direct snapshot restore (#9833)", () => {
    const sandboxName = "openclaw";
    const snapshotPath = writePolicySnapshot(sandboxName, "policy-snapshot-authority-race.yaml");
    const policy = requireSource("../policy/index.js") as typeof import("../policy/index.js");
    vi.mocked(policy.recheckPolicyMutationAuthority).mockImplementation(() => {
      throw new Error("OpenShell policy authority changed during snapshot restore");
    });

    expect(() => shields.applyShieldsPolicySnapshot(sandboxName, snapshotPath)).toThrow(
      /policy authority changed/,
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("refuses external authority before Shields snapshot recovery (#9833)", () => {
    const sandboxName = "openclaw";
    const snapshotPath = writePolicySnapshot(sandboxName, "policy-snapshot-external.yaml");
    const policy = requireSource("../policy/index.js") as typeof import("../policy/index.js");
    vi.mocked(policy.inspectPolicyMutationAuthority).mockReturnValue({
      authority: "externally-managed",
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
      inspection: {
        authority: "externally-managed",
        effectivePolicy: { version: 1, network_policies: {} },
        policyIdentity: { hash: "sha256:external", activeVersion: 1 },
      },
    });

    expect(() => shields.applyShieldsPolicySnapshot(sandboxName, snapshotPath)).toThrow(
      /does not match.*canonical JSON SHA-256 [a-f0-9]{64}; network policy keys: "test"/su,
    );
    expect(runSpy).not.toHaveBeenCalled();

    const matchingExternalAuthority = {
      authority: "externally-managed" as const,
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
      inspection: {
        authority: "externally-managed" as const,
        effectivePolicy: { version: 1, network_policies: { test: {} } },
        policyIdentity: { hash: "sha256:external", activeVersion: 1 },
      },
    };
    vi.mocked(policy.inspectPolicyMutationAuthority).mockReturnValue(matchingExternalAuthority);
    vi.mocked(policy.inspectPolicyRecoveryAuthority)
      .mockReturnValueOnce(matchingExternalAuthority)
      .mockReturnValue({
        ...matchingExternalAuthority,
        authority: "nemoclaw-managed",
        inspection: { ...matchingExternalAuthority.inspection, authority: "nemoclaw-managed" },
      });
    expect(() => shields.applyShieldsPolicySnapshot(sandboxName, snapshotPath)).toThrow(
      /Policy authority changed.*canonical JSON SHA-256 [a-f0-9]{64}.*Stop without applying.*Restore the recorded externally managed authority.*NemoClaw will not change policy authority/su,
    );
  });

  it("never relaxes policy or persists mutable state when the base-policy read fails", () => {
    expect(() => shields.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });

  it.each([
    ["message", "message: gateway unavailable"],
    ["details", "details: grpc unavailable"],
    ["arbitrary diagnostic", "reason: gateway unavailable\nretryable: true"],
  ])("never relaxes policy or persists mutable state for exit-zero %s output", (_name, output) => {
    runCaptureSpy.mockReturnValue(output);

    expect(() => shields.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      "Cannot capture current policy",
    );
    expect(runSpy).not.toHaveBeenCalled();

    const stateFiles = fs.readdirSync(path.join(homeDir, ".nemoclaw", "state"));
    expect(stateFiles.filter((name) => /^(policy-snapshot-|shields-openclaw)/.test(name))).toEqual(
      [],
    );
  });
});

describe("shields down policy rejection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-policy-rejection-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRejectedPolicyHarness() {
    return createShieldsFlowHarness(requireSource, tmpDir, {
      run: (cmd) => ({
        status: Array.isArray(cmd) && cmd.includes("policy") && cmd.includes("set") ? 1 : 0,
      }),
    });
  }

  it("stops Shields down before mutation when policy is externally managed (#9833)", () => {
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      policyAuthorityInspection: externalPolicyAuthorityInspection,
      sandboxEntry: {
        name: "openclaw",
        openshellDriver: "docker",
        policyAuthority: "externally-managed",
      },
    });

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      "externally managed",
    );
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.dockerSpawnCalls).toEqual([]);
  });

  it("pins Shields policy inspection, reads, and writes to the recorded gateway (#9833)", () => {
    const gatewayName = "nemoclaw-18080";
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      confirmOpenClawInodeFlags: true,
      sandboxEntry: {
        name: "openclaw",
        gatewayName,
        gatewayPort: 18080,
        openshellDriver: "docker",
        policyAuthority: "nemoclaw-managed",
      },
    });

    harness.shieldsDown("openclaw", { throwOnError: true });

    expect(harness.policyAuthoritySpy).toHaveBeenCalledWith("openclaw", "lower Shields");
    const policyCommands = [...harness.runCaptureSpy.mock.calls, ...harness.runSpy.mock.calls]
      .map(([command]) => command)
      .filter((command) => Array.isArray(command) && command.includes("policy"));
    expect(policyCommands.length).toBeGreaterThan(0);
    expect(policyCommands.every((command) => command.includes(gatewayName))).toBe(true);
    expect(harness.policyReceiptFinalizeSpy).toHaveBeenCalledWith(
      "openclaw",
      expect.stringContaining("network_policies"),
      expect.objectContaining({ gatewayName }),
    );
  });

  it("keeps `shields status` at `UP` when OpenShell rejects the permissive policy (#8198)", () => {
    const harness = createRejectedPolicyHarness();

    expect(() =>
      harness.shieldsDown("openclaw", {
        reason: "verify",
        throwOnError: true,
      }),
    ).toThrow(/Could not apply/);
    expect(harness.isShieldsDown("openclaw")).toBe(false);

    const state = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".nemoclaw/state/shields-openclaw.json"), "utf-8"),
    );
    expect(state).toMatchObject({ shieldsDown: false, shieldsDownAt: null });
  });

  it("retains auto-restore authority when rejected policy state cleanup fails (#8198)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        shieldsDown: false,
        fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
        updatedAt: "2026-08-05T00:00:00.000Z",
      }),
    );
    const timerKill = vi.fn(() => true);
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      failPolicyRejectionStateClear: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: "test-process-start-identity",
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: timerKill,
      }),
      run: (cmd) => ({
        status: Array.isArray(cmd) && cmd.includes("policy") && cmd.includes("set") ? 1 : 0,
      }),
    });
    expect(() =>
      harness.shieldsDown("openclaw", {
        reason: "verify recovery authority",
        throwOnError: true,
      }),
    ).toThrow(/Could not apply/);

    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      shieldsDown: true,
      shieldsDownReason: "verify recovery authority",
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(true);
    expect(
      fs.readdirSync(stateDir).some((name) => name.startsWith("shields-transition-openclaw-")),
    ).toBe(true);
    const transitionName = fs
      .readdirSync(stateDir)
      .find((name) => name.startsWith("shields-transition-openclaw-"));
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, transitionName!), "utf-8")),
    ).toMatchObject({ phase: "policy_rejected" });
    expect(timerKill).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "The scheduled auto-restore remains authoritative.",
    );

    harness.logSpy.mockClear();
    harness.errorSpy.mockClear();
    harness.shieldsStatus("openclaw", true, {
      verifyLockState: () => ({ ok: true, issues: [] }),
      verifyStateLockPlan: () => [],
      resolveConfig: () => ({
        agentName: "openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
        configDir: "/sandbox/.openclaw",
        configFile: "openclaw.json",
        format: "json",
        stateLockPlanInImage: true,
      }),
    });

    expect(harness.isShieldsDown("openclaw")).toBe(false);
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toMatch(/DOWN|permissive|unlocked/);
  });

  it("denies mutations when rejected policy state and transition updates both fail (#8198)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        shieldsDown: false,
        fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
        updatedAt: "2026-08-05T00:00:00.000Z",
      }),
    );
    const harness = createShieldsFlowHarness(requireSource, tmpDir, {
      failPolicyRejectionStateClear: true,
      failPolicyRejectionTransitionWrite: true,
      initialOpenClawPosture: "locked",
      processStartIdentity: "test-process-start-identity",
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
      run: (cmd) => ({
        status: Array.isArray(cmd) && cmd.includes("policy") && cmd.includes("set") ? 1 : 0,
      }),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        reason: "verify incomplete rejection",
        throwOnError: true,
      }),
    ).toThrow(/Could not apply/);

    const transitionName = fs
      .readdirSync(stateDir)
      .find((name) => name.startsWith("shields-transition-openclaw-"));
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, transitionName!), "utf-8")),
    ).toMatchObject({ phase: "preparing" });
    expect(harness.getShieldsPosture("openclaw", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
    expect(harness.isShieldsDown("openclaw")).toBe(false);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);
    expect(() =>
      harness.shieldsStatus("openclaw", true, {
        verifyLockState: () => ({ ok: true, issues: [] }),
        resolveConfig: () => ({
          agentName: "openclaw",
          configPath: "/sandbox/.openclaw/openclaw.json",
          configDir: "/sandbox/.openclaw",
          configFile: "openclaw.json",
          format: "json",
          stateLockPlanInImage: true,
        }),
      }),
    ).toThrow("process exit 1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "Shields: ERROR (Shields down transition incomplete)",
    );
  });
});

describe("shields config lock without a shipped config hash", () => {
  const CONFIG_DIR = "/sandbox/.deepagents";
  const CONFIG_PATH = `${CONFIG_DIR}/config.toml`;
  const HASH_PATH = `${CONFIG_DIR}/.config-hash`;
  const LOCK_COMMAND_KEY = [CONFIG_DIR, CONFIG_PATH].join("\0");
  const TIMER_PROCESS_KEY = ["number", "4242", "number", "0"].join("\0");

  type SandboxEntry = { mode: string; owner: string };
  type SandboxCommandHandler = (args: string[], command: string[]) => string;

  let homeDir: string;
  let shields: typeof import("./index.js");
  let entries: Map<string, SandboxEntry>;
  let immutablePaths: Set<string>;
  let lockCalls: string[][];
  let unlockCalls: string[][];
  let stateDirGuardActions: string[];
  let applyStateDirLockModeSpy: MockInstance;
  let restoreStateDirLockPostureSpy: MockInstance;
  let resolveAgentConfigSpy: MockInstance;
  let errorSpy: MockInstance;
  let commandHandlers: Map<string, SandboxCommandHandler>;

  function target() {
    return {
      agentName: "langchain-deepagents-code",
      configDir: CONFIG_DIR,
      configFile: "config.toml",
      configPath: CONFIG_PATH,
      format: "toml",
      sensitiveFiles: [HASH_PATH],
      stateLockPlan: {
        version: 1 as const,
        readOnlyRoots: ["skills"],
        confidentialRoots: [],
        readOnlyPrefixes: [],
        confidentialPrefixes: [],
        writableSubpaths: [],
      },
      stateLockPlanInImage: false,
    };
  }

  function missingEntry(pathname: string, operation: string): never {
    throw new Error(`${operation}: cannot access '${pathname}': No such file or directory`);
  }

  function requireEntry(pathname: string, operation: string): SandboxEntry {
    return entries.get(pathname) ?? missingEntry(pathname, operation);
  }

  function unsupportedCommand(command: string[]): never {
    throw new Error(`unsupported sandbox command in fixture: ${command.join(" ")}`);
  }

  function pythonCommandKey(command: string[]): string {
    return command.slice(4, 6).join("\0");
  }

  function runConfigLock(command: string[]): string {
    const hashCreated = !entries.has(HASH_PATH);
    lockCalls.push(command);
    entries.set("/sandbox", { mode: "1775", owner: "root:sandbox" });
    entries.set(CONFIG_DIR, { mode: "755", owner: "root:root" });
    entries.set(CONFIG_PATH, { mode: "444", owner: "root:root" });
    entries.set(HASH_PATH, { mode: "444", owner: "root:root" });
    return hashCreated ? "hash-created" : "hash-existing";
  }

  function runConfigUnlock(command: string[]): string {
    unlockCalls.push(command);
    entries.set("/sandbox", { mode: "755", owner: "sandbox:sandbox" });
    entries.set(CONFIG_DIR, { mode: "2770", owner: "sandbox:sandbox" });
    for (const pathname of command.slice(9)) {
      entries.set(pathname, { mode: "660", owner: "sandbox:sandbox" });
      immutablePaths.delete(pathname);
    }
    return "";
  }

  const exactPythonFixtureHandlers = new Map<string, (command: string[]) => string>([
    [LOCK_COMMAND_KEY, runConfigLock],
  ]);
  const leadingPythonFixtureHandlers = new Map<string, (command: string[]) => string>([
    ["660", runConfigUnlock],
  ]);

  function runPythonFixtureCommand(_args: string[], command: string[]): string {
    const handler =
      exactPythonFixtureHandlers.get(pythonCommandKey(command)) ??
      leadingPythonFixtureHandlers.get(String(command[4])) ??
      unsupportedCommand;
    return handler(command);
  }

  function rejectConfigLock(failure: Error): SandboxCommandHandler {
    const exactHandlers = new Map(exactPythonFixtureHandlers);
    exactHandlers.set(LOCK_COMMAND_KEY, () => {
      throw failure;
    });
    return (_args, command) => {
      const handler =
        exactHandlers.get(pythonCommandKey(command)) ??
        leadingPythonFixtureHandlers.get(String(command[4])) ??
        unsupportedCommand;
      return handler(command);
    };
  }

  function reportTimerProcessMissing(): never {
    const error = new Error("timer is gone") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }

  function reportTimerProcessRunning(): true {
    return true;
  }

  const timerProcessHandlers = new Map<string, () => true>([
    [TIMER_PROCESS_KEY, reportTimerProcessMissing],
  ]);

  function reportMissingTimerProcess(pid: number, signal?: string | number): true {
    const key = [typeof pid, String(pid), typeof signal, String(signal)].join("\0");
    const behavior = timerProcessHandlers.get(key) ?? reportTimerProcessRunning;
    return behavior();
  }

  function makePathImmutable(pathname: string): void {
    immutablePaths.add(pathname);
  }

  function ignoreChattrOperation(_pathname: string): void {}

  const chattrOperationHandlers = new Map<string, (pathname: string) => void>([
    ["+i", makePathImmutable],
  ]);

  function runSandboxCommand(cmd: string[]): string {
    const [head, ...rest] = cmd;
    const handler = commandHandlers.get(head) ?? unsupportedCommand(cmd);
    return handler(rest, cmd);
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-config-lock-"));
    vi.stubEnv("HOME", homeDir);
    lockCalls = [];
    unlockCalls = [];
    stateDirGuardActions = [];
    immutablePaths = new Set<string>();
    entries = new Map<string, SandboxEntry>([
      ["/sandbox", { mode: "1775", owner: "root:sandbox" }],
      [CONFIG_DIR, { mode: "2770", owner: "sandbox:sandbox" }],
      [CONFIG_PATH, { mode: "660", owner: "sandbox:sandbox" }],
    ]);
    commandHandlers = new Map<string, SandboxCommandHandler>([
      ["python3", runPythonFixtureCommand],
      [
        "chmod",
        ([mode, pathname]) => {
          const entry = requireEntry(pathname, "chmod");
          const applyMode =
            new Map<string, () => void>([["g-s", () => undefined]]).get(mode) ??
            (() => {
              entry.mode = mode;
            });
          applyMode();
          return "";
        },
      ],
      [
        "chown",
        ([owner, pathname]) => {
          requireEntry(pathname, "chown").owner = owner;
          return "";
        },
      ],
      [
        "chattr",
        ([operation], command) => {
          const pathname = String(command.at(-1));
          requireEntry(pathname, "chattr");
          const applyOperation = chattrOperationHandlers.get(operation) ?? ignoreChattrOperation;
          applyOperation(pathname);
          return "";
        },
      ],
      [
        "lsattr",
        (_args, command) => {
          const pathname = String(command.at(-1));
          requireEntry(pathname, "lsattr");
          const flags = immutablePaths.has(pathname) ? "----i---------" : "--------------";
          return flags + " " + pathname;
        },
      ],
      [
        "stat",
        (_args, command) => {
          const pathname = String(command.at(-1));
          const entry = requireEntry(pathname, "stat");
          return `${entry.mode} ${entry.owner}`;
        },
      ],
      [
        "sha256sum",
        (_args, command) => {
          const pathname = String(command.at(-1));
          requireEntry(pathname, "sha256sum");
          return `${"a".repeat(64)}  ${pathname}`;
        },
      ],
      ["sh", () => ""],
    ]);
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];

    const runner = requireSource("../runner.js");
    const agentConfig = requireSource("../sandbox/agent-config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");
    const stateDirGuardCommandHandlers = new Map<string, () => void>([
      ["test", () => undefined],
      [
        "preflight",
        () => {
          stateDirGuardActions.push("preflight");
        },
      ],
      [
        "lock",
        () => {
          stateDirGuardActions.push("lock");
          entries.set(CONFIG_DIR, { mode: "755", owner: "root:root" });
        },
      ],
      [
        "unlock",
        () => {
          stateDirGuardActions.push("unlock");
        },
      ],
    ]);

    vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
    vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    vi.spyOn(runner, "runCapture").mockReturnValue("");
    resolveAgentConfigSpy = vi
      .spyOn(agentConfig, "resolveAgentConfig")
      .mockImplementation(() => target());
    vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
      (_sandboxName: unknown, cmd: unknown) => cmd as string[],
    );
    vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((cmd: unknown) =>
      runSandboxCommand(cmd as string[]),
    );
    vi.spyOn(dockerExec, "dockerSpawnSync").mockImplementation((rawCommand: unknown) => {
      const command = Array.isArray(rawCommand) ? rawCommand.map(String) : [];
      const action = (["preflight", "lock", "unlock"] as const).find((candidate) =>
        command.includes(candidate),
      );
      const handler =
        stateDirGuardCommandHandlers.get(String(action ?? command[0])) ??
        (() => unsupportedCommand(command));
      handler();

      return {
        status: 0,
        signal: null,
        stdout:
          action === undefined
            ? ""
            : `${JSON.stringify({
                type: "result",
                action,
                status: "ok",
                issueCount: 0,
              })}\n`,
        stderr: "",
        pid: 0,
        output: [],
      } as never;
    });
    vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]);
    applyStateDirLockModeSpy = vi.spyOn(stateDirLock, "applyStateDirLockMode").mockReturnValue([]);
    restoreStateDirLockPostureSpy = vi.spyOn(stateDirLock, "restoreStateDirLockPosture");
    mockManagedPolicyAuthority("dcode-safety");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    shields = requireSource(SHIELDS_MODULE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve(TRANSITION_LOCK_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("fresh-seals an absent record before locking recursive state (#7977)", () => {
    const result = shields.lockAgentConfig("dcode-safety", target(), false);

    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].slice(4)).toEqual([CONFIG_DIR, CONFIG_PATH, "--fail-closed-on-error"]);
    expect(entries.get(CONFIG_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(entries.get(HASH_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(Object.keys(result.fileHashes)).toEqual([CONFIG_PATH, HASH_PATH]);
  });

  it.each([
    [
      "config-root",
      "  CRITICAL: Deep Agents lock failed after containment began. NemoClaw confirmed fail-closed containment at the config root. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=config-root",
    ],
    [
      "sandbox-parent",
      "  CRITICAL: Deep Agents lock failed after containment began. NemoClaw confirmed fail-closed containment at the sandbox parent because NemoClaw could not confirm the complete config-root posture. In-sandbox recovery is unavailable. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=sandbox-parent",
    ],
    [
      "incomplete",
      "  CRITICAL: Deep Agents lock failed after containment began, and NemoClaw could not confirm fail-closed containment. Do not retry or repair from inside the sandbox. Restore this sandbox from a trusted snapshot or recreate it before retrying. fail-closed containment=incomplete",
    ],
    [
      "rollback-failed",
      "  CRITICAL: Deep Agents config lock transaction could not restore its original posture. Restore this sandbox from a trusted snapshot or recreate it before retrying. rollback failed",
    ],
  ] as const)(
    "maps the anchored %s child protocol to exact bounded guidance (#7995)",
    (status, expectedGuidance) => {
      const stderr =
        status === "sandbox-parent"
          ? Buffer.from(lockFailure(status), "utf8")
          : lockFailure(status);
      commandHandlers.set(
        "python3",
        rejectConfigLock(
          sandboxCommandFailure(
            stderr,
            `hostile argv marker ${lockFailure("incomplete")}`,
            lockFailure("config-root"),
          ),
        ),
      );

      expect(() => shields.lockAgentConfig("dcode-safety", target(), false)).toThrow(
        DEEP_AGENTS_LOCK_GENERIC_ERROR,
      );
      expect(errorSpy).toHaveBeenCalledWith(expectedGuidance);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts transaction-failed without inventing a containment or rollback claim (#7995)", () => {
    commandHandlers.set(
      "python3",
      rejectConfigLock(sandboxCommandFailure(lockFailure("transaction-failed"))),
    );

    expect(() => shields.lockAgentConfig("dcode-safety", target(), false)).toThrow(
      DEEP_AGENTS_LOCK_GENERIC_ERROR,
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
  });

  it("ignores markers in Error.message, stdout, unanchored stderr, and oversized stderr (#7995)", () => {
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = requireSource(
      "./seal.js",
    ) as typeof import("./seal.js");
    const hostileMessage = `python3 -I -c ${DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT} ${lockFailure("config-root")}`;
    const failures = [
      sandboxCommandFailure(undefined, hostileMessage),
      sandboxCommandFailure(undefined, "transport failed", lockFailure("config-root")),
      sandboxCommandFailure(`untrusted preface ${lockFailure("config-root")}`, "transport failed"),
      sandboxCommandFailure(
        `${lockFailure("config-root")}untrusted trailing stderr`,
        "transport failed",
      ),
      sandboxCommandFailure(`${"x".repeat(100_000)}${lockFailure("config-root")}`, hostileMessage),
    ];

    failures.forEach((failure) => {
      errorSpy.mockClear();
      commandHandlers.set("python3", rejectConfigLock(failure));

      let caught: unknown;
      try {
        shields.lockAgentConfig("dcode-safety", target(), false);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(DEEP_AGENTS_LOCK_GENERIC_ERROR);
      expect((caught as Error).message.length).toBeLessThan(128);
      expect((caught as Error).message).not.toContain("python3");
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
    });
  });

  it("keeps the fresh seal when a nested entry blocks recursive containment (#7977)", () => {
    applyStateDirLockModeSpy.mockReturnValueOnce(["injected recursive lock failure"]);

    expect(() => shields.lockAgentConfig("dcode-safety", target(), false)).toThrow(
      /injected recursive lock failure/,
    );

    expect(unlockCalls).toHaveLength(0);
    expect(restoreStateDirLockPostureSpy).not.toHaveBeenCalled();
    expect(entries.get("/sandbox")).toEqual({ mode: "1775", owner: "root:sandbox" });
    expect(entries.get(CONFIG_DIR)).toEqual({ mode: "755", owner: "root:root" });
    expect(entries.get(CONFIG_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(entries.get(HASH_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
  });

  it("restores and verifies the prior locked posture after a downstream failure (#7977)", () => {
    entries.set(CONFIG_DIR, { mode: "755", owner: "root:root" });
    entries.set(CONFIG_PATH, { mode: "444", owner: "root:root" });
    entries.set(HASH_PATH, { mode: "444", owner: "root:root" });
    applyStateDirLockModeSpy.mockImplementationOnce(() => {
      entries.set(CONFIG_DIR, { mode: "500", owner: "root:root" });
      return ["injected recursive lock failure"];
    });

    expect(() => shields.lockAgentConfig("dcode-safety", target(), true)).toThrow(
      /injected recursive lock failure/,
    );

    expect(lockCalls[0].slice(4)).toEqual([CONFIG_DIR, CONFIG_PATH]);
    expect(unlockCalls).toHaveLength(0);
    expect(restoreStateDirLockPostureSpy).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG_DIR,
      true,
      target().stateLockPlan,
      false,
    );
    expect(stateDirGuardActions).toEqual(["preflight", "lock"]);
    expect(entries.get(CONFIG_DIR)).toEqual({ mode: "755", owner: "root:root" });
    expect(entries.get(CONFIG_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(entries.get(HASH_PATH)).toEqual({ mode: "444", owner: "root:root" });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
  });

  it.each([
    [
      "is unavailable",
      () => {
        throw new Error("registry unavailable");
      },
    ],
    [
      "falls back to a changed OpenClaw target",
      () => ({
        agentName: "openclaw",
        configDir: "/sandbox/.openclaw",
        configFile: "openclaw.json",
        configPath: "/sandbox/.openclaw/openclaw.json",
        format: "json",
      }),
    ],
  ])(
    "pins expired inline recovery to Deep Agents when the registry %s (#7995)",
    (_scenario, resolveTarget) => {
      const sandboxName = "dcode-safety";
      const stateDir = path.join(homeDir, ".nemoclaw", "state");
      const snapshotPath = path.join(stateDir, "policy-snapshot-inline-recovery.yaml");
      const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, `shields-${sandboxName}.json`),
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
          shieldsDownTimeout: 60,
          shieldsDownReason: "identity coverage",
          shieldsDownPolicy: "permissive",
          shieldsPolicySnapshotPath: snapshotPath,
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          pid: 4242,
          sandboxName,
          snapshotPath,
          restoreAt: new Date(Date.now() - 30_000).toISOString(),
          processToken: "7".repeat(32),
          agentName: "langchain-deepagents-code",
          configPath: CONFIG_PATH,
          configDir: CONFIG_DIR,
        }),
        { mode: 0o600 },
      );
      vi.spyOn(process, "kill").mockImplementation(reportMissingTimerProcess);
      resolveAgentConfigSpy.mockImplementation(resolveTarget);

      const posture = shields.getShieldsPosture(sandboxName, true);
      const state = JSON.parse(
        fs.readFileSync(path.join(stateDir, `shields-${sandboxName}.json`), "utf-8"),
      );

      expect(posture.mode).toBe("locked");
      expect(lockCalls).toHaveLength(2);
      expect(lockCalls.every((command) => command[4] === CONFIG_DIR)).toBe(true);
      expect(lockCalls.every((command) => command[5] === CONFIG_PATH)).toBe(true);
      expect(Object.keys(state.fileHashes)).toEqual([CONFIG_PATH, HASH_PATH]);
      expect(fs.existsSync(markerPath)).toBe(false);
    },
  );

  it("restores the managed sandbox parent when the config is unlocked", () => {
    entries.set(CONFIG_DIR, { mode: "755", owner: "root:root" });
    entries.set(CONFIG_PATH, { mode: "444", owner: "root:root" });
    entries.set(HASH_PATH, { mode: "444", owner: "root:root" });
    commandHandlers.set("python3", (_args, command) => {
      expect(command.slice(4, 9)).toEqual(["660", "2770", "sandbox:sandbox", "1", CONFIG_DIR]);
      entries.set("/sandbox", { mode: "755", owner: "sandbox:sandbox" });
      entries.set(CONFIG_DIR, { mode: "2770", owner: "sandbox:sandbox" });
      entries.set(CONFIG_PATH, { mode: "660", owner: "sandbox:sandbox" });
      entries.set(HASH_PATH, { mode: "660", owner: "sandbox:sandbox" });
      return "";
    });
    commandHandlers.set("lsattr", () => "----------------------");

    shields.unlockAgentConfig("dcode-safety", target(), true);

    expect(entries.get("/sandbox")).toEqual({ mode: "755", owner: "sandbox:sandbox" });
    expect(entries.get(CONFIG_DIR)).toEqual({ mode: "2770", owner: "sandbox:sandbox" });
  });
});

describe("managed MCP policy deadline restoration (#7952)", () => {
  let homeDir: string;

  function createRestoreHarness() {
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve("./permissive-runtime.js")];
    delete require.cache[requireSource.resolve("../actions/sandbox/mcp-bridge-policy.js")];

    const runner = requireSource("../runner.js") as typeof import("../runner.js");
    const policy = requireSource("../policy/index.js") as typeof import("../policy/index.js");
    const registry = requireSource("../state/registry.js") as typeof import("../state/registry.js");
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../adapters/openshell/policy-authority.js");
    const policySetBodies: string[] = [];

    vi.spyOn(runner, "runCapture").mockReturnValue(
      "version: 1\nnetwork_policies:\n  live_baseline: {}\n",
    );
    vi.spyOn(runner, "run").mockReturnValue({ status: 0 } as never);
    vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
    vi.spyOn(policy, "buildPolicySetCommand").mockImplementation((file: unknown) => {
      policySetBodies.push(fs.readFileSync(String(file), "utf-8"));
      return ["openshell", "policy", "set"];
    });
    vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "openclaw",
      openshellDriver: "docker",
      policyAuthority: "nemoclaw-managed",
    });
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "nemoclaw-managed",
      effectivePolicy: { version: 1, network_policies: {} },
      policyIdentity: { hash: "sha256:managed", activeVersion: 1 },
    });
    const authorityReceipt = {
      authority: "nemoclaw-managed" as const,
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
      inspection: {
        authority: "nemoclaw-managed" as const,
        effectivePolicy: { version: 1, network_policies: {} },
        policyIdentity: { hash: "sha256:managed", activeVersion: 1 },
      },
    };
    vi.spyOn(policy, "inspectPolicyMutationAuthority").mockReturnValue(authorityReceipt);
    vi.spyOn(policy, "recheckPolicyMutationAuthority").mockReturnValue(authorityReceipt);
    vi.spyOn(policy, "finalizePolicyMutationReceipt").mockImplementation(() => undefined);

    const shields = requireSource(SHIELDS_MODULE) as typeof import("./index.js");
    return { applyShieldsPolicySnapshot: shields.applyShieldsPolicySnapshot, policySetBodies };
  }

  function writeCurrentProcessTimerMarker(snapshotPath: string, processToken: string): void {
    fs.writeFileSync(
      path.join(homeDir, ".nemoclaw", "state", "shields-timer-openclaw.json"),
      JSON.stringify({
        pid: process.pid,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
      }),
      { mode: 0o600 },
    );
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-mcp-deadline-flow-"));
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve("./permissive-runtime.js")];
    delete require.cache[requireSource.resolve("../actions/sandbox/mcp-bridge-policy.js")];
  });

  it("restores lockdown with malformed and duplicate ownership", () => {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const processToken = "a".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-malformed-deadline.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      YAML.stringify({
        version: 1,
        network_policies: {
          restrictive_baseline: {},
          mcp_bridge_: {},
          mcp_bridge_alpha: {},
        },
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsManagedMcpPolicyKeys: ["mcp_bridge_", "mcp_bridge_alpha", "mcp_bridge_alpha"],
      }),
    );
    writeCurrentProcessTimerMarker(snapshotPath, processToken);
    const harness = createRestoreHarness();

    const result = harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
      transitionProcessToken: processToken,
      deadlineAuthoritative: true,
    });

    expect(result.status).toBe(0);
    expect(result.managedMcpOmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "mcp_bridge_",
          reason: expect.stringMatching(/ownership key.*invalid/),
        }),
        expect.objectContaining({
          key: "mcp_bridge_alpha",
          reason: expect.stringMatching(/more than once/),
        }),
      ]),
    );
    expect(YAML.parse(harness.policySetBodies.at(-1)!).network_policies).toEqual({
      restrictive_baseline: {},
    });
  });

  it("restores lockdown when transition and persisted ownership differ", () => {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const processToken = "b".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-mismatched-deadline.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      YAML.stringify({
        version: 1,
        network_policies: {
          restrictive_baseline: {},
          mcp_bridge_alpha: {},
          mcp_bridge_beta: {},
        },
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        shieldsManagedMcpPolicyKeys: ["mcp_bridge_alpha"],
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-transition-openclaw-${processToken}.json`),
      JSON.stringify({
        version: 1,
        phase: "active",
        ownerPid: process.pid,
        ownerStartIdentity: "test-owner",
        processToken,
        sandboxName: "openclaw",
        snapshotPath,
        managedMcpPolicyKeys: ["mcp_bridge_beta"],
      }),
      { mode: 0o600 },
    );
    writeCurrentProcessTimerMarker(snapshotPath, processToken);
    const harness = createRestoreHarness();

    const result = harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
      transitionProcessToken: processToken,
      deadlineAuthoritative: true,
    });

    expect(result.status).toBe(0);
    expect(result.managedMcpOmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringMatching(/did not match persisted policy ownership/),
        }),
      ]),
    );
    expect(YAML.parse(harness.policySetBodies.at(-1)!).network_policies).toEqual({
      restrictive_baseline: {},
    });
  });

  it("restores lockdown from a legacy snapshot without ownership metadata", () => {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const processToken = "c".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-legacy-deadline.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      YAML.stringify({
        version: 1,
        network_policies: { restrictive_baseline: {}, mcp_bridge_alpha: {} },
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath }),
    );
    writeCurrentProcessTimerMarker(snapshotPath, processToken);
    const harness = createRestoreHarness();

    const result = harness.applyShieldsPolicySnapshot("openclaw", snapshotPath, {
      transitionProcessToken: processToken,
      deadlineAuthoritative: true,
    });

    expect(result.status).toBe(0);
    expect(result.managedMcpOmissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringMatching(/no managed MCP ownership/) }),
        expect.objectContaining({ key: "mcp_bridge_alpha" }),
      ]),
    );
    expect(YAML.parse(harness.policySetBodies.at(-1)!).network_policies).toEqual({
      restrictive_baseline: {},
    });
  });
});

function removeWithInjectedStateRestoreFailure(
  originalRmSync: typeof fs.rmSync,
  statePath: string,
): typeof fs.rmSync {
  return ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    switch (String(target)) {
      case statePath:
        throw new Error("injected state restoration failure");
      default:
        return originalRmSync(target, options);
    }
  }) as typeof fs.rmSync;
}

describe("shields-down rollback flow", () => {
  let tmpDir: string;

  function createHarness(options: ShieldsFlowHarnessOptions = {}) {
    return createShieldsFlowHarness(requireSource, tmpDir, options);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-rollback-flow-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireSource.resolve(SHIELDS_MODULE)];
    delete require.cache[requireSource.resolve("./timer-bound-lock.js")];
    delete require.cache[requireSource.resolve("./transition-lock.js")];
    delete require.cache[requireSource.resolve("./permissive-runtime.js")];
    delete require.cache[requireSource.resolve("../actions/sandbox/mcp-bridge-policy.js")];
    delete require.cache[requireSource.resolve("../cli/branding.js")];
  });

  it("rejects shields-down before mutation when stale timer authority remains", () => {
    const fork = vi.fn(() => ({
      pid: 4242,
      disconnect: vi.fn(),
      unref: vi.fn(),
      send: vi.fn(() => true),
      kill: vi.fn(() => true),
    }));
    const harness = createHarness({
      fork,
      initialOpenClawPosture: "locked",
      timerAuthorityRevokedSequence: [false],
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "stale timer coverage",
        throwOnError: true,
      }),
    ).toThrow("Cannot revoke stale auto-restore timer authority for openclaw");

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.runCaptureSpy).not.toHaveBeenCalled();
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json"))).toBe(
      false,
    );
    expect(harness.errorSpy.mock.calls.flat().map(String).join("\n")).toContain(
      "Failed to remove shields timer marker: permission denied",
    );
  });

  it("restores fresh mutable-default state when the timer handoff fails", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const harness = createHarness({
      timerDiesAfterUnlock: true,
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "rollback coverage",
        throwOnError: true,
      }),
    ).toThrow(/live future auto-restore timer authority/u);

    expect(fs.existsSync(path.join(stateDir, "shields-openclaw.json"))).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("mutable");
    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Original mutable-default posture restored");
    expect(output).toContain(
      "Auto-restore handoff failed; the original mutable-default posture was restored",
    );
    expect(output).not.toMatch(/lockdown (?:was )?restored/i);
    expect(output).not.toContain("scheduled auto-restore remains authoritative");
  });

  it("fails closed when mutable-default rollback cannot revoke timer authority", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const harness = createHarness({
      confirmOpenClawInodeFlags: true,
      timerDiesAfterUnlock: true,
      timerAuthorityRevokedSequence: [true, false],
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "timer authority coverage",
        throwOnError: true,
      }),
    ).toThrow(/live future auto-restore timer authority/u);

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: false });
    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("Cannot revoke auto-restore timer authority");
    expect(output).toContain(
      "Fail-closed lockdown applied; the original mutable-default posture was not restored",
    );
    expect(output).not.toContain("Original mutable-default posture restored");
  });

  it("reports revoked timer authority when state restoration falls back to lockdown (#7538)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    const originalRmSync = fs.rmSync.bind(fs);
    const harness = createHarness({
      confirmOpenClawInodeFlags: true,
      timerDiesAfterUnlock: true,
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });
    vi.spyOn(fs, "rmSync").mockImplementation(
      removeWithInjectedStateRestoreFailure(originalRmSync, statePath),
    );

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "state restoration coverage",
        throwOnError: true,
      }),
    ).toThrow(/live future auto-restore timer authority/u);

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({ shieldsDown: false });
    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "Auto-restore handoff failed; lockdown was restored. Auto-restore timer authority was revoked.",
    );
    expect(output).not.toContain("scheduled auto-restore remains authoritative");
  });

  it("requires manual recovery after state restoration and re-lock fail with timer revoked (#7538)", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    const originalRmSync = fs.rmSync.bind(fs);
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      timerDiesAfterUnlock: true,
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => true),
        kill: vi.fn(() => true),
      }),
    });
    vi.spyOn(fs, "rmSync").mockImplementation(
      removeWithInjectedStateRestoreFailure(originalRmSync, statePath),
    );

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "manual recovery coverage",
        throwOnError: true,
      }),
    ).toThrow(/live future auto-restore timer authority/u);

    expect(harness.getOpenClawPosture()).toBe("mutable");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({ shieldsDown: true });
    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "Auto-restore handoff failed; rollback is incomplete. Auto-restore timer authority was revoked. Manual intervention is required.",
    );
    expect(output).not.toContain("scheduled auto-restore remains authoritative");
  });

  it("rejects corrupt state before weakening an initially locked config", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    const corruptState = Buffer.from([
      0xff, 0xfe, 0x7b, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x73, 0x6f, 0x6e,
    ]);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, corruptState);
    const harness = createHarness({ initialOpenClawPosture: "locked" });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "corrupt fail-closed coverage",
        throwOnError: true,
      }),
    ).toThrow("Shields state is corrupt for openclaw");

    expect(fs.readFileSync(statePath)).toEqual(corruptState);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.runCaptureSpy).not.toHaveBeenCalled();
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("reports fail-closed lockdown when mutable-default rollback cannot be verified", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["unlock"],
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        switch (true) {
          case args.includes("sha256sum"):
            return `${"a".repeat(64)}  ${String(args.at(-1))}\n`;
          case args.includes("lsattr"):
            return `----i---------e----- ${String(args.at(-1))}\n`;
          case args.includes("stat"):
            return args.at(-1) === "/sandbox"
              ? "1775 root:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? "755 root:root\n"
                : "444 root:root\n";
          default:
            return "";
        }
      },
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "containment coverage",
        throwOnError: true,
      }),
    ).toThrow(/startup-not-ready/);

    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toMatchObject({
      shieldsDown: false,
    });
    expect(harness.getOpenClawPosture()).toBe("locked");
    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain("applying fail-closed lockdown");
    expect(output).toContain(
      "Fail-closed lockdown applied; the original mutable-default posture was not restored",
    );
    expect(output).toContain(
      "Config did not reach the mutable-default state; fail-closed lockdown was restored",
    );
    expect(output).not.toContain("scheduled auto-restore remains authoritative");
  });
});
