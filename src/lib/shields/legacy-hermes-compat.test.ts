// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const INDEX_MODULE = "./index.js";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const HERMES_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const LOCK_TOKEN = "a".repeat(64);
const OLD_GUARD_HELP = "usage: guard {ensure-api-key,refresh-hashes,provider-placeholders}";
const PARTIAL_GUARD_HELP = "begin-shields-transition --rollback-shields-mode";
const CURRENT_GUARD_HELP = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
].join(" ");

type ShieldsModule = typeof import("./index");

function hermesTarget() {
  return {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    format: "yaml",
    configFile: "config.yaml",
    sensitiveFiles: ["/sandbox/.hermes/.env", "/sandbox/.hermes/.config-hash"],
  };
}

function commandFromCall(call: unknown[]): string[] {
  return call[0] as string[];
}

function isGuardAction(cmd: string[], action: string): boolean {
  const guardIndex = cmd.indexOf(HERMES_GUARD);
  return guardIndex >= 0 && cmd[guardIndex + 1] === action;
}

function isInlinePython(cmd: string[]): boolean {
  return cmd[0] === "python3" && cmd.includes("-c");
}

function isIsolatedInlinePython(cmd: string[]): boolean {
  return isInlinePython(cmd) && cmd[1] === "-I" && cmd[2] === "-c";
}

