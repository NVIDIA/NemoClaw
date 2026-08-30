// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  createHermesUnsafeConfigHarness,
  expectHermesShieldsUpRecord,
  failHermesInferenceConvergence,
  type HermesUnsafeConfigHarness,
} from "../../../test/helpers/hermes-unsafe-config-shields-harness";
import {
  createShieldsFlowHarness,
  type ShieldsFlowHarnessOptions,
} from "../../../test/helpers/shields-flow-harness";
import { createCompletedAutoRestoreFixture } from "../../../test/support/completed-auto-restore-fixture";
import type { AgentConfigTarget } from "../sandbox/agent-config";

const requireSource = createRequire(import.meta.url);
const INDEX_MODULE = "./index.js";

type ShieldsModule = typeof import("./index");

const STATE_LOCK_PLAN = {
  version: 1 as const,
  readOnlyRoots: ["skills"],
  confidentialRoots: ["credentials"],
  readOnlyPrefixes: [],
  confidentialPrefixes: [],
  writableSubpaths: [],
};

const RETRY_STATE_LOCK_PLAN = {
  version: 1 as const,
  readOnlyRoots: ["skills"],
  confidentialRoots: [],
  readOnlyPrefixes: [],
  confidentialPrefixes: [],
  writableSubpaths: [],
};

function openClawTarget() {
  return {
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    format: "json",
    configFile: "openclaw.json",
    sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    stateLockPlan: STATE_LOCK_PLAN,
    stateLockPlanInImage: true,
  };
}

const retryAgentCases: ReadonlyArray<
  readonly [label: string, sandboxName: string, target: AgentConfigTarget]
> = [
  [
    "OpenClaw",
    "openclaw",
    {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      format: "json",
      configFile: "openclaw.json",
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
      stateLockPlan: RETRY_STATE_LOCK_PLAN,
      stateLockPlanInImage: true,
    },
  ],
  [
    "Hermes",
    "hermes",
    {
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      format: "yaml",
      configFile: "config.yaml",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash"],
      stateLockPlan: RETRY_STATE_LOCK_PLAN,
      stateLockPlanInImage: true,
    },
  ],
  [
    "DCode",
    "dcode",
    {
      agentName: "langchain-deepagents-code",
      configPath: "/sandbox/.deepagents/config.toml",
      configDir: "/sandbox/.deepagents",
      format: "toml",
      configFile: "config.toml",
      sensitiveFiles: ["/sandbox/.deepagents/.config-hash"],
      stateLockPlan: RETRY_STATE_LOCK_PLAN,
      stateLockPlanInImage: false,
    },
  ],
];

const retryConflictCases: ReadonlyArray<
  readonly [
    label: string,
    retryOptions: { timeout?: string; reason?: string; policy?: string; throwOnError: true },
  ]
> = [
  ["timeout", { timeout: "6m", reason: "retry-safe", policy: "permissive", throwOnError: true }],
  ["reason", { timeout: "5m", reason: "changed-reason", policy: "permissive", throwOnError: true }],
  ["policy", { timeout: "5m", reason: "retry-safe", policy: "custom-policy", throwOnError: true }],
];

