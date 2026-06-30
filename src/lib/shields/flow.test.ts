// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const shieldsModulePath = "./index.js";
const HUNG_FORWARD_OWNER_SOURCE = `
const { spawn } = require("node:child_process");
const childScriptPath = process.argv[2];
const sentinelPath = process.argv[3];
spawn(process.execPath, [childScriptPath, sentinelPath], { stdio: "ignore" });
setTimeout(() => {}, 5000);
`;
const LATE_WEAKENING_CHILD_SOURCE = `
const fs = require("node:fs");
const sentinelPath = process.argv[2];
setTimeout(() => fs.writeFileSync(sentinelPath, "ran"), 1200);
setTimeout(() => {}, 5000);
`;

type ShieldsHarness = {
  auditSpy: MockInstance;
  logSpy: MockInstance;
  runSpy: MockInstance;
  shieldsDown: typeof import("./index.js").shieldsDown;
  shieldsStatus: typeof import("./index.js").shieldsStatus;
  shieldsUp: typeof import("./index.js").shieldsUp;
  isShieldsDown: typeof import("./index.js").isShieldsDown;
  synchronizeAutoRestoreWithShieldsDown: typeof import("./index.js").synchronizeAutoRestoreWithShieldsDown;
};

let tmpDir: string;

type HarnessOptions = {
  dockerExecFileSync?: (argv: unknown) => string;
  fork?: () => {
    pid: number;
    disconnect: () => void;
    unref: () => void;
    send: () => boolean;
    kill: () => boolean;
  };
  run?: (cmd: unknown) => { status: number };
};

function createHarness(options: HarnessOptions = {}): ShieldsHarness {
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
  delete require.cache[requireDist.resolve("./transition-lock.js")];
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const runner = requireDist("../runner.js");
  const policy = requireDist("../policy/index.js");
  const sandboxConfig = requireDist("../sandbox/config.js");
  const registry = requireDist("../state/registry.js");
  const privilegedExec = requireDist("../sandbox/privileged-exec.js");
  const dockerExec = requireDist("../adapters/docker/exec.js");
  const audit = requireDist("./audit.js");
  const childProcess = requireDist("node:child_process");
  let openClawPosture: "locked" | "mutable" = "mutable";

  vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
  vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies:\n  test: {}\n");
  const runSpy = vi.spyOn(runner, "run").mockImplementation((cmd: unknown) => {
    return options.run ? options.run(cmd) : { status: 0 };
  });
  options.fork && vi.spyOn(childProcess, "fork").mockImplementation(options.fork);
  vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
  vi.spyOn(policy, "buildPolicySetCommand").mockReturnValue(["openshell", "policy", "set"]);
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue({
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "openclaw", openshellDriver: "docker" });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [{ name: "openclaw" }] });
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) => [
      "exec",
      "--user",
      "root",
      "openshell-openclaw",
      ...(Array.isArray(cmd) ? cmd.map(String) : []),
    ],
  );
  vi.spyOn(dockerExec, "dockerSpawnSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const action = ["preflight", "lock", "unlock"].find((candidate) => args.includes(candidate));
    const openClawGuard = args.some((arg) => arg.endsWith("openclaw-config-guard.py"));
    openClawPosture =
      openClawGuard && action === "lock"
        ? "locked"
        : openClawGuard && action === "unlock"
          ? "mutable"
          : openClawPosture;
    return {
      status: 0,
      signal: null,
      stdout: action
        ? `${JSON.stringify({
            type: "result",
            action,
            status: "ok",
            ...(openClawGuard
              ? {
                  configDir: "/sandbox/.openclaw",
                  files: ["openclaw.json", ".config-hash"],
                  chattrApplied: action === "lock",
                }
              : { issueCount: 0 }),
          })}\n`
        : "",
      stderr: "",
      pid: 0,
      output: [],
    } as never;
  });
  vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    return options.dockerExecFileSync
      ? options.dockerExecFileSync(argv)
      : args.includes("sha256sum")
        ? "a".repeat(64) + "  /sandbox/.openclaw/openclaw.json\n"
        : args.includes("stat")
          ? args.at(-1) === "/sandbox"
            ? openClawPosture === "locked"
              ? "1775 root:sandbox\n"
              : "755 sandbox:sandbox\n"
            : args.at(-1) === "/sandbox/.openclaw"
              ? openClawPosture === "locked"
                ? "755 root:root\n"
                : "2770 sandbox:sandbox\n"
              : openClawPosture === "locked"
                ? "444 root:root\n"
                : "660 sandbox:sandbox\n"
          : "";
  });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);

  const shields = requireDist(shieldsModulePath);
  logSpy.mockClear();
  auditSpy.mockClear();
  return {
    auditSpy,
    logSpy,
    runSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
    synchronizeAutoRestoreWithShieldsDown: shields.synchronizeAutoRestoreWithShieldsDown,
  };
}