describe("legacy Hermes shields compatibility", () => {
  let homeDir: string;
  let shields: ShieldsModule;
  let spies: MockInstance[];
  let runSpy: MockInstance;
  let dockerExecSpy: MockInstance;
  let privilegedExecArgvSpy: MockInstance;
  let applyStateDirLockModeSpy: MockInstance;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-hermes-"));
    vi.stubEnv("HOME", homeDir);
    spies = [];
    delete require.cache[requireSource.resolve(INDEX_MODULE)];

    const runner = requireSource("../runner.js");
    const policy = requireSource("../policy/index.js");
    const config = requireSource("../sandbox/config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");
    const audit = requireSource("./audit.js");
    const permissiveRuntime = requireSource("./permissive-runtime.js");
    const tempFiles = requireSource("../onboard/temp-files.js");

    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    dockerExecSpy = vi.spyOn(dockerExec, "dockerExecFileSync");
    applyStateDirLockModeSpy = vi.spyOn(stateDirLock, "applyStateDirLockMode").mockReturnValue([]);
    privilegedExecArgvSpy = vi
      .spyOn(privilegedExec, "privilegedSandboxExecArgv")
      .mockImplementation((_sandboxName: unknown, cmd: unknown) => cmd as string[]);
    spies.push(
      runSpy,
      vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies:\n  test: {}\n"),
      vi
        .spyOn(policy, "buildPolicyGetCommand")
        .mockImplementation((name: unknown) => ["policy", "get", String(name)]),
      vi
        .spyOn(policy, "buildPolicySetCommand")
        .mockImplementation((file: unknown, name: unknown) => [
          "policy",
          "set",
          String(file),
          String(name),
        ]),
      vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw)),
      vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue("/mock/permissive.yaml"),
      vi.spyOn(config, "resolveAgentConfig").mockImplementation(() => hermesTarget()),
      privilegedExecArgvSpy,
      dockerExecSpy,
      applyStateDirLockModeSpy,
      vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]),
      vi.spyOn(stateDirLock, "restoreStateDirLockPosture").mockReturnValue([]),
      vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined),
      vi
        .spyOn(permissiveRuntime, "buildRuntimePermissivePolicy")
        .mockImplementation((basePath: unknown) => String(basePath)),
      vi.spyOn(tempFiles, "cleanupTempDir").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
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

  function installExecResponses(help: string): void {
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (true) {
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return help;
        case isGuardAction(cmd, "begin-shields-transition"):
          return `lock_token=${LOCK_TOKEN} original_locked=1`;
        case isGuardAction(cmd, "apply-shields-transition"):
          return "shields_mode=mutable chattr_applied=0";
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox/.hermes" ? "3770 sandbox:sandbox" : "640 sandbox:sandbox";
        case cmd[0] === "lsattr":
          return `---------------- ${cmd.at(-1)}`;
        default:
          return "";
      }
    });
  }

  it("rejects ordinary shields-down against an old guard before policy or state mutation", () => {
    installExecResponses(OLD_GUARD_HELP);

    expect(() =>
      shields.shieldsDown("legacy-hermes", {
        skipTimer: true,
        throwOnError: true,
      }),
    ).toThrow(/predates sealed shields transitions|rebuild/i);

    expect(runSpy).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(homeDir, ".nemoclaw", "state", "shields-legacy-hermes.json")),
    ).toBe(false);
    expect(dockerExecSpy.mock.calls.some((call) => commandFromCall(call)[0] === "python3")).toBe(
      false,
    );
  });

  it("rejects ordinary shields-up against an old guard before restoring policy", () => {
    installExecResponses(OLD_GUARD_HELP);
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-legacy-hermes.json"),
      JSON.stringify({
        shieldsDown: true,
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: "2026-06-27T00:00:00.000Z",
      }),
    );
    const originalState = fs.readFileSync(
      path.join(stateDir, "shields-legacy-hermes.json"),
      "utf-8",
    );

    expect(() => shields.shieldsUp("legacy-hermes", { throwOnError: true })).toThrow(
      /predates sealed shields transitions|rebuild/i,
    );

    expect(runSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(stateDir, "shields-legacy-hermes.json"), "utf-8")).toBe(
      originalState,
    );
  });

  it("requires the complete sealed transaction contract before selecting it", () => {
    installExecResponses(PARTIAL_GUARD_HELP);

    expect(() =>
      shields.shieldsDown("partial-hermes", {
        skipTimer: true,
        throwOnError: true,
      }),
    ).toThrow(/predates sealed shields transitions|incomplete|rebuild/i);

    expect(runSpy).not.toHaveBeenCalled();
    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(false);
  });

  it("permits only an explicitly authorized legacy path to use the descriptor-safe top-level unlock", () => {
    installExecResponses(OLD_GUARD_HELP);

    expect(() =>
      shields.unlockAgentConfig("legacy-hermes", hermesTarget(), true, true),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    const descriptorUnlock = commands.find(isIsolatedInlinePython);
    expect(descriptorUnlock?.join(" ")).toContain("O_NOFOLLOW");
    expect(descriptorUnlock?.[3]).toContain("strict hash verification failed");
    expect(descriptorUnlock?.[3]).toContain("compat hash verification failed");
    expect(descriptorUnlock?.[3]).toMatch(/os\.(?:replace|rename)\(/);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(false);
  });

  it("fails a partial recursive unlock and restores the trusted legacy posture", () => {
    installExecResponses(OLD_GUARD_HELP);
    applyStateDirLockModeSpy.mockReturnValueOnce(["recursive unlock failed"]);

    expect(() => shields.unlockAgentConfig("legacy-hermes", hermesTarget(), true, true)).toThrow(
      /recursive unlock failed/,
    );

    const legacyTransitions = dockerExecSpy.mock.calls
      .map(commandFromCall)
      .filter(isIsolatedInlinePython)
      .map((cmd) => cmd[4]);
    expect(legacyTransitions).toEqual(["unlock", "lock"]);
  });

  it("uses the sealed transaction when the installed guard supports the complete contract", () => {
    installExecResponses(CURRENT_GUARD_HELP);

    expect(() =>
      shields.unlockAgentConfig("current-hermes", hermesTarget(), true, true),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(true);
    expect(
      commands.some(
        (cmd) =>
          isGuardAction(cmd, "run-state-dir-transition") &&
          cmd.includes("--state-action") &&
          cmd.includes("unlock") &&
          cmd.includes(LOCK_TOKEN),
      ),
    ).toBe(true);
    expect(commands.some((cmd) => isGuardAction(cmd, "apply-shields-transition"))).toBe(true);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(true);
    expect(commands.some(isInlinePython)).toBe(false);
  });

  it("isolates Hermes guard Python and scrubs every privileged shields exec", () => {
    installExecResponses(CURRENT_GUARD_HELP);

    expect(() =>
      shields.unlockAgentConfig("current-hermes", hermesTarget(), true, true),
    ).not.toThrow();

    const guardCommands = dockerExecSpy.mock.calls
      .map(commandFromCall)
      .filter((cmd) => cmd.includes(HERMES_GUARD));
    expect(guardCommands.length).toBeGreaterThan(0);
    for (const command of guardCommands) {
      const pythonIndex = command.indexOf(HERMES_PYTHON);
      expect(pythonIndex).toBeGreaterThanOrEqual(0);
      expect(command[pythonIndex + 1]).toBe("-I");
      expect(command[pythonIndex + 2]).toBe(HERMES_GUARD);
    }
    expect(privilegedExecArgvSpy).toHaveBeenCalled();
    for (const call of privilegedExecArgvSpy.mock.calls) {
      expect(call[3]).toBe(true);
    }
  });

  it("pins one capability decision across policy and config mutation", () => {
    installExecResponses(CURRENT_GUARD_HELP);

    expect(() =>
      shields.shieldsDown("current-hermes", {
        skipTimer: true,
        throwOnError: true,
      }),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(
      commands.filter((cmd) => cmd.includes(HERMES_GUARD) && cmd.includes("--help")),
    ).toHaveLength(1);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(true);
  });

  it("descriptor-safely protects and verifies the sandbox parent when a failed rebuild relocks an old image", () => {
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (true) {
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return OLD_GUARD_HELP;
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox"
            ? "1775 root:sandbox"
            : cmd.at(-1) === "/sandbox/.hermes"
              ? "755 root:root"
              : "444 root:root";
        case cmd[0] === "lsattr":
          return `----i----------- ${cmd.at(-1)}`;
        case cmd[0] === "sha256sum":
          return `${"b".repeat(64)}  ${cmd.at(-1)}`;
        default:
          return "";
      }
    });

    expect(() =>
      shields.lockAgentConfig("legacy-hermes", hermesTarget(), false, true),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    const descriptorLock = commands.find(
      (cmd) =>
        cmd[0] === "python3" &&
        cmd[1] === "-I" &&
        cmd[2] === "-c" &&
        cmd[3]?.includes("O_NOFOLLOW") &&
        cmd[3]?.includes("0o1775"),
    );
    expect(descriptorLock).toBeDefined();
    expect(descriptorLock?.[3]).toContain("strict hash verification failed");
    expect(descriptorLock?.[3]).toContain("compat hash verification failed");
    expect(descriptorLock?.[3]).toMatch(/os\.(?:replace|rename)\(/);
    expect(commands.some((cmd) => cmd[0] === "stat" && cmd.at(-1) === "/sandbox")).toBe(true);
  });

  it("refuses to report a legacy relock when sandbox parent protection did not hold", () => {
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (true) {
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return OLD_GUARD_HELP;
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox"
            ? "755 sandbox:sandbox"
            : cmd.at(-1) === "/sandbox/.hermes"
              ? "755 root:root"
              : "444 root:root";
        case cmd[0] === "lsattr":
          return `----i----------- ${cmd.at(-1)}`;
        case cmd[0] === "sha256sum":
          return `${"b".repeat(64)}  ${cmd.at(-1)}`;
        default:
          return "";
      }
    });

    expect(() => shields.lockAgentConfig("legacy-hermes", hermesTarget(), false, true)).toThrow(
      /parent dir|1775|root:sandbox/i,
    );
  });

  it("does not reinterpret a failed capability probe as permission to use the legacy path", () => {
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (cmd.includes(HERMES_GUARD) && cmd.includes("--help")) {
        case true:
          throw new Error("temporary Docker exec failure");
        default:
          return "";
      }
    });

    expect(() =>
      shields.unlockAgentConfig("unreachable-hermes", hermesTarget(), true, true),
    ).toThrow(/temporary Docker exec failure|capability/i);

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some(isInlinePython)).toBe(false);
    expect(applyStateDirLockModeSpy).not.toHaveBeenCalled();
  });
});
