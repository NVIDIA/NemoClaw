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
  errorSpy: MockInstance;
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
  directSandboxUnavailable?: boolean;
  dockerExecFileSync?: (argv: unknown) => string;
  failOpenClawGuardActions?: Array<"lock" | "unlock">;
  invokedAs?: "nemoclaw" | "nemohermes";
  openClawGuardFailure?: {
    code: string;
    path: string;
    detail: string;
  };
  openClawGuardFailures?: Array<{
    code: string;
    path: string;
    detail: string;
  }>;
  fork?: () => {
    pid: number;
    disconnect: () => void;
    unref: () => void;
    send: () => boolean;
    kill: () => boolean;
  };
  run?: (cmd: unknown) => { status: number };
};

function throwHarnessError(error: Error): never {
  throw error;
}

function createHarness(options: HarnessOptions = {}): ShieldsHarness {
  vi.stubEnv("NEMOCLAW_INVOKED_AS", options.invokedAs ?? "nemoclaw");
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
  delete require.cache[requireDist.resolve("./transition-lock.js")];
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  delete require.cache[requireDist.resolve("../cli/branding.js")];
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  const directSandboxUnavailableError = new Error(
    "No running direct OpenShell sandbox container found for 'openclaw' (driver: docker). Expected a running container named openshell-openclaw or openshell-openclaw-*. Is the sandbox running?",
  );
  vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(
    Boolean(options.directSandboxUnavailable),
  );
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) =>
      options.directSandboxUnavailable
        ? throwHarnessError(directSandboxUnavailableError)
        : [
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
    const shouldFailOpenClawGuard = Boolean(
      openClawGuard &&
        (action === "lock" || action === "unlock") &&
        options.failOpenClawGuardActions?.includes(action),
    );
    const failures = options.openClawGuardFailures ?? [
      options.openClawGuardFailure ?? {
        code: "startup-not-ready",
        path: "/run/nemoclaw/openclaw-config-ready.json",
        detail: "OpenClaw startup is not ready for host config mutations",
      },
    ];
    const failureResult = {
      status: 1,
      signal: null,
      stdout: `${failures
        .map((failure) => JSON.stringify({ type: "issue", ...failure }))
        .join("\n")}\n${JSON.stringify({ type: "result", action, status: "failed" })}\n`,
      stderr: "",
      pid: 0,
      output: [],
    };
    openClawPosture = shouldFailOpenClawGuard
      ? openClawPosture
      : openClawGuard && action === "lock"
        ? "locked"
        : openClawGuard && action === "unlock"
          ? "mutable"
          : openClawPosture;
    const successResult = {
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
    };
    return (shouldFailOpenClawGuard ? failureResult : successResult) as never;
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
  errorSpy.mockClear();
  auditSpy.mockClear();
  return {
    auditSpy,
    errorSpy,
    logSpy,
    runSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
    synchronizeAutoRestoreWithShieldsDown: shields.synchronizeAutoRestoreWithShieldsDown,
  };
}

