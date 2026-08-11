// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  createShieldsFlowHarness,
  type ShieldsFlowHarnessOptions,
} from "../../../test/helpers/shields-flow-harness";

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
  });

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-openclaw-recovery-"));
    vi.stubEnv("HOME", tmpDir);
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
  const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
  const HERMES_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
  const LOCK_TOKEN = "a".repeat(64);
  const CURRENT_GUARD_HELP = [
    "begin-shields-transition",
    "run-state-dir-transition",
    "apply-shields-transition",
    "finish-shields-transition",
    "prepare-shields-abort",
    "abort-shields-transition",
    "--rollback-shields-mode",
    "--state-lock-plan-json",
  ].join(" ");
  const hermesTarget = {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    format: "yaml",
    configFile: "config.yaml",
    sensitiveFiles: ["/sandbox/.hermes/.env", "/sandbox/.hermes/.config-hash"],
    stateLockPlan: {
      version: 1 as const,
      readOnlyRoots: ["skills"],
      confidentialRoots: ["pairing"],
      readOnlyPrefixes: [],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
    stateLockPlanInImage: true,
  };

  let homeDir: string;
  let shields: typeof import("./index.js");
  let runSpy: MockInstance;
  let dockerExecSpy: MockInstance;
  let auditSpy: MockInstance;
  let errorSpy: MockInstance;

  function isGuardAction(cmd: string[], action: string): boolean {
    const guardIndex = cmd.indexOf(HERMES_GUARD);
    return guardIndex >= 0 && cmd[guardIndex + 1] === action;
  }

  function isPathPreflight(cmd: string[]): boolean {
    return (
      cmd[0] === "python3" &&
      cmd[1] === "-I" &&
      cmd[2] === "-c" &&
      typeof cmd[3] === "string" &&
      cmd[3].includes("nemoclaw-shields-down-path-preflight")
    );
  }

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-unsafe-config-"));
    vi.stubEnv("HOME", homeDir);
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    delete require.cache[requireSource.resolve("./timer-bound-lock.js")];
    delete require.cache[requireSource.resolve("./transition-lock.js")];

    const runner = requireSource("../runner.js");
    const policy = requireSource("../policy/index.js");
    const agentConfig = requireSource("../sandbox/agent-config.js");
    const registry = requireSource("../state/registry.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");
    const relockReconfirm = requireSource("./relock-reconfirm.js");
    const audit = requireSource("./audit.js");
    const permissiveRuntime = requireSource("./permissive-runtime.js");
    const tempFiles = requireSource("../onboard/temp-files.js");
    const childProcess = requireSource("node:child_process");
    const timerControl = requireSource("./timer-control.js");
    const fakeTimerPid = 4242;
    const permissivePolicyPath = path.join(homeDir, "permissive.yaml");
    fs.writeFileSync(permissivePolicyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });

    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    dockerExecSpy = vi.spyOn(dockerExec, "dockerExecFileSync");
    auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies:\n  test: {}\n");
    vi.spyOn(policy, "buildPolicyGetCommand").mockImplementation((name: unknown) => [
      "policy",
      "get",
      String(name),
    ]);
    vi.spyOn(policy, "buildPolicySetCommand").mockImplementation((file: unknown, name: unknown) => [
      "policy",
      "set",
      String(file),
      String(name),
    ]);
    vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
    vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(permissivePolicyPath);
    vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue(hermesTarget);
    vi.spyOn(registry, "getSandbox").mockImplementation((name: unknown) => ({
      name: String(name),
      agent: "hermes",
      openshellDriver: "docker",
      lifecycleGeneration: "legacy-generation",
      workload: { kind: "managed-image" },
    }));
    vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
      (_sandboxName: unknown, cmd: unknown) => cmd as string[],
    );
    vi.spyOn(stateDirLock, "applyStateDirLockMode").mockReturnValue([]);
    vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]);
    vi.spyOn(stateDirLock, "restoreStateDirLockPosture").mockReturnValue([]);
    vi.spyOn(stateDirLock, "stateLockPlanCompatibilityIssues").mockReturnValue([]);
    vi.spyOn(relockReconfirm, "waitForHermesInferenceRouteConvergence").mockReturnValue({
      ok: true,
      attempts: 1,
      httpStatus: 200,
    });
    vi.spyOn(permissiveRuntime, "buildRuntimePermissivePolicy").mockImplementation(
      (basePath: unknown) => String(basePath),
    );
    vi.spyOn(tempFiles, "cleanupTempDir").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(timerControl, "readProcessStartIdentity").mockImplementation((pid: unknown) =>
      Number(pid) === fakeTimerPid || Number(pid) === process.pid ? "test-start" : null,
    );
    vi.spyOn(timerControl, "isProcessAlive").mockReturnValue(true);
    vi.spyOn(timerControl, "verifyTimerMarkerIdentity").mockReturnValue({ verified: true });
    vi.spyOn(childProcess, "fork").mockImplementation((_module: unknown, args: unknown) => {
      const sandboxName = String((args as unknown[])[0]);
      return {
        pid: fakeTimerPid,
        disconnect: vi.fn(),
        unref: vi.fn(),
        kill: vi.fn(() => true),
        send: vi.fn((message: unknown) => {
          const request = message as { type?: unknown; processToken?: unknown };
          if (request.type === "authorize" && typeof request.processToken === "string") {
            const marker = timerControl.readTimerMarker(sandboxName);
            if (marker?.timerProcessStartIdentity) {
              fs.writeFileSync(
                timerControl.timerAuthorizationProofPath(sandboxName, request.processToken),
                JSON.stringify({
                  schemaVersion: 1,
                  pid: marker.pid,
                  sandboxName,
                  processToken: request.processToken,
                  timerProcessStartIdentity: marker.timerProcessStartIdentity,
                  authoritySha256: timerControl.timerAuthoritySha256(marker),
                }),
                { mode: 0o600 },
              );
            }
          }
          return true;
        }),
      };
    });

    dockerExecSpy.mockImplementation((cmd: string[]) => {
      if (
        cmd[0] === HERMES_PYTHON &&
        cmd.includes("-c") &&
        cmd.at(-1)?.includes("runtime-state-mutation-publisher")
      ) {
        return "absent";
      }
      if (cmd.includes(HERMES_GUARD) && cmd.includes("--help")) return CURRENT_GUARD_HELP;
      if (isGuardAction(cmd, "begin-shields-transition")) {
        return `lock_token=${LOCK_TOKEN} original_locked=1`;
      }
      if (isGuardAction(cmd, "apply-shields-transition")) {
        return "shields_mode=mutable chattr_applied=0";
      }
      if (cmd[0] === "stat") {
        return cmd.at(-1) === "/sandbox/.hermes" ? "3770 sandbox:sandbox" : "640 sandbox:sandbox";
      }
      if (cmd[0] === "sha256sum") return `${"b".repeat(64)}  ${cmd.at(-1)}`;
      if (cmd[0] === "lsattr") return `---------------- ${cmd.at(-1)}`;
      return "";
    });

    shields = requireSource(INDEX_MODULE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function seedLockedState(sandboxName: string): string {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: false,
        chattrApplied: true,
        fileHashes: {
          "/sandbox/.hermes/config.yaml": "b".repeat(64),
          "/sandbox/.hermes/.env": "b".repeat(64),
          "/sandbox/.hermes/.config-hash": "b".repeat(64),
        },
        updatedAt: "2026-08-11T00:00:00.000Z",
      }),
    );
    return stateDir;
  }

  it("rejects a Hermes config symlink before Shields down weakens posture (#8804)", () => {
    const stateDir = seedLockedState("hermes-shields");
    const prior = dockerExecSpy.getMockImplementation();
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      if (isPathPreflight(cmd)) {
        throw new Error("refusing symlink path: /sandbox/.hermes/config.yaml");
      }
      return prior ? prior(cmd) : "";
    });

    expect(() =>
      shields.shieldsDown("hermes-shields", { reason: "unsafe-path", throwOnError: true }),
    ).toThrow(/refusing symlink path: \/sandbox\/\.hermes\/config\.yaml/);

    expect(runSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-hermes-shields.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: false });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-hermes-shields.json"))).toBe(false);
    expect(shields.isShieldsDown("hermes-shields")).toBe(false);
    expect(shields.getShieldsPosture("hermes-shields", false)).toMatchObject({
      locked: true,
      mutable: false,
    });
  });

  it("clears provisional DOWN when unlock fails on an unsafe Hermes config symlink (#8804)", () => {
    const stateDir = seedLockedState("hermes-shields");
    const unsafePathError = new Error("refusing to follow symlink: /sandbox/.hermes/config.yaml");
    const prior = dockerExecSpy.getMockImplementation();
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      if (isPathPreflight(cmd)) return "";
      if (isGuardAction(cmd, "begin-shields-transition")) throw unsafePathError;
      return prior ? prior(cmd) : "";
    });

    expect(() =>
      shields.shieldsDown("hermes-shields", {
        reason: "unsafe-path",
        timeout: "15m",
        throwOnError: true,
      }),
    ).toThrow(/refusing to follow symlink: \/sandbox\/\.hermes\/config\.yaml/);

    expect(
      JSON.parse(fs.readFileSync(path.join(stateDir, "shields-hermes-shields.json"), "utf-8")),
    ).toMatchObject({ shieldsDown: false, chattrApplied: true });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-hermes-shields.json"))).toBe(false);
    expect(auditSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().map(String).join("\n")).toContain(
      "Restrictive policy restored and provisional Shields down cleared",
    );
    expect(shields.isShieldsDown("hermes-shields")).toBe(false);
  });
});