describe("OpenClaw shields top-config transaction", () => {
  let homeDir: string;
  let shields: ShieldsModule;
  let spies: MockInstance[];
  let privilegedExecSpy: MockInstance;
  let dockerExecSpy: MockInstance;
  let guardSpy: MockInstance;
  let applyStateSpy: MockInstance;
  let restoreStateSpy: MockInstance;
  let compatibilitySpy: MockInstance;
  let events: string[];

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-transition-"));
    vi.stubEnv("HOME", homeDir);
    spies = [];
    events = [];
    delete require.cache[requireSource.resolve(INDEX_MODULE)];

    const runner = requireSource("../runner.js");
    const agentConfig = requireSource("../sandbox/agent-config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");
    const openClawLock = requireSource("./openclaw-config-lock.js");

    dockerExecSpy = vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "stat":
          return argv.at(-1) === "/sandbox"
            ? "1775 root:sandbox"
            : argv.at(-1) === "/sandbox/.openclaw"
              ? "755 root:root"
              : "444 root:root";
        case "lsattr":
          return `---------------- ${String(argv.at(-1))}`;
        case "sha256sum":
          return `${"a".repeat(64)}  ${String(argv.at(-1))}`;
        default:
          return "";
      }
    });
    guardSpy = vi
      .spyOn(openClawLock, "runOpenClawConfigGuard")
      .mockImplementation((_exec, action) => {
        events.push(`top:${action}`);
        return { issues: [], chattrApplied: false };
      });
    applyStateSpy = vi
      .spyOn(stateDirLock, "applyStateDirLockMode")
      .mockImplementation((_exec, _dir, _owner, locking) => {
        events.push(`state:${locking ? "lock" : "unlock"}`);
        return [];
      });
    restoreStateSpy = vi
      .spyOn(stateDirLock, "restoreStateDirLockPosture")
      .mockImplementation((_exec, _dir, locked) => {
        events.push(`state:restore:${locked ? "locked" : "mutable"}`);
        return [];
      });
    privilegedExecSpy = vi
      .spyOn(privilegedExec, "privilegedSandboxExecArgv")
      .mockImplementation((_sandboxName: unknown, cmd: unknown) => cmd as string[]);
    compatibilitySpy = vi
      .spyOn(stateDirLock, "stateLockPlanCompatibilityIssues")
      .mockReturnValue([]);

    spies.push(
      vi.spyOn(runner, "run").mockReturnValue({ status: 0 }),
      vi.spyOn(runner, "runCapture").mockReturnValue(""),
      vi.spyOn(agentConfig, "resolveAgentConfig").mockImplementation(() => openClawTarget()),
      privilegedExecSpy,
      dockerExecSpy,
      compatibilitySpy,
      vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]),
      applyStateSpy,
      restoreStateSpy,
      guardSpy,
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    );

    shields = requireSource(INDEX_MODULE);
  }, 30_000);

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function useMutablePosture() {
    dockerExecSpy.mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "stat":
          return argv.at(-1) === "/sandbox"
            ? "755 sandbox:sandbox"
            : argv.at(-1) === "/sandbox/.openclaw"
              ? "2770 sandbox:sandbox"
              : "660 sandbox:sandbox";
        case "lsattr":
          return `---------------- ${String(argv.at(-1))}`;
        default:
          return "";
      }
    });
  }

  function guardFailure(code: string, detail: string) {
    return {
      issues: [
        `OpenClaw config guard preflight [${code}] /run/nemoclaw/openclaw-config-ready.json: ${detail}`,
      ],
      issueCodes: [code],
      chattrApplied: false,
    };
  }

  it("freezes the top-level binding before recursive lock and avoids pathname mutation", () => {
    expect(() => shields.lockAgentConfig("openclaw", openClawTarget(), false)).not.toThrow();

    expect(events.slice(0, 2)).toEqual(["top:lock", "state:lock"]);
    const commands = dockerExecSpy.mock.calls.map((call) => call[0] as string[]);
    expect(commands.some((cmd) => ["chmod", "chown", "chattr"].includes(cmd[0]))).toBe(false);
    expect(commands.some((cmd) => cmd[0] === "stat" && cmd.at(-1) === "/sandbox")).toBe(true);
  });

  it("rejects an incompatible runtime plan before mutating the config tree", () => {
    compatibilitySpy.mockReturnValueOnce([
      "installed state lock plan differs from the current agent manifest",
    ]);

    expect(() => shields.lockAgentConfig("openclaw", openClawTarget(), false)).toThrow(
      /installed state lock plan differs/,
    );

    expect(events).toEqual([]);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
  });

  it("preserves the sealed top after a partial recursive lock", () => {
    applyStateSpy.mockImplementationOnce((_exec, _dir, _owner, locking) => {
      events.push(`state:${locking ? "lock" : "unlock"}`);
      return ["recursive lock failed"];
    });

    expect(() => shields.lockAgentConfig("openclaw", openClawTarget(), false)).toThrow(
      /recursive lock failed/,
    );

    expect(events).toEqual(["top:lock", "state:lock", "top:lock"]);
    expect(restoreStateSpy).not.toHaveBeenCalled();
  });

  it("repairs doctor-tightened permissions without starting a shields transition (#6047)", () => {
    dockerExecSpy.mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "/usr/bin/id":
          return "1000\n";
        case "/usr/bin/timeout":
          return "";
        default:
          throw new Error(`unexpected privileged command: ${argv.join(" ")}`);
      }
    });

    expect(shields.repairMutableConfigPerms("openclaw")).toEqual({
      applied: true,
      verified: true,
      errors: [],
    });

    const commands = dockerExecSpy.mock.calls.map((call) => call[0] as string[]);
    expect(commands).toEqual([
      ["/usr/bin/id", "-u", "sandbox"],
      ["/usr/bin/id", "-g", "sandbox"],
      [
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "15s",
        "/usr/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
        "/sandbox/.openclaw",
        "1000",
        "1000",
      ],
    ]);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
  });

  it("fails closed when mutable repair cannot resolve the sandbox identity (#6047)", () => {
    dockerExecSpy.mockReturnValue("root\n");

    expect(shields.repairMutableConfigPerms("openclaw")).toEqual({
      applied: true,
      verified: false,
      errors: ["sandbox identity lookup returned an invalid UID"],
    });

    expect(dockerExecSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
  });

  it("keeps the protected top binding until recursive unlock is ready", () => {
    useMutablePosture();

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).not.toThrow();

    expect(events.slice(0, 3)).toEqual(["top:preflight", "state:unlock", "top:unlock"]);
  });

  it("uses structured readiness diagnostics and verifies recovered mutable posture (#8304)", () => {
    useMutablePosture();
    guardSpy.mockImplementation((_exec, action) => {
      events.push(`top:${action}`);
      return action === "preflight"
        ? guardFailure("startup-not-ready", "startup lease is absent")
        : { issues: [], chattrApplied: false };
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).not.toThrow();
    expect(events).toEqual(["top:preflight", "top:unlock-failed-startup"]);
    const commands = dockerExecSpy.mock.calls.map((call) => call[0] as string[]);
    expect(commands.filter((cmd) => cmd[0] === "stat").map((cmd) => cmd.at(-1))).toEqual([
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw/.config-hash",
      "/sandbox/.openclaw",
      "/sandbox",
    ]);
  });

  it("does not recover when readiness is mixed with another guard failure (#8304)", () => {
    guardSpy.mockImplementation((_exec, action) => {
      events.push(`top:${action}`);
      return action === "preflight"
        ? {
            issues: [
              "OpenClaw config guard preflight [startup-not-ready] /run/nemoclaw/openclaw-config-ready.json: startup lease is absent",
              "OpenClaw config guard preflight returned an invalid result contract",
            ],
            issueCodes: ["startup-not-ready"],
            chattrApplied: false,
          }
        : { issues: [], chattrApplied: false };
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).toThrow(
      /invalid result contract/,
    );
    expect(events).toEqual(["top:preflight"]);
  });

  it("falls back only for the distinct not-applicable recovery code (#8304)", () => {
    guardSpy.mockImplementation((_exec, action) => {
      events.push(`top:${action}`);
      return action === "preflight"
        ? guardFailure("startup-not-ready", "startup lease is absent")
        : guardFailure(
            "failed-startup-not-proven",
            "unlock-failed-startup requires a proven terminal startup failure",
          );
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).toThrow(
      /\[startup-not-ready\].*startup lease is absent/,
    );
    expect(events).toEqual(["top:preflight", "top:unlock-failed-startup"]);
  });

  it("propagates lost failed-startup authorization instead of masking it (#8304)", () => {
    guardSpy.mockImplementation((_exec, action) => {
      events.push(`top:${action}`);
      return action === "preflight"
        ? guardFailure("startup-not-ready", "startup lease is absent")
        : guardFailure(
            "startup-not-ready",
            "unlock-failed-startup lost its failed-startup authorization before taking effect",
          );
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).toThrow(
      /Failed-startup shields recovery failed.*lost its failed-startup authorization/,
    );
    expect(events).toEqual(["top:preflight", "top:unlock-failed-startup"]);
  });

  it("fails closed to the locked posture when recursive unlock is partial", () => {
    applyStateSpy.mockImplementationOnce((_exec, _dir, _owner, locking) => {
      events.push(`state:${locking ? "lock" : "unlock"}`);
      return ["recursive unlock failed"];
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).toThrow(
      /recursive unlock failed/,
    );
    expect(events).toEqual(["top:preflight", "state:unlock", "top:lock", "state:restore:locked"]);
  });

  it("reports a failed mutable top-config transition without falling back to recursive unlock", () => {
    privilegedExecSpy.mockImplementationOnce(() => {
      throw new Error("top-config permission repair failed");
    });

    const result = shields.repairMutableConfigPerms("openclaw");

    expect(result).toEqual({
      applied: true,
      verified: false,
      errors: [expect.stringContaining("top-config permission repair failed")],
    });
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
    expect(restoreStateSpy).not.toHaveBeenCalled();
  });
});

describe("OpenClaw shields flow rollback and recovery", () => {
  let tmpDir: string;

  function createHarness(options: ShieldsFlowHarnessOptions = {}) {
    return createShieldsFlowHarness(requireSource, tmpDir, options);
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

  function readStateAndTimer(sandboxName: string) {
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, `shields-${sandboxName}.json`);
    const timerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    return {
      statePath,
      timerPath,
      state: fs.readFileSync(statePath, "utf-8"),
      timer: fs.readFileSync(timerPath, "utf-8"),
    };
  }

  function createRetryHarness(sandboxName: string, target: AgentConfigTarget) {
    return createHarness({
      agentConfigTarget: target,
      confirmOpenClawInodeFlags: true,
      processStartIdentity: `issue-8806-${sandboxName}-owner`,
      sandboxName,
    });
  }

  function createBackupRecoveryScenario() {
    const harness = createHarness();
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    expect(recovery).toBeDefined();
    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      shieldsPolicySnapshotPath: string;
    };
    return {
      harness,
      recovery: recovery!,
      statePath,
      snapshotPath: state.shieldsPolicySnapshotPath,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-openclaw-recovery-"));
    vi.stubEnv("HOME", tmpDir);
  });

  it(
    "retires an orphaned completed auto-restore generation and containment (#10094)",
    {
      timeout: 30_000,
    },
    async () => {
      const harness = createHarness();
      const paths = await createCompletedAutoRestoreFixture(
        path.join(tmpDir, ".nemoclaw", "state"),
        "openclaw",
        "c".repeat(32),
      );
      const status = () =>
        harness.shieldsStatus("openclaw", true, {
          verifyLockState: () => ({ ok: true, issues: [] }),
          verifyStateLockPlan: () => [],
        });

      status();
      status();

      expect(harness.logSpy).toHaveBeenCalledWith("  Shields: UP (lockdown active)");
      expect(
        [paths.containmentPath, paths.deadlinePath, paths.lockPath, paths.markerPath].map((file) =>
          fs.existsSync(file),
        ),
      ).toEqual([false, false, false, false]);
    },
  );

  it("preserves completed containment for a live ambiguous timer PID", async () => {
    const harness = createHarness();
    const paths = await createCompletedAutoRestoreFixture(
      path.join(tmpDir, ".nemoclaw", "state"),
      "openclaw",
      "c".repeat(32),
    );
    const marker = JSON.parse(fs.readFileSync(paths.markerPath, "utf8"));
    marker.pid = process.pid;
    delete marker.timerProcessStartIdentity;
    fs.writeFileSync(paths.markerPath, JSON.stringify(marker));

    expect(() => harness.shieldsStatus("openclaw")).toThrow("containment is active");
    expect([paths.lockPath, paths.containmentPath, paths.markerPath].map(fs.existsSync)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("gives safe retry guidance when completed recovery authority changes", async () => {
    const harness = createHarness();
    const paths = await createCompletedAutoRestoreFixture(
      path.join(tmpDir, ".nemoclaw", "state"),
      "openclaw",
      "c".repeat(32),
    );
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementationOnce((source, destination) => {
      realRename(source, destination);
      const marker = JSON.parse(fs.readFileSync(paths.markerPath, "utf8"));
      marker.restoreAt = new Date(Date.now() + 60_000).toISOString();
      fs.writeFileSync(paths.markerPath, JSON.stringify(marker));
    });

    expect(() => harness.shieldsStatus("openclaw")).toThrow(
      "Rerun nemoclaw openclaw shields status. Do not modify lifecycle-lock or timer files",
    );
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.containmentPath)).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    delete require.cache[requireSource.resolve("./timer-bound-lock.js")];
    delete require.cache[requireSource.resolve("./transition-lock.js")];
    delete require.cache[requireSource.resolve("./permissive-runtime.js")];
    delete require.cache[requireSource.resolve("../actions/sandbox/mcp-bridge-policy.js")];
    delete require.cache[requireSource.resolve("../cli/branding.js")];
  });

  it.each(retryAgentCases)(
    "accepts an equivalent repeated shieldsDown request for %s without changing state or timer authority (#8806)",
    { timeout: 30_000 },
    (_label, sandboxName, target) => {
      const harness = createRetryHarness(sandboxName, target);

      harness.shieldsDown(sandboxName, {
        timeout: "5m",
        reason: "retry-safe",
        policy: "permissive",
        throwOnError: true,
      });

      const before = readStateAndTimer(sandboxName);
      harness.logSpy.mockClear();
      harness.errorSpy.mockClear();
      harness.runCaptureSpy.mockClear();
      harness.runSpy.mockClear();
      harness.auditSpy.mockClear();

      harness.shieldsDown(sandboxName, {
        timeout: "5m",
        reason: "retry-safe",
        policy: "permissive",
        throwOnError: true,
      });

      expect(fs.readFileSync(before.statePath, "utf-8")).toBe(before.state);
      expect(fs.readFileSync(before.timerPath, "utf-8")).toBe(before.timer);
      expect(harness.runCaptureSpy).not.toHaveBeenCalled();
      expect(harness.runSpy).not.toHaveBeenCalled();
      expect(harness.auditSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy).not.toHaveBeenCalled();
      expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
        `Shields already down for ${sandboxName}; equivalent request accepted.`,
      );
    },
  );

  it.each(
    retryAgentCases.flatMap(([label, sandboxName, target]) =>
      retryConflictCases.map(
        ([conflict, retryOptions]) => [label, conflict, sandboxName, target, retryOptions] as const,
      ),
    ),
  )(
    "rejects a repeated shieldsDown request for %s with a conflicting %s without changing state or timer authority (#8806)",
    { timeout: 30_000 },
    (_label, _conflict, sandboxName, target, retryOptions) => {
      const harness = createRetryHarness(sandboxName, target);

      harness.shieldsDown(sandboxName, {
        timeout: "5m",
        reason: "retry-safe",
        policy: "permissive",
        throwOnError: true,
      });

      const before = readStateAndTimer(sandboxName);
      harness.runCaptureSpy.mockClear();
      harness.runSpy.mockClear();
      harness.auditSpy.mockClear();
      harness.errorSpy.mockClear();

      expect(() => harness.shieldsDown(sandboxName, retryOptions)).toThrow(
        new RegExp(`Config is already unlocked for ${sandboxName}`, "u"),
      );

      expect(fs.readFileSync(before.statePath, "utf-8")).toBe(before.state);
      expect(fs.readFileSync(before.timerPath, "utf-8")).toBe(before.timer);
      expect(harness.runCaptureSpy).not.toHaveBeenCalled();
      expect(harness.runSpy).not.toHaveBeenCalled();
      expect(harness.auditSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("already unlocked");
    },
  );

  it(
    "rejects a Hermes repeated shieldsDown request with no options without changing state or timer authority (#8806)",
    {
      timeout: 30_000,
    },
    () => {
      const [, sandboxName, target] = retryAgentCases[1]!;
      const harness = createRetryHarness(sandboxName, target);

      harness.shieldsDown(sandboxName, {
        timeout: "5m",
        reason: "retry-safe",
        policy: "permissive",
        throwOnError: true,
      });

      const before = readStateAndTimer(sandboxName);
      harness.runCaptureSpy.mockClear();
      harness.runSpy.mockClear();
      harness.auditSpy.mockClear();
      harness.errorSpy.mockClear();

      expect(() => harness.shieldsDown(sandboxName, { throwOnError: true })).toThrow(
        /Config is already unlocked for hermes/u,
      );

      expect(fs.readFileSync(before.statePath, "utf-8")).toBe(before.state);
      expect(fs.readFileSync(before.timerPath, "utf-8")).toBe(before.timer);
      expect(harness.runCaptureSpy).not.toHaveBeenCalled();
      expect(harness.runSpy).not.toHaveBeenCalled();
      expect(harness.auditSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("already unlocked");
    },
  );

  it(
    "rejects an equivalent repeated shieldsDown request with missing timer authority and restores lockdown (#8806)",
    {
      timeout: 30_000,
    },
    () => {
      const harness = createRetryHarness("openclaw", retryAgentCases[0]![2]);

      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "retry-safe",
        policy: "permissive",
        throwOnError: true,
      });

      const before = readStateAndTimer("openclaw");
      fs.rmSync(before.timerPath, { force: true });
      harness.runCaptureSpy.mockClear();
      harness.auditSpy.mockClear();
      harness.errorSpy.mockClear();

      expect(() =>
        harness.shieldsDown("openclaw", {
          timeout: "5m",
          reason: "retry-safe",
          policy: "permissive",
          throwOnError: true,
        }),
      ).toThrow(/Cannot accept equivalent shields down request without live auto-restore timer/u);

      expect(JSON.parse(fs.readFileSync(before.statePath, "utf-8"))).toMatchObject({
        shieldsDown: false,
        shieldsDownAt: null,
      });
      expect(fs.existsSync(before.timerPath)).toBe(false);
      expect(harness.auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: "shields_auto_restore", sandbox: "openclaw" }),
      );
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "Cannot accept equivalent shields down request without live auto-restore timer authority.",
      );
    },
  );

  it("shields down removes the permissive runtime temp directory when the auto-restore timer fails (#7964)", () => {
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    // shieldsDown builds the temp policy before it forks the auto-restore timer,
    // so the fork mock observes the runtime-policy directory mid-transition. That
    // proves the test exercises real temp-policy creation, not only the absence
    // of a leak.
    let runtimeDirDuringFork: string | undefined;
    let runtimeDirExistedDuringFork = false;
    // A real `openshell policy get --base` carries filesystem_policy paths, so the
    // permissive merge writes a temp policy file instead of returning the static
    // base path. That is the state that makes the leak reachable.
    const harness = createHarness({
      livePolicyYaml:
        "version: 1\nfilesystem_policy:\n  read_write:\n    - /proc\n  read_only:\n    - /opt/hermes\n",
      fork: () => {
        runtimeDirDuringFork = mkdtempSpy.mock.results
          .filter((result) => result.type === "return")
          .map((result) => String(result.value))
          .find((directory) => path.basename(directory).startsWith("nemoclaw-permissive-runtime-"));
        runtimeDirExistedDuringFork =
          runtimeDirDuringFork !== undefined && fs.existsSync(runtimeDirDuringFork);
        return {
          pid: 0,
          disconnect: vi.fn(),
          unref: vi.fn(),
          send: vi.fn(() => true),
          kill: vi.fn(() => true),
        };
      },
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "temp cleanup coverage",
        throwOnError: true,
      }),
    ).toThrow("Cannot start auto-restore timer");
    // One runtime-policy directory existed during the transition, and none
    // remains after the failed shields down.
    expect(runtimeDirExistedDuringFork).toBe(true);
    expect(runtimeDirDuringFork).toBeDefined();
    expect(fs.existsSync(runtimeDirDuringFork!)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "atomically replaces a timer marker symlink without modifying its target",
    () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
      const markerTargetPath = path.join(stateDir, "operator-owned-marker.json");
      const markerTarget = "operator-owned marker contents";
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(markerTargetPath, markerTarget);
      const originalRename = fs.renameSync.bind(fs);
      const plantMarkerSymlink = () => fs.symlinkSync(markerTargetPath, markerPath);
      const publicationRoutes = new Map<string, () => void>([[markerPath, plantMarkerSymlink]]);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        (publicationRoutes.get(String(destination)) ?? (() => undefined))();
        originalRename(source, destination);
      });
      const harness = createHarness({
        fork: () => ({
          pid: 4242,
          disconnect: vi.fn(),
          unref: vi.fn(),
          send: vi.fn(() => true),
          kill: vi.fn(() => true),
        }),
      });

      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "marker publication coverage",
        throwOnError: true,
      });

      expect(renameSpy).toHaveBeenCalledWith(expect.stringContaining(".tmp"), markerPath);
      const markerFd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(fs.fstatSync(markerFd).isFile()).toBe(true);
        expect(JSON.parse(fs.readFileSync(markerFd, "utf-8"))).toMatchObject({
          pid: 4242,
          sandboxName: "openclaw",
        });
      } finally {
        fs.closeSync(markerFd);
      }
      expect(fs.readFileSync(markerTargetPath, "utf-8")).toBe(markerTarget);
    },
  );

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

  it("restores the exact preserved restrictive snapshot before backup relock (#9452)", () => {
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      shieldsPolicySnapshotPath: string;
    };
    const expectedPolicy = fs.readFileSync(state.shieldsPolicySnapshotPath, "utf-8");
    expect(recovery).toBeDefined();
    fs.rmSync(state.shieldsPolicySnapshotPath);

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery!, throwOnError: true }),
    ).not.toThrow();
    expect(fs.readFileSync(state.shieldsPolicySnapshotPath, "utf-8")).toBe(expectedPolicy);
  });

  it("refuses to overwrite a changed restrictive snapshot during backup recovery (#9452)", () => {
    const harness = createHarness();
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    const statePath = path.join(tmpDir, ".nemoclaw", "state", "shields-openclaw.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
      shieldsPolicySnapshotPath: string;
    };
    expect(recovery).toBeDefined();
    const changedPolicy = "version: 1\nnetwork_policies:\n  changed: {}\n";
    fs.writeFileSync(state.shieldsPolicySnapshotPath, changedPolicy, { mode: 0o600 });

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery!, throwOnError: true }),
    ).toThrow(
      /Backup Shields policy recovery failed.*(?:unsafe metadata|no longer matches its binding)/u,
    );
    expect(fs.readFileSync(state.shieldsPolicySnapshotPath, "utf-8")).toBe(changedPolicy);
  });

  it("rejects a symlinked restrictive snapshot during backup recovery (#9452)", () => {
    const { harness, recovery, snapshotPath } = createBackupRecoveryScenario();
    const symlinkTarget = path.join(tmpDir, "untrusted-policy-target.yaml");
    const targetContent = "version: 1\nnetwork_policies:\n  untrusted: {}\n";
    fs.writeFileSync(symlinkTarget, targetContent, { mode: 0o600 });
    fs.rmSync(snapshotPath);
    fs.symlinkSync(symlinkTarget, snapshotPath);

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed/u);
    expect(fs.lstatSync(snapshotPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(symlinkTarget, "utf-8")).toBe(targetContent);
    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*authority is invalid/u);
  });

  it.each([
    ["unsafe permissions", (snapshotPath: string) => fs.chmodSync(snapshotPath, 0o644)],
    [
      "multiple hard links",
      (snapshotPath: string) => fs.linkSync(snapshotPath, `${snapshotPath}.extra-link`),
    ],
  ])("rejects a restrictive snapshot with %s during backup recovery (#9452)", (_label, tamper) => {
    const { harness, recovery, snapshotPath } = createBackupRecoveryScenario();
    tamper(snapshotPath);

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*unsafe metadata/u);
    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*authority is invalid/u);
  });

  it("rejects changed persisted snapshot authorization during backup recovery (#9452)", () => {
    const { harness, recovery, statePath, snapshotPath } = createBackupRecoveryScenario();
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        ...state,
        shieldsPolicySnapshotPath: `${snapshotPath}.unauthorized`,
      }),
      { mode: 0o600 },
    );

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*state no longer authorizes/u);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*authority is invalid/u);
  });

  it("consumes a backup recovery receipt only once (#9452)", () => {
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    expect(recovery).toBeDefined();

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery!, throwOnError: true }),
    ).not.toThrow();
    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery!, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*authority is invalid/u);
  });

  it("consumes a held backup receipt after auto-restore already relocks Shields (#9452)", () => {
    const harness = createHarness({ confirmOpenClawInodeFlags: true });
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    expect(recovery).toBeDefined();
    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).not.toThrow();

    expect(() =>
      harness.shieldsUp("openclaw", {
        policySnapshotRecovery: recovery!,
        throwOnError: true,
      }),
    ).not.toThrow();
    expect(() =>
      harness.shieldsUp("openclaw", {
        policySnapshotRecovery: recovery!,
        throwOnError: true,
      }),
    ).toThrow(/Backup Shields policy recovery failed.*authority is invalid/u);
  });

  it("rejects backup recovery after its Shields transition authority drifts (#9452)", () => {
    const harness = createHarness();
    const recovery = harness.shieldsDown("openclaw", {
      timeout: "5m",
      reason: "backup-all",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
    });
    expect(recovery).toBeDefined();
    const stateDir = path.join(tmpDir, ".nemoclaw", "state");
    const transitionPath = fs
      .readdirSync(stateDir)
      .map((entry) => path.join(stateDir, entry))
      .find((entry) => path.basename(entry).startsWith("shields-transition-openclaw-"));
    expect(transitionPath).toBeDefined();
    const transition = JSON.parse(fs.readFileSync(transitionPath!, "utf-8")) as {
      ownerStartIdentity: string;
    };
    fs.writeFileSync(
      transitionPath!,
      JSON.stringify({
        ...transition,
        ownerStartIdentity: `${transition.ownerStartIdentity}-drift`,
      }),
      { mode: 0o600 },
    );

    expect(() =>
      harness.shieldsUp("openclaw", { policySnapshotRecovery: recovery!, throwOnError: true }),
    ).toThrow(/Backup Shields policy recovery failed.*transition no longer authorizes/u);
  });

  it("reports staged driver-neutral recovery when shields-down rollback cannot re-lock (#6126)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["unlock", "lock"] });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "recovery-hint coverage",
        throwOnError: true,
      }),
    ).toThrow(/startup-not-ready/);

    const output = expectStagedDriverNeutralRecovery(harness.errorSpy, "openclaw");
    expect(output).toContain("Rolling back — restoring policy from snapshot");
    expect(output).toContain("Config remains unlocked — manual intervention required");
  });

  it("keeps the host attached beyond failed-startup recovery's container timeout (#8304)", () => {
    const harness = createHarness({ failOpenClawGuardActions: ["preflight"] });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "failed-startup timeout coverage",
        throwOnError: true,
      }),
    ).not.toThrow();

    const recovery = harness.dockerSpawnCalls.find(({ args }) =>
      args.includes("unlock-failed-startup"),
    );
    expect(recovery?.args).toEqual(
      expect.arrayContaining(["timeout", "--kill-after=5s", "25m", "unlock-failed-startup"]),
    );
    expect(recovery?.timeout).toBe(26 * 60 * 1000);
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
});