describe("shields command flow", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-flow-"));
    vi.stubEnv("HOME", tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireDist.resolve(shieldsModulePath)];
    delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
    delete require.cache[requireDist.resolve("./transition-lock.js")];
  });

  it("shieldsDown captures policy, unlocks config, saves state, and skips timer on request", () => {
    const harness = createHarness();

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "coverage",
      skipTimer: true,
      throwOnError: true,
    });

    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(state).toMatchObject({
      shieldsDown: true,
      shieldsDownTimeout: 300,
      shieldsDownReason: "coverage",
      shieldsDownPolicy: "permissive",
    });
    expect(fs.existsSync(state.shieldsPolicySnapshotPath)).toBe(true);
    expect(harness.isShieldsDown("openclaw")).toBe(true);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Config unlocked for openclaw (no auto-lockdown timer",
    );
  });

  it("binds manual shields-up to the active auto-restore timer generation", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const sandboxName = "openclaw";
    const processToken = "9".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-manual-up.yaml");
    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "manual-up-token-test",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: 999_999,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
      }),
    );

    let observedOwner: Record<string, unknown> | null = null;
    const harness = createHarness({
      run: () => {
        observedOwner = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        return { status: 0 };
      },
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
    harness.shieldsUp(sandboxName, { throwOnError: true });

    expect(observedOwner).toMatchObject({
      sandboxName,
      command: "shields up",
      takeoverToken: processToken,
    });
  });

  it("never selects the detached recovery timer or its children for owner-tree takeover", () => {
    const shields = requireDist(shieldsModulePath) as {
      excludeRecoveryProcessTree: (
        descendants: Array<{ pid: number; startIdentity: string; depth: number }>,
        recoveryPid: number,
        recoveryDescendants: Array<{ pid: number; startIdentity: string; depth: number }>,
      ) => Array<{ pid: number; startIdentity: string; depth: number }>;
    };
    const recovery = { pid: 200, startIdentity: "timer", depth: 1 };
    const recoveryChild = { pid: 201, startIdentity: "timer-child", depth: 2 };
    const weakeningChild = { pid: 300, startIdentity: "policy-set", depth: 1 };

    expect(
      shields.excludeRecoveryProcessTree([recovery, recoveryChild, weakeningChild], recovery.pid, [
        recoveryChild,
      ]),
    ).toEqual([weakeningChild]);
  });

  it("auto-restore waits for the forward shields-down commit before reclaiming policy", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "openclaw";
    const processToken = "a".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-race.yaml");
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 1_000).toISOString(),
        processToken,
      }),
    );

    const owner = spawn(
      process.execPath,
      [
        "-e",
        [
          "const fs=require('fs')",
          "const p=process.argv[1]",
          "setTimeout(()=>{",
          " const v=JSON.parse(fs.readFileSync(p,'utf8'))",
          " const t=p+'.child.tmp'",
          " fs.writeFileSync(t,JSON.stringify({...v,phase:'active'}),{mode:0o600})",
          " fs.renameSync(t,p)",
          "},150)",
          "setTimeout(()=>{},1000)",
        ].join(";"),
        transitionPath,
      ],
      { stdio: "ignore" },
    );
    expect(owner.pid).toBeTypeOf("number");
    const timerControl = requireDist("./timer-control.js");
    const ownerStartIdentity = timerControl.readProcessStartIdentity(owner.pid);
    expect(ownerStartIdentity).toBeTypeOf("string");
    fs.writeFileSync(
      transitionPath,
      JSON.stringify({
        version: 1,
        phase: "preparing",
        ownerPid: owner.pid,
        ownerStartIdentity,
        processToken,
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );

    const startedAt = Date.now();
    try {
      harness.synchronizeAutoRestoreWithShieldsDown(sandboxName);
    } finally {
      owner.kill("SIGTERM");
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(fs.existsSync(transitionPath)).toBe(false);
    expect(harness.runSpy).toHaveBeenCalledWith(
      ["openshell", "policy", "set"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preempts a hung forward owner and its weakening subprocess before restoring", async () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "openclaw";
    const processToken = "b".repeat(32);
    const snapshotPath = path.join(stateDir, "policy-snapshot-hung.yaml");
    const sentinelPath = path.join(stateDir, "late-weakening-child-ran");
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    const ownerScriptPath = path.join(stateDir, "hung-forward-owner.cjs");
    const childScriptPath = path.join(stateDir, "late-weakening-child.cjs");
    fs.writeFileSync(ownerScriptPath, HUNG_FORWARD_OWNER_SOURCE, { mode: 0o600 });
    fs.writeFileSync(childScriptPath, LATE_WEAKENING_CHILD_SOURCE, { mode: 0o600 });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, `shields-timer-${sandboxName}.json`),
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 1_000).toISOString(),
        processToken,
      }),
    );

    const owner = spawn(process.execPath, [ownerScriptPath, childScriptPath, sentinelPath], {
      stdio: "ignore",
    });
    expect(owner.pid).toBeTypeOf("number");
    const timerControl = requireDist("./timer-control.js");
    const ownerStartIdentity = timerControl.readProcessStartIdentity(owner.pid);
    expect(ownerStartIdentity).toBeTypeOf("string");
    fs.writeFileSync(
      transitionPath,
      JSON.stringify({
        version: 1,
        phase: "preparing",
        ownerPid: owner.pid,
        ownerStartIdentity,
        processToken,
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );

    try {
      harness.synchronizeAutoRestoreWithShieldsDown(sandboxName);
      await new Promise((resolve) => setTimeout(resolve, 1400));
    } finally {
      owner.kill("SIGKILL");
    }

    expect(fs.existsSync(sentinelPath)).toBe(false);
    expect(fs.existsSync(transitionPath)).toBe(false);
    expect(harness.runSpy).toHaveBeenCalledWith(
      ["openshell", "policy", "set"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("preempts timer-token config and inference mutations at the restore deadline", async () => {
    const shields = requireDist(shieldsModulePath) as {
      prepareAutoRestoreTransitionTakeover: (
        sandboxName: string,
        processToken: string,
        snapshotPath: string,
      ) => void;
    };
    const transitionLockPath = path.join(import.meta.dirname, "transition-lock.ts");
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    for (const [index, command] of ["config set write", "inference set"].entries()) {
      const sandboxName = `deadline-${String(index)}`;
      const processToken = String(index + 1).repeat(32);
      const readyPath = path.join(stateDir, `${sandboxName}.ready`);
      const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
      const owner = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          [
            `const {withShieldsTransitionLock}=require(${JSON.stringify(transitionLockPath)})`,
            "const fs=require('fs')",
            "const [name,command,token,ready]=process.argv.slice(1)",
            "withShieldsTransitionLock(name,command,()=>{fs.writeFileSync(ready,'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000)},{takeoverToken:token})",
          ].join(";"),
          sandboxName,
          command,
          processToken,
          readyPath,
        ],
        { env: { ...process.env, HOME: tmpDir }, stdio: "ignore" },
      );

      try {
        const deadline = Date.now() + 5_000;
        while ((!fs.existsSync(readyPath) || !fs.existsSync(lockPath)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fs.existsSync(readyPath)).toBe(true);
        expect(fs.existsSync(lockPath)).toBe(true);

        shields.prepareAutoRestoreTransitionTakeover(
          sandboxName,
          processToken,
          path.join(stateDir, `${sandboxName}.snapshot.yaml`),
        );

        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        owner.kill("SIGKILL");
      }
    }
  });

  it("publishes preparing recovery ownership before weakening and active only after unlock", () => {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    let observedPreparingDuringPolicy = false;
    let observedPreparingDuringUnlock = false;
    let authorizationSawMarker = false;
    const readOnlyTransition = () => {
      const transitionName = fs
        .readdirSync(stateDir)
        .find((name) => name.startsWith("shields-transition-openclaw-"));
      expect(transitionName).toBeDefined();
      return JSON.parse(fs.readFileSync(path.join(stateDir, transitionName!), "utf-8"));
    };
    const harness = createHarness({
      fork: () => ({
        pid: 4242,
        disconnect: vi.fn(),
        unref: vi.fn(),
        send: vi.fn(() => {
          authorizationSawMarker = fs.existsSync(
            path.join(stateDir, "shields-timer-openclaw.json"),
          );
          return true;
        }),
        kill: vi.fn(() => true),
      }),
      run: () => {
        observedPreparingDuringPolicy = readOnlyTransition().phase === "preparing";
        return { status: 0 };
      },
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        observedPreparingDuringUnlock ||= readOnlyTransition().phase === "preparing";
        switch (true) {
          case args.includes("sha256sum"):
            return `${"a".repeat(64)}  /sandbox/.openclaw/openclaw.json\n`;
          case args.includes("stat"):
            return args.at(-1) === "/sandbox"
              ? "755 sandbox:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? "2770 sandbox:sandbox\n"
                : "660 sandbox:sandbox\n";
          default:
            return "";
        }
      },
    });

    harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "race coverage",
      throwOnError: true,
    });

    const transition = readOnlyTransition();
    expect(observedPreparingDuringPolicy).toBe(true);
    expect(observedPreparingDuringUnlock).toBe(true);
    expect(authorizationSawMarker).toBe(true);
    expect(transition).toMatchObject({
      version: 1,
      phase: "active",
      ownerPid: process.pid,
      sandboxName: "openclaw",
      snapshotPath: expect.stringContaining("policy-snapshot-"),
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(true);
  });

  it("shieldsUp refuses to mark lockdown active when the saved restrictive policy snapshot is missing", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: path.join(stateDir, "missing-snapshot.yaml"),
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "Saved policy snapshot is missing",
    );
  });

  it("retains the bounded auto-restore owner when manual shields-up fails", () => {
    const harness = createHarness();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-relock-failure.yaml");
    const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 1800,
        shieldsDownReason: "rebuild",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 4242,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken: "timer-token",
        allowLegacyHermesProtocol: false,
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /Config not locked/,
    );

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"))
        .shieldsDown,
    ).toBe(true);
  });

  it("shieldsStatus restores an expired dead timer through the same lock path as shields up", () => {
    const configPath = "/sandbox/.openclaw/openclaw.json";
    const configDir = "/sandbox/.openclaw";
    const hashPath = `${configDir}/.config-hash`;
    const configHash = "a".repeat(64);
    const hashHash = "b".repeat(64);
    const processToken = "7".repeat(32);
    const execCalls: string[] = [];
    const execResponses = new Map([
      [` stat -c %a %U:%G ${hashPath}`, "444 root:root\n"],
      [` stat -c %a %U:%G ${configPath}`, "444 root:root\n"],
      [` stat -c %a %U:%G ${configDir}`, "755 root:root\n"],
      [" stat -c %a %U:%G /sandbox", "1775 root:sandbox\n"],
      [` lsattr -d ${hashPath}`, `----i---------e----- ${hashPath}\n`],
      [` lsattr -d ${configPath}`, `----i---------e----- ${configPath}\n`],
      [` sha256sum ${hashPath}`, `${hashHash}  ${hashPath}\n`],
      [` sha256sum ${configPath}`, `${configHash}  ${configPath}\n`],
    ]);
    const harness = createHarness({
      dockerExecFileSync: (argv: unknown) => {
        const args = Array.isArray(argv) ? argv.map(String) : [];
        const cmd = args.join(" ");
        execCalls.push(cmd);
        return [...execResponses].find(([needle]) => cmd.includes(needle))?.[1] ?? "";
      },
    });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const lockPath = path.join(stateDir, "shields-transition-lock-openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPath = path.join(stateDir, "policy-snapshot-expired.yaml");
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 60,
        shieldsDownReason: "coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, "shields-timer-openclaw.json"),
      JSON.stringify({
        pid: 4242,
        sandboxName: "openclaw",
        snapshotPath,
        restoreAt: new Date(Date.now() - 30_000).toISOString(),
        processToken,
      }),
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        sandboxName: "openclaw",
        pid: 4242,
        processStartIdentity: "dead-timer",
        command: "shields auto-restore",
        acquiredAtMs: Date.now() - 60_000,
        takeoverToken: processToken,
      }),
    );
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      const failDeadTimerProbe = () => {
        const error = new Error("timer is gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      };
      const deadTimerProbe = `${pid}:${signal}` === "4242:0" ? failDeadTimerProbe : undefined;
      deadTimerProbe?.();
      return true;
    });

    harness.shieldsStatus("openclaw");

    const state = JSON.parse(
      fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
    );
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
    expect(state.shieldsDown).toBe(false);
    expect(state.fileHashes).toMatchObject({
      [configPath]: configHash,
      [hashPath]: hashHash,
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(harness.auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "shields_auto_restore",
        policy_snapshot: snapshotPath,
        restored_by: "auto_timer",
        sandbox: "openclaw",
      }),
    );
    expect(execCalls.some((cmd) => cmd.includes(` sha256sum ${hashPath}`))).toBe(true);
  });
});