function expectStagedDriverNeutralRecovery(
  errorSpy: MockInstance,
  sandboxName: string,
  cliName = "nemoclaw",
): string {
  const output = errorSpy.mock.calls.flat().map(String).join("\n");
  expect(output).toContain(
    `Recovery: confirm the sandbox is running and ready, then retry \`${cliName} ${sandboxName} shields up\`.`,
  );
  expect(output).toContain(
    `If the retry still fails, rebuild a known-good baseline with \`${cliName} ${sandboxName} rebuild --yes\`.`,
  );
  expect(output).not.toMatch(/kubectl/i);
  return output;
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
    delete require.cache[requireDist.resolve("../cli/branding.js")];
  });

  it("shieldsDown captures policy, unlocks config, saves state, and skips timer on request", {
    timeout: 15_000,
  }, () => {
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

  it("reports staged driver-neutral recovery when shields-down rollback cannot re-lock (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["unlock", "lock"] });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "recovery-hint coverage",
        skipTimer: true,
        throwOnError: true,
      }),
    ).toThrow(/startup-not-ready/);

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Rolling back — restoring policy from snapshot");
    expect(output).toContain("Config remains unlocked — manual intervention required");
  });

  it("reports staged driver-neutral recovery when snapshot restoration fails (#6126)", () => {
    const harness = createHarness({ run: () => ({ status: 1 }) });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-failed-restore.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "recovery-hint coverage",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "policy restore exited with status 1",
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Config remains unlocked — manual intervention required");
  });

  it("reports staged driver-neutral recovery when the initial config lock fails (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["lock"] });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
    expect(output).not.toContain("CRITICAL: OpenClaw lock rollback");
    expect(output).not.toContain(
      "OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox",
    );
  });

  it("uses the invoked nemohermes alias in staged recovery commands (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      invokedAs: "nemohermes",
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw", "nemohermes");
    expect(output).not.toContain("`nemoclaw openclaw shields up`");
    expect(output).not.toContain("`nemoclaw openclaw rebuild --yes`");
  });

  it("reports staged recovery when a stopped sandbox prevents config relock (#6126)", () => {
    const harness = createHarness({ directSandboxUnavailable: true });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /No running direct OpenShell sandbox container found/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
    expect(output).not.toContain("CRITICAL: OpenClaw lock rollback");
  });

  it("retains critical recovery for non-transient OpenClaw rollback failures (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailure: {
        code: "unsafe-config-path",
        path: "/sandbox/.openclaw/openclaw.json",
        detail: "canonical config path is not a safe regular file",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /unsafe-config-path/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("retains critical recovery for structural startup-not-ready diagnostics (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailure: {
        code: "startup-not-ready",
        path: "/run/nemoclaw/openclaw-config-ready.json",
        detail: "installed config guard requires NemoClaw PID 1",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /requires NemoClaw PID 1/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("retains critical recovery when a transient diagnostic is followed by another issue (#6126)", () => {
    const harness = createHarness({
      failOpenClawGuardActions: ["lock"],
      openClawGuardFailures: [
        {
          code: "startup-not-ready",
          path: "/run/nemoclaw/openclaw-config-ready.json",
          detail: "OpenClaw startup is not ready for host config mutations",
        },
        {
          code: "unsafe-config-path",
          path: "/sandbox/.openclaw/openclaw.json",
          detail: "canonical config path is not a safe regular file",
        },
      ],
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /unsafe-config-path/,
    );

    const output = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(output).toContain(
      "CRITICAL: OpenClaw lock rollback could not restore the trusted posture. Restore from a trusted backup and recreate the sandbox.",
    );
    expect(output).not.toContain(
      "Warning: OpenClaw lock rollback could not restore the trusted posture",
    );
  });

  it("reports staged driver-neutral recovery when drift remediation cannot re-lock (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["lock"] });
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({
        shieldsDown: false,
        chattrApplied: false,
        fileHashes: {
          "/sandbox/.openclaw/openclaw.json": "a".repeat(64),
          "/sandbox/.openclaw/.config-hash": "a".repeat(64),
        },
      }),
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /startup-not-ready/,
    );

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Config remains drifted — manual intervention required");
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

  it("shieldsStatus restores an expired dead timer under the shared sandbox lock", async () => {
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
    const lifecycleLock = requireDist("../state/mcp-lifecycle-lock.js");
    const sandboxMutationLockPath = lifecycleLock.getMcpLifecycleLockPath("openclaw");
    let policySetSawSandboxLock = false;
    const harness = createHarness({
      run: () => {
        policySetSawSandboxLock = fs.existsSync(sandboxMutationLockPath);
        return { status: 0 };
      },
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

    await lifecycleLock.withSandboxMutationLock("openclaw", () =>
      harness.shieldsStatus("openclaw"),
    );

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
    expect(policySetSawSandboxLock).toBe(true);
    expect(fs.existsSync(sandboxMutationLockPath)).toBe(false);
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