describe("Hermes Shields down unsafe config path (#8804)", () => {
  const harnessFactory = createHermesUnsafeConfigHarness(requireSource, INDEX_MODULE);
  let harness: HermesUnsafeConfigHarness;

  beforeEach(() => {
    harness = harnessFactory.beforeEachHook();
  });

  afterEach(() => {
    harnessFactory.afterEachHook();
  });

  it("rejects a Hermes config symlink before Shields down weakens posture (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("preflight-symlink");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", { reason: "unsafe-path", throwOnError: true }),
    ).toThrow(/refusing symlink path: .*config\.yaml/);

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expectHermesShieldsUpRecord(stateDir, "hermes-shields", harness.shields);
    expect(harness.shields.getShieldsPosture("hermes-shields", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
  });

  it("rejects a replaced Hermes config directory before Shields down weakens posture (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("preflight-dir-symlink");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", { reason: "unsafe-path", throwOnError: true }),
    ).toThrow(/refusing symlink path: .*\.hermes/);

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expectHermesShieldsUpRecord(stateDir, "hermes-shields", harness.shields);
    expect(harness.shields.getShieldsPosture("hermes-shields", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
  });

  it("rejects a missing Hermes config before Shields down weakens posture (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("preflight-missing-config");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", {
        reason: "missing-config",
        throwOnError: true,
      }),
    ).toThrow(/missing config path: .*config\.yaml/);

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expectHermesShieldsUpRecord(stateDir, "hermes-shields", harness.shields);
    expect(harness.shields.getShieldsPosture("hermes-shields", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
  });

  it("rejects a Hermes sensitive-file symlink before Shields down weakens posture (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("preflight-sensitive-file-symlink");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", { reason: "unsafe-path", throwOnError: true }),
    ).toThrow(/refusing symlink path: .*\.env/);

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expectHermesShieldsUpRecord(stateDir, "hermes-shields", harness.shields);
    expect(harness.shields.getShieldsPosture("hermes-shields", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
  });

  it("keeps DOWN when unlock fails and unsafe re-lock cannot verify protection (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("unlock-symlink");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", {
        reason: "unsafe-path",
        timeout: "15m",
        throwOnError: true,
      }),
    ).toThrow(/refusing to follow symlink: \/sandbox\/\.hermes\/config\.yaml/);

    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-hermes-shields.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: true });
    expect(harness.auditSpy).not.toHaveBeenCalled();
    const errors = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(errors).toContain("Manual intervention is required");
    expect(errors).not.toContain("provisional Shields down cleared");
  });

  it("keeps DOWN when unsafe replacement breaks rollback after mutation begins (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("unlock-partial-rollback-symlink");

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", {
        reason: "unsafe-path-during-unlock",
        timeout: "15m",
        throwOnError: true,
      }),
    ).toThrow(/refusing to follow symlink: \/sandbox\/\.hermes\/config\.yaml/);

    const errors = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-hermes-shields.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: true });
    expect(harness.shields.isShieldsDown("hermes-shields")).toBe(true);
    expect(errors).toContain("Hermes shields rollback preparation failed");
    expect(errors).toContain("Manual intervention is required");
    expect(errors).not.toContain("provisional Shields down cleared");
  });

  it("keeps DOWN when unlock succeeded and unsafe re-lock cannot verify protection (#8804)", () => {
    const stateDir = harness.seedLockedState("hermes-shields");
    harness.setScenario("unlock-ok-relock-symlink");
    failHermesInferenceConvergence(requireSource);

    expect(() =>
      harness.shields.shieldsDown("hermes-shields", {
        reason: "unsafe-path-after-unlock",
        timeout: "15m",
        throwOnError: true,
      }),
    ).toThrow(/Hermes inference route did not converge/);

    const errors = harness.errorSpy.mock.calls.flat().map(String).join("\n");
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-hermes-shields.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: true });
    expect(errors).toContain("Manual intervention is required");
    expect(errors).not.toContain("provisional Shields down cleared");
  });
});
