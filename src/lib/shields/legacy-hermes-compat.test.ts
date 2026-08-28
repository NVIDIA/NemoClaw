// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  HERMES_PROVIDER_CAPABILITY_PATH as CAPABILITY_PATH,
  createFailingCapabilityProbeResponse,
  createHermesShieldsProviderConsumerHarness,
  createRetainedUnlockSimulation,
  createTimerAuthorizationSender,
  createTransitionFailureForPosture,
  hermesProviderConsumerSandbox as sandbox,
  hermesProviderConsumerTarget as target,
  writeBoundForwardPolicy,
  writeBoundPolicySnapshot,
  writeTimerAuthorizationProof,
} from "../../../test/helpers/hermes-shields-provider-consumer-harness";
import * as shieldsFlow from "../../../test/helpers/shields-flow-harness";

import { testTimeout } from "../../../test/helpers/timeouts";

const requireSource = createRequire(import.meta.url);
const INDEX_MODULE = "./index.js";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const HERMES_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const RUNTIME_STATE_MUTATION_CAPABILITY =
  "/usr/local/share/nemoclaw/runtime-state-mutation-publisher-v1.json";
const LOCK_TOKEN = "a".repeat(64);
const OLD_GUARD_HELP = "usage: guard {ensure-api-key,refresh-hashes,provider-placeholders}";
const PARTIAL_GUARD_HELP = "begin-shields-transition --rollback-shields-mode";
const PREVIOUS_SEALED_GUARD_HELP = [
  "begin-shields-transition",
  "run-state-dir-transition",
  "apply-shields-transition",
  "finish-shields-transition",
  "prepare-shields-abort",
  "abort-shields-transition",
  "--rollback-shields-mode",
  "ensure-api-key",
  "refresh-hashes",
  "provider-placeholders",
].join(" ");
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

type ShieldsModule = typeof import("./index");

const STATE_LOCK_PLAN = {
  version: 1 as const,
  readOnlyRoots: ["skills"],
  confidentialRoots: ["pairing"],
  readOnlyPrefixes: [],
  confidentialPrefixes: [],
  writableSubpaths: [],
};

function hermesTarget() {
  return {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    format: "yaml",
    configFile: "config.yaml",
    sensitiveFiles: ["/sandbox/.hermes/.env", "/sandbox/.hermes/.config-hash"],
    stateLockPlan: STATE_LOCK_PLAN,
    stateLockPlanInImage: true,
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

function isRuntimeStateMutationCapabilityProbe(cmd: string[]): boolean {
  return (
    cmd[0] === HERMES_PYTHON &&
    cmd[1] === "-I" &&
    cmd[2] === "-c" &&
    cmd[3]?.includes("os.lstat") === true &&
    cmd.at(-1) === RUNTIME_STATE_MUTATION_CAPABILITY
  );
}

type ForwardPolicyFailureSetup = (input: {
  readonly forwardPolicyPath: string;
  readonly routeSpy: MockInstance;
  readonly timerPath: string;
}) => void;

type ForwardPolicyFailureAssertion = (input: {
  readonly routeSpy: MockInstance;
  readonly runSpy: MockInstance;
  readonly transitionPath: string;
  readonly transitionSpy: MockInstance;
}) => void;

function removeForwardPolicy({
  forwardPolicyPath,
}: Parameters<ForwardPolicyFailureSetup>[0]): void {
  fs.rmSync(forwardPolicyPath);
}

function tamperForwardPolicy({
  forwardPolicyPath,
}: Parameters<ForwardPolicyFailureSetup>[0]): void {
  fs.writeFileSync(forwardPolicyPath, "tampered\n", { mode: 0o600 });
}

function replaceTimerDuringRoute({
  routeSpy,
  timerPath,
}: Parameters<ForwardPolicyFailureSetup>[0]): void {
  routeSpy.mockImplementation(() => {
    const marker = JSON.parse(fs.readFileSync(timerPath, "utf-8"));
    fs.writeFileSync(
      timerPath,
      JSON.stringify({ ...marker, timerProcessStartIdentity: "replacement-timer-start" }),
    );
    return { ok: true, attempts: 1, httpStatus: 200 };
  });
}

function expectForwardPolicyRejectedBeforeMutation({
  routeSpy,
  runSpy,
  transitionSpy,
}: Parameters<ForwardPolicyFailureAssertion>[0]): void {
  expect(runSpy).not.toHaveBeenCalled();
  expect(transitionSpy).not.toHaveBeenCalled();
  expect(routeSpy).not.toHaveBeenCalled();
}

function expectTimerReplacementRejectedAfterMutation({
  routeSpy,
  runSpy,
  transitionPath,
  transitionSpy,
}: Parameters<ForwardPolicyFailureAssertion>[0]): void {
  expect(runSpy).toHaveBeenCalled();
  expect(transitionSpy).toHaveBeenCalled();
  expect(routeSpy).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(transitionPath)).toBe(true);
}

const forwardPolicyFailureFixtures: ReadonlyArray<
  readonly [string, ForwardPolicyFailureSetup, RegExp, ForwardPolicyFailureAssertion]
> = [
  ["missing", removeForwardPolicy, /forward policy/u, expectForwardPolicyRejectedBeforeMutation],
  ["tampered", tamperForwardPolicy, /forward policy/u, expectForwardPolicyRejectedBeforeMutation],
  [
    "timer-replaced",
    replaceTimerDuringRoute,
    /auto-restore authority changed|timer generation/iu,
    expectTimerReplacementRejectedAfterMutation,
  ],
];

describe("legacy Hermes shields compatibility", () => {
  let homeDir: string;
  let shields: ShieldsModule;
  let spies: MockInstance[];
  let runSpy: MockInstance;
  let dockerExecSpy: MockInstance;
  let privilegedExecArgvSpy: MockInstance;
  let applyStateDirLockModeSpy: MockInstance;
  let inferenceConvergenceSpy: MockInstance;
  let auditSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-hermes-"));
    vi.stubEnv("HOME", homeDir);
    spies = [];
    delete require.cache[requireSource.resolve(INDEX_MODULE)];

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
    const readProcessStartIdentity = timerControl.readProcessStartIdentity;
    const isProcessAlive = timerControl.isProcessAlive;
    const verifyTimerMarkerIdentity = timerControl.verifyTimerMarkerIdentity;
    const fakeTimerPid = 4242;
    const permissivePolicyPath = path.join(homeDir, "permissive.yaml");
    fs.writeFileSync(permissivePolicyPath, "version: 1\nnetwork_policies: {}\n", {
      mode: 0o600,
    });

    runSpy = vi.spyOn(runner, "run").mockReturnValue({ status: 0 });
    dockerExecSpy = vi.spyOn(dockerExec, "dockerExecFileSync");
    applyStateDirLockModeSpy = vi.spyOn(stateDirLock, "applyStateDirLockMode").mockReturnValue([]);
    privilegedExecArgvSpy = vi
      .spyOn(privilegedExec, "privilegedSandboxExecArgv")
      .mockImplementation((_sandboxName: unknown, cmd: unknown) => cmd as string[]);
    inferenceConvergenceSpy = vi
      .spyOn(relockReconfirm, "waitForHermesInferenceRouteConvergence")
      .mockReturnValue({
        ok: true,
        attempts: 1,
        httpStatus: 200,
      });
    auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(permissivePolicyPath),
      ...shieldsFlow.bindLivePolicyMutationContext(policy),
      vi.spyOn(agentConfig, "resolveAgentConfig").mockImplementation(() => hermesTarget()),
      vi.spyOn(registry, "getSandbox").mockImplementation((name: unknown) => ({
        name: String(name),
        agent: "hermes",
        openshellDriver: "docker",
        lifecycleGeneration: "legacy-generation",
        workload: { kind: "managed-image" },
      })),
      privilegedExecArgvSpy,
      dockerExecSpy,
      applyStateDirLockModeSpy,
      vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]),
      vi.spyOn(stateDirLock, "restoreStateDirLockPosture").mockReturnValue([]),
      vi.spyOn(stateDirLock, "stateLockPlanCompatibilityIssues").mockReturnValue([]),
      inferenceConvergenceSpy,
      auditSpy,
      vi
        .spyOn(permissiveRuntime, "buildRuntimePermissivePolicy")
        .mockImplementation((basePath: unknown) => String(basePath)),
      vi.spyOn(tempFiles, "cleanupTempDir").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      errorSpy,
      vi
        .spyOn(timerControl, "readProcessStartIdentity")
        .mockImplementation((pidValue: unknown) =>
          Number(pidValue) === fakeTimerPid
            ? "legacy-fake-timer-start"
            : readProcessStartIdentity(Number(pidValue)),
        ),
      vi
        .spyOn(timerControl, "isProcessAlive")
        .mockImplementation((pidValue: unknown) =>
          Number(pidValue) === fakeTimerPid ? true : isProcessAlive(Number(pidValue)),
        ),
      vi
        .spyOn(timerControl, "verifyTimerMarkerIdentity")
        .mockImplementation((markerValue: unknown) => {
          const marker = markerValue as import("./timer-control").TimerMarker;
          return marker.pid === fakeTimerPid
            ? { verified: true }
            : verifyTimerMarkerIdentity(marker);
        }),
      vi.spyOn(childProcess, "fork").mockImplementation((_modulePath: unknown, args: unknown) => {
        const sandboxName = String((args as unknown[])[0]);
        return {
          pid: fakeTimerPid,
          disconnect: vi.fn(),
          unref: vi.fn(),
          kill: vi.fn(() => true),
          send: vi.fn(createTimerAuthorizationSender(requireSource, sandboxName)),
        };
      }),
    );

    shields = requireSource(INDEX_MODULE);
  }, testTimeout(60_000));

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function installExecResponses(
    help: string,
    hermesDirMode = "3770",
    finishError?: Error,
    simulateLockTransition = false,
  ): void {
    let pendingMode: "locked" | "mutable" = "mutable";
    let appliedMode: "locked" | "mutable" = "mutable";
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (true) {
        case isRuntimeStateMutationCapabilityProbe(cmd):
          return "absent";
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return help;
        case isGuardAction(cmd, "begin-shields-transition"): {
          const modeIndex = cmd.indexOf("--shields-mode");
          const mode = modeIndex >= 0 ? cmd[modeIndex + 1] : undefined;
          switch (mode) {
            case "locked":
            case "mutable":
              pendingMode = mode;
              break;
            default:
              throw new Error("Invalid --shields-mode in test fixture");
          }
          return `lock_token=${LOCK_TOKEN} original_locked=1`;
        }
        case isGuardAction(cmd, "apply-shields-transition"):
          appliedMode = pendingMode;
          return `shields_mode=${appliedMode} chattr_applied=0`;
        case isGuardAction(cmd, "finish-shields-transition") && finishError !== undefined:
          throw finishError;
        case cmd[0] === "stat" && simulateLockTransition && appliedMode === "locked":
          return cmd.at(-1) === "/sandbox/.hermes"
            ? "3770 root:sandbox"
            : cmd.at(-1) === "/sandbox"
              ? "1775 root:sandbox"
              : "444 root:root";
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox/.hermes"
            ? `${hermesDirMode} sandbox:sandbox`
            : "640 sandbox:sandbox";
        case cmd[0] === "sha256sum":
          return `${"b".repeat(64)}  ${cmd.at(-1)}`;
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
          cmd.includes("--state-lock-plan-json") &&
          cmd.includes(JSON.stringify(STATE_LOCK_PLAN)) &&
          cmd.includes(LOCK_TOKEN),
      ),
    ).toBe(true);
    expect(commands.some((cmd) => isGuardAction(cmd, "apply-shields-transition"))).toBe(true);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(true);
    expect(commands.some(isInlinePython)).toBe(false);
  });

  it("keeps the immediately previous sealed protocol token-owned without sending a plan argument", () => {
    installExecResponses(PREVIOUS_SEALED_GUARD_HELP);

    expect(() =>
      shields.unlockAgentConfig("previous-hermes", hermesTarget(), true, true),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(true);
    const transition = commands.find((cmd) => isGuardAction(cmd, "run-state-dir-transition"));
    expect(transition).toEqual(expect.arrayContaining(["--state-action", "unlock", LOCK_TOKEN]));
    expect(transition).not.toContain("--state-lock-plan-json");
    expect(commands.some((cmd) => isGuardAction(cmd, "apply-shields-transition"))).toBe(true);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(true);
    expect(commands.some(isInlinePython)).toBe(false);
  });

  it("delegates a private Hermes root to the sealed guard before completing unlock", () => {
    installExecResponses(CURRENT_GUARD_HELP, "700");

    expect(() =>
      shields.unlockAgentConfig("current-hermes", hermesTarget(), true, true),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(true);
  });

  it("rolls back when the sealed guard cannot attest a private Hermes root", () => {
    installExecResponses(
      CURRENT_GUARD_HELP,
      "700",
      new Error("private mutable .hermes lacks an attested same-UID topology"),
    );

    expect(() => shields.unlockAgentConfig("current-hermes", hermesTarget(), true, true)).toThrow(
      /attested same-UID topology/,
    );

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(true);
    const prepareIndex = commands.findIndex((cmd) => isGuardAction(cmd, "prepare-shields-abort"));
    const restoreIndex = commands.findIndex(
      (cmd) =>
        isGuardAction(cmd, "run-state-dir-transition") &&
        cmd.includes("--state-action") &&
        cmd.includes("lock"),
    );
    const abortIndex = commands.findIndex((cmd) => isGuardAction(cmd, "abort-shields-transition"));
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(prepareIndex);
    expect(abortIndex).toBeGreaterThan(restoreIndex);
  });

  it("rejects other sandbox-owned Hermes root modes before finishing a sealed unlock", () => {
    installExecResponses(CURRENT_GUARD_HELP, "750");

    expect(() => shields.unlockAgentConfig("current-hermes", hermesTarget(), true, true)).toThrow(
      /config dir mode/,
    );

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some((cmd) => isGuardAction(cmd, "finish-shields-transition"))).toBe(false);
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
    expect(
      guardCommands.every((command) => {
        const pythonIndex = command.indexOf(HERMES_PYTHON);
        return (
          pythonIndex >= 0 &&
          command[pythonIndex + 1] === "-I" &&
          command[pythonIndex + 2] === HERMES_GUARD
        );
      }),
    ).toBe(true);
    expect(privilegedExecArgvSpy).toHaveBeenCalled();
    expect(privilegedExecArgvSpy.mock.calls.every((call) => call[3] === true)).toBe(true);
  });

  it("pins one capability decision across policy and config mutation", () => {
    installExecResponses(CURRENT_GUARD_HELP);

    expect(() =>
      shields.shieldsDown("current-hermes", {
        throwOnError: true,
      }),
    ).not.toThrow();

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(
      commands.filter((cmd) => cmd.includes(HERMES_GUARD) && cmd.includes("--help")),
    ).toHaveLength(1);
    expect(commands.some((cmd) => isGuardAction(cmd, "begin-shields-transition"))).toBe(true);
  });

  it.each([401, 403, 404])(
    "rolls back Shields down when Hermes returns unusable HTTP %i",
    (httpStatus) => {
      installExecResponses(CURRENT_GUARD_HELP, "3770", undefined, true);
      inferenceConvergenceSpy.mockReturnValue({
        ok: false,
        attempts: 4,
        httpStatus,
      });

      expect(() =>
        shields.shieldsDown("current-hermes", {
          throwOnError: true,
        }),
      ).toThrow(
        new RegExp(`inference route did not converge.*HTTP ${String(httpStatus)}.*4 attempts`, "i"),
      );

      const errors = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain(
        "Recover the Hermes inference route, then re-run `nemoclaw current-hermes shields down`.",
      );
      expect(errors).not.toContain("after correcting file ownership");
      const stateDir = path.join(homeDir, ".nemoclaw", "state");
      const state = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-current-hermes.json"), "utf-8"),
      );
      expect(state).toMatchObject({ shieldsDown: false });
      expect(
        fs.readdirSync(stateDir).filter((entry) => entry.startsWith("shields-transition-")),
      ).toEqual([]);
      expect(auditSpy).not.toHaveBeenCalled();
    },
  );

  it("descriptor-safely protects and verifies the sandbox parent when a failed rebuild relocks an old image", () => {
    dockerExecSpy.mockImplementation((cmd: string[]) => {
      switch (true) {
        case isRuntimeStateMutationCapabilityProbe(cmd):
          return "absent";
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return OLD_GUARD_HELP;
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox"
            ? "1775 root:sandbox"
            : cmd.at(-1) === "/sandbox/.hermes"
              ? "3770 root:sandbox"
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
        case isRuntimeStateMutationCapabilityProbe(cmd):
          return "absent";
        case cmd.includes(HERMES_GUARD) && cmd.includes("--help"):
          return OLD_GUARD_HELP;
        case cmd[0] === "stat":
          return cmd.at(-1) === "/sandbox"
            ? "755 sandbox:sandbox"
            : cmd.at(-1) === "/sandbox/.hermes"
              ? "3770 root:sandbox"
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
    dockerExecSpy.mockImplementation(
      createFailingCapabilityProbeResponse(
        isRuntimeStateMutationCapabilityProbe,
        new Error("temporary Docker exec failure"),
      ),
    );

    expect(() =>
      shields.unlockAgentConfig("unreachable-hermes", hermesTarget(), true, true),
    ).toThrow(/temporary Docker exec failure|capability/i);

    const commands = dockerExecSpy.mock.calls.map(commandFromCall);
    expect(commands.some(isInlinePython)).toBe(false);
    expect(commands.some((cmd) => cmd.includes(HERMES_GUARD) && cmd.includes("--help"))).toBe(
      false,
    );
    expect(applyStateDirLockModeSpy).not.toHaveBeenCalled();
  });
});

{
  describe("Hermes Shields runtime-provider consumer", () => {
    let harness: ReturnType<typeof createHermesShieldsProviderConsumerHarness>;
    let spies: MockInstance[];
    let transitionSpy: MockInstance;
    let runSpy: MockInstance;
    let supportSpy: MockInstance;
    let lifecycleGateSpy: MockInstance;
    let dockerExecSpy: MockInstance;
    let registrySpy: MockInstance;
    let verifyLockSpy: MockInstance;
    let routeSpy: MockInstance;
    let auditSpy: MockInstance;
    let runCaptureSpy: MockInstance;
    let commands: string[][];
    let capabilityProbe: { error: Error | null; presence: string };
    let shields: typeof import("./index");

    beforeEach(() => {
      harness = createHermesShieldsProviderConsumerHarness(requireSource);
      ({
        auditSpy,
        capabilityProbe,
        commands,
        dockerExecSpy,
        lifecycleGateSpy,
        registrySpy,
        routeSpy,
        runCaptureSpy,
        runSpy,
        shields,
        spies,
        supportSpy,
        transitionSpy,
        verifyLockSpy,
      } = harness);
    });

    afterEach(() => {
      harness.cleanup();
    });

    it("migrates the current managed Hermes unlock leaf to the provider transaction", () => {
      shields.unlockAgentConfig(sandbox.name, target, true, false);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandbox,
          sandboxName: sandbox.name,
          configTarget: target,
          target: "mutable",
          rollback: "locked",
        }),
      );
      expect(commands.some((command) => command.includes("begin-shields-transition"))).toBe(false);
      expect(commands.some((command) => command.includes("run-state-dir-transition"))).toBe(false);
    });

    it("treats a fresh mutable-default provider unlock as recovery plus live verification", () => {
      shields.unlockAgentConfig(sandbox.name, target, false, false);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandbox,
          sandboxName: sandbox.name,
          configTarget: target,
          target: "mutable",
          rollback: "mutable",
        }),
      );
      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(commands.some((command) => command.includes("begin-shields-transition"))).toBe(false);
    });

    it("migrates the current managed Hermes lock leaf and preserves the host seal result", () => {
      const result = shields.lockAgentConfig(sandbox.name, target, false, false);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandbox,
          sandboxName: sandbox.name,
          configTarget: target,
          target: "locked",
          rollback: "mutable",
        }),
      );
      expect(result.fileHashes).toEqual({
        "/sandbox/.hermes/config.yaml": "c".repeat(64),
        "/sandbox/.hermes/.env": "c".repeat(64),
        "/sandbox/.hermes/.config-hash": "c".repeat(64),
      });
      expect(commands.some((command) => command.includes("begin-shields-transition"))).toBe(false);
    });

    it("treats an already-locked provider lock as recovery plus live verification", () => {
      const result = shields.lockAgentConfig(sandbox.name, target, true, false);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandbox,
          sandboxName: sandbox.name,
          configTarget: target,
          target: "locked",
          rollback: "locked",
        }),
      );
      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(result.fileHashes).toEqual({
        "/sandbox/.hermes/config.yaml": "c".repeat(64),
        "/sandbox/.hermes/.env": "c".repeat(64),
        "/sandbox/.hermes/.config-hash": "c".repeat(64),
      });
    });

    it.each([
      "provider:mutable/locked",
      "verified-mutable",
      "policy",
      "provider:locked/locked",
      "route",
      "audit",
    ])(
      "completes a timed retained unlock once and leaves its retry side effects idempotent [%s]",
      (event) => {
        const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
        const stateDir = statePaths.resolveNemoclawStateDir();
        const processToken = "d".repeat(32);
        const snapshotPath = path.join(stateDir, "shields-policy-before-provider-crash.yaml");
        const timerPath = path.join(stateDir, `shields-timer-${sandbox.name}.json`);
        const transitionPath = path.join(
          stateDir,
          `shields-transition-${sandbox.name}-${processToken}.json`,
        );
        fs.mkdirSync(path.join(stateDir, "runtime-provider-lifecycle"), {
          recursive: true,
          mode: 0o700,
        });
        const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
        const forwardPolicy = writeBoundForwardPolicy(stateDir, sandbox.name, processToken);
        fs.writeFileSync(
          path.join(stateDir, `shields-${sandbox.name}.json`),
          JSON.stringify({
            shieldsDown: true,
            shieldsDownAt: "2026-08-09T00:00:00.000Z",
            shieldsDownTimeout: 300,
            shieldsDownReason: "crash retry",
            shieldsDownPolicy: "permissive",
            shieldsPolicySnapshotPath: snapshotPath, shieldsPolicySnapshot: snapshotPolicy,
          }),
        );
        fs.writeFileSync(
          timerPath,
          JSON.stringify({
            pid: 4242,
            sandboxName: sandbox.name,
            snapshotPath,
            restoreAt: new Date(Date.now() + 60_000).toISOString(),
            processToken,
            timerProcessStartIdentity: "live-timer-start",
            allowLegacyHermesProtocol: false,
            agentName: "hermes",
            configPath: target.configPath,
            configDir: target.configDir,
          }),
        );
        writeTimerAuthorizationProof(requireSource, sandbox.name);
        fs.writeFileSync(
          transitionPath,
          JSON.stringify({
            version: 1,
            phase: "preparing",
            ownerPid: 4242,
            ownerStartIdentity: "dead-provider-owner",
            processToken,
            sandboxName: sandbox.name,
            snapshotPath, snapshotPolicy,
            forwardPolicy,
          }),
        );
        const events: string[] = [];
        const simulation = createRetainedUnlockSimulation(events, commands);
        runSpy.mockImplementation(simulation.run);
        lifecycleGateSpy.mockImplementation(simulation.hasActiveClaim);
        transitionSpy.mockImplementation(simulation.transition);
        dockerExecSpy.mockImplementation(simulation.dockerExec);
        routeSpy.mockImplementation(() => {
          expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("preparing");
          events.push("route");
          return { ok: true, attempts: 1, httpStatus: 200 };
        });
        auditSpy.mockImplementation(() => {
          expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("active");
          events.push("audit");
        });

        shields.shieldsDown(sandbox.name, { timeout: "not-a-duration", throwOnError: true });

        expect(
          transitionSpy.mock.calls.map(([input]) => ({
            target: (input as { target: string }).target,
            rollback: (input as { rollback: string }).rollback,
          })),
        ).toEqual([
          { target: "locked", rollback: "locked" },
          { target: "mutable", rollback: "mutable" },
          { target: "mutable", rollback: "locked" },
        ]);
        expect(simulation.livePosture()).toBe("mutable");
        expect(simulation.activeClaim()).toBe(false);
        expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("active");
        expect(
          JSON.parse(fs.readFileSync(path.join(stateDir, `shields-${sandbox.name}.json`), "utf-8")),
        ).toMatchObject({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath });

        expect(events).toContain(event);

        expect(events.indexOf("provider:mutable/locked")).toBeLessThan(
          events.indexOf("verified-mutable"),
        );
        expect(events.indexOf("policy")).toBeLessThan(events.indexOf("provider:locked/locked"));
        expect(events.indexOf("verified-mutable")).toBeLessThan(events.indexOf("route"));
        expect(events.indexOf("route")).toBeLessThan(events.indexOf("audit"));
        expect(routeSpy).toHaveBeenCalledTimes(1);
        expect(auditSpy).toHaveBeenCalledWith({
          action: "shields_down",
          sandbox: sandbox.name,
          timestamp: "2026-08-09T00:00:00.000Z",
          timeout_seconds: 300,
          reason: "crash retry",
          policy_applied: "permissive",
          policy_snapshot: snapshotPath,
        });
        expect(auditSpy).toHaveBeenCalledTimes(1);
        expect(transitionSpy.mock.invocationCallOrder[0]).toBeLessThan(
          dockerExecSpy.mock.invocationCallOrder[0] as number,
        );
        expect(commands.some((command) => command.includes(CAPABILITY_PATH))).toBe(false);
        expect(commands.some((command) => command.includes("--help"))).toBe(false);

        expect(() => shields.shieldsDown(sandbox.name, { throwOnError: true })).toThrow(
          /already unlocked/u,
        );
        expect(routeSpy).toHaveBeenCalledTimes(1);
        expect(auditSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("active");
      },
    );

    it("completes timed DOWN bookkeeping after provider release removed the durable claim", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const stateDir = statePaths.resolveNemoclawStateDir();
      const processToken = "e".repeat(32);
      const snapshotPath = path.join(stateDir, "shields-policy-after-provider-release.yaml");
      const transitionPath = path.join(
        stateDir,
        `shields-transition-${sandbox.name}-${processToken}.json`,
      );
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
      const forwardPolicy = writeBoundForwardPolicy(stateDir, sandbox.name, processToken);
      fs.writeFileSync(
        path.join(stateDir, `shields-${sandbox.name}.json`),
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: "2026-08-09T00:05:00.000Z",
          shieldsDownTimeout: 300,
          shieldsDownReason: "post-release crash",
          shieldsDownPolicy: "permissive",
          shieldsPolicySnapshotPath: snapshotPath, shieldsPolicySnapshot: snapshotPolicy,
        }),
      );
      fs.writeFileSync(
        path.join(stateDir, `shields-timer-${sandbox.name}.json`),
        JSON.stringify({
          pid: 4343,
          sandboxName: sandbox.name,
          snapshotPath,
          restoreAt: new Date(Date.now() + 60_000).toISOString(),
          processToken,
          timerProcessStartIdentity: "live-timer-start",
          allowLegacyHermesProtocol: false,
          agentName: "hermes",
          configPath: target.configPath,
          configDir: target.configDir,
        }),
      );
      writeTimerAuthorizationProof(requireSource, sandbox.name);
      fs.writeFileSync(
        transitionPath,
        JSON.stringify({
          version: 1,
          phase: "preparing",
          ownerPid: 4343,
          ownerStartIdentity: "dead-post-release-owner",
          processToken,
          sandboxName: sandbox.name,
          snapshotPath, snapshotPolicy,
          forwardPolicy,
        }),
      );
      lifecycleGateSpy.mockReturnValue(false);
      transitionSpy.mockReturnValue(null);
      routeSpy.mockImplementation(() => {
        expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("preparing");
        return { ok: true, attempts: 1, httpStatus: 200 };
      });
      auditSpy.mockImplementation(() => {
        expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("active");
      });

      shields.shieldsDown(sandbox.name, { throwOnError: true });

      expect(supportSpy).toHaveBeenCalledTimes(1);
      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "mutable", rollback: "mutable" }),
      );
      expect(routeSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledWith({
        action: "shields_down",
        sandbox: sandbox.name,
        timestamp: "2026-08-09T00:05:00.000Z",
        timeout_seconds: 300,
        reason: "post-release crash",
        policy_applied: "permissive",
        policy_snapshot: snapshotPath,
      });
      expect(JSON.parse(fs.readFileSync(transitionPath, "utf-8")).phase).toBe("active");
    });

    it.each(forwardPolicyFailureFixtures)(
      "fails closed when the recovered forward policy is %s",
      (_failureMode, arrangeFailure, expectedError, assertSideEffects) => {
        const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
        const stateDir = statePaths.resolveNemoclawStateDir();
        const processToken = "f".repeat(32);
        const snapshotPath = path.join(stateDir, "shields-policy-invalid-forward.yaml");
        const transitionPath = path.join(
          stateDir,
          `shields-transition-${sandbox.name}-${processToken}.json`,
        );
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
        const forwardPolicy = writeBoundForwardPolicy(stateDir, sandbox.name, processToken);
        fs.writeFileSync(
          path.join(stateDir, `shields-${sandbox.name}.json`),
          JSON.stringify({
            shieldsDown: true,
            shieldsDownAt: new Date().toISOString(),
            shieldsDownTimeout: 300,
            shieldsDownReason: "invalid forward policy",
            shieldsDownPolicy: "permissive",
            shieldsPolicySnapshotPath: snapshotPath, shieldsPolicySnapshot: snapshotPolicy,
          }),
        );
        const timerPath = path.join(stateDir, `shields-timer-${sandbox.name}.json`);
        fs.writeFileSync(
          timerPath,
          JSON.stringify({
            pid: 4444,
            sandboxName: sandbox.name,
            snapshotPath,
            restoreAt: new Date(Date.now() + 60_000).toISOString(),
            processToken,
            timerProcessStartIdentity: "live-timer-start",
            allowLegacyHermesProtocol: false,
            agentName: "hermes",
            configPath: target.configPath,
            configDir: target.configDir,
          }),
        );
        writeTimerAuthorizationProof(requireSource, sandbox.name);
        fs.writeFileSync(
          transitionPath,
          JSON.stringify({
            version: 1,
            phase: "preparing",
            ownerPid: 4444,
            ownerStartIdentity: "dead-forward-owner",
            processToken,
            sandboxName: sandbox.name,
            snapshotPath, snapshotPolicy,
            forwardPolicy,
          }),
        );
        arrangeFailure({ forwardPolicyPath: forwardPolicy.path, routeSpy, timerPath });
        lifecycleGateSpy.mockReturnValue(false);

        expect(() => shields.shieldsDown(sandbox.name, { throwOnError: true })).toThrow(
          expectedError,
        );
        assertSideEffects({ routeSpy, runSpy, transitionPath, transitionSpy });
        expect(auditSpy).not.toHaveBeenCalled();
      },
    );

    it("recovers a retained lock before verifying an already-UP Shields record", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const stateDir = statePaths.resolveNemoclawStateDir();
      fs.mkdirSync(path.join(stateDir, "runtime-provider-lifecycle"), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(
        path.join(stateDir, `shields-${sandbox.name}.json`),
        JSON.stringify({
          shieldsDown: false,
          chattrApplied: true,
          fileHashes: { [target.configPath]: "c".repeat(64) },
        }),
      );
      let activeClaim = true;
      lifecycleGateSpy.mockImplementation(() => activeClaim);
      transitionSpy.mockImplementation(() => {
        activeClaim = false;
        return { fence: {}, proof: {} };
      });
      verifyLockSpy.mockImplementation(
        (
          _sandboxName: string,
          _target: unknown,
          options: { exec: (command: string[]) => string },
        ) => {
          options.exec(["stat", "-c", "%a %U:%G", target.configPath]);
          return { issues: [] };
        },
      );

      shields.shieldsUp(sandbox.name, { throwOnError: true });

      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "locked", rollback: "locked" }),
      );
      expect(activeClaim).toBe(false);
      expect(transitionSpy.mock.invocationCallOrder[0]).toBeLessThan(
        verifyLockSpy.mock.invocationCallOrder[0] as number,
      );
      expect(transitionSpy.mock.invocationCallOrder[0]).toBeLessThan(
        dockerExecSpy.mock.invocationCallOrder[0] as number,
      );
      expect(commands.some((command) => command.includes(CAPABILITY_PATH))).toBe(false);
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("does not report clean UP when provider verification finds nested skills or pairing drift", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const stateDir = statePaths.resolveNemoclawStateDir();
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(stateDir, `shields-${sandbox.name}.json`),
        JSON.stringify({
          shieldsDown: false,
          chattrApplied: true,
          fileHashes: { [target.configPath]: "c".repeat(64) },
          updatedAt: new Date().toISOString(),
        }),
      );
      lifecycleGateSpy.mockReturnValue(false);
      transitionSpy.mockImplementation(
        createTransitionFailureForPosture(
          "locked",
          "recursive state lock plan drift under skills/pairing",
        ),
      );
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process exit ${String(code)}`);
      }) as never);
      spies.push(exitSpy);

      expect(() => shields.shieldsStatus(sandbox.name)).toThrow("process exit 2");

      const errors = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
      const logs = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
      expect(errors).toContain("recursive state lock plan drift under skills/pairing");
      expect(errors).toContain("UP (DRIFTED");
      expect(logs).not.toContain("UP (lockdown active)");
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "locked", rollback: "locked" }),
      );

      transitionSpy.mockClear();
      vi.mocked(console.log).mockClear();
      expect(() => shields.shieldsUp(sandbox.name, { throwOnError: true })).toThrow(
        "recursive state lock plan drift under skills/pairing",
      );
      expect(vi.mocked(console.log).mock.calls.flat().map(String).join("\n")).not.toContain(
        "already locked",
      );
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "locked", rollback: "locked" }),
      );

      transitionSpy.mockClear();
      expect(() => shields.lockAgentConfig(sandbox.name, target, true, false)).toThrow(
        "recursive state lock plan drift under skills/pairing",
      );
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "locked", rollback: "locked" }),
      );
    });

    it("does not report clean mutable-default when provider verification finds nested skills or pairing drift", () => {
      lifecycleGateSpy.mockReturnValue(false);
      transitionSpy.mockImplementation(
        createTransitionFailureForPosture(
          "mutable",
          "recursive mutable state drift under skills/pairing",
        ),
      );
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process exit ${String(code)}`);
      }) as never);
      spies.push(exitSpy);

      expect(() => shields.shieldsStatus(sandbox.name)).toThrow("process exit 2");

      const errors = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
      const logs = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
      expect(errors).toContain("recursive mutable state drift under skills/pairing");
      expect(errors).toContain("NOT CONFIGURED (DRIFTED");
      expect(logs).not.toContain("NOT CONFIGURED (default mutable state)");
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "mutable", rollback: "mutable" }),
      );
    });

    it("gates the live provider round trip on sandbox Phase, failing open when inconclusive (#10104)", () => {
      lifecycleGateSpy.mockReturnValue(false);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process exit ${String(code)}`);
      }) as never);
      spies.push(exitSpy);

      runCaptureSpy.mockReturnValue(`${sandbox.name}  Provisioning\n`);
      expect(() => shields.shieldsStatus(sandbox.name)).toThrow("process exit 2");
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(vi.mocked(console.error).mock.calls.flat().map(String).join("\n")).toContain(
        `Run 'nemoclaw ${sandbox.name} status'. Resolve the reported phase, then retry.`,
      );

      runCaptureSpy.mockReturnValue("");
      expect(() => shields.shieldsStatus(sandbox.name)).not.toThrow();
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "mutable", rollback: "mutable" }),
      );
    });

    it("does not report clean timed DOWN on recursive drift or timer loss during verification", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const stateDir = statePaths.resolveNemoclawStateDir();
      const processToken = "e".repeat(32);
      const snapshotPath = path.join(stateDir, "shields-policy-timed-status.yaml");
      const timerPath = path.join(stateDir, `shields-timer-${sandbox.name}.json`);
      const transitionPath = path.join(
        stateDir,
        `shields-transition-${sandbox.name}-${processToken}.json`,
      );
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const snapshotPolicy = writeBoundPolicySnapshot(snapshotPath);
      const forwardPolicy = writeBoundForwardPolicy(stateDir, sandbox.name, processToken);
      fs.writeFileSync(
        path.join(stateDir, `shields-${sandbox.name}.json`),
        JSON.stringify({
          shieldsDown: true,
          shieldsDownAt: new Date().toISOString(),
          shieldsDownTimeout: 300,
          shieldsDownReason: "timed mutable status",
          shieldsDownPolicy: "permissive",
          shieldsPolicySnapshotPath: snapshotPath, shieldsPolicySnapshot: snapshotPolicy,
          updatedAt: new Date().toISOString(),
        }),
      );
      fs.writeFileSync(
        timerPath,
        JSON.stringify({
          pid: 4444,
          sandboxName: sandbox.name,
          snapshotPath,
          restoreAt: new Date(Date.now() + 60_000).toISOString(),
          processToken,
          timerProcessStartIdentity: "live-timer-start",
          allowLegacyHermesProtocol: false,
          agentName: "hermes",
          configPath: target.configPath,
          configDir: target.configDir,
        }),
      );
      writeTimerAuthorizationProof(requireSource, sandbox.name);
      fs.writeFileSync(
        transitionPath,
        JSON.stringify({
          version: 1,
          phase: "active",
          ownerPid: 4444,
          ownerStartIdentity: "timed-status-owner",
          processToken,
          sandboxName: sandbox.name,
          snapshotPath, snapshotPolicy,
          forwardPolicy,
        }),
      );
      lifecycleGateSpy.mockReturnValue(false);
      transitionSpy.mockImplementation(
        createTransitionFailureForPosture(
          "mutable",
          "recursive timed state drift under skills/pairing",
        ),
      );
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process exit ${String(code)}`);
      }) as never);
      spies.push(exitSpy);

      expect(() => shields.shieldsStatus(sandbox.name)).toThrow("process exit 2");

      const errors = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
      const logs = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
      expect(errors).toContain("recursive timed state drift under skills/pairing");
      expect(errors).toContain("DOWN (DRIFTED");
      expect(logs).not.toContain("DOWN (temporarily unlocked)");
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "mutable", rollback: "mutable" }),
      );
      expect(fs.existsSync(timerPath)).toBe(true);
      expect(fs.existsSync(transitionPath)).toBe(true);

      const timerControl = requireSource("./timer-control.js") as typeof import("./timer-control");
      transitionSpy.mockClear();
      vi.mocked(console.error).mockClear();
      vi.mocked(console.log).mockClear();
      transitionSpy.mockImplementation(() => {
        fs.rmSync(timerControl.timerAuthorizationProofPath(sandbox.name, processToken));
        return { fence: {}, proof: {} };
      });

      expect(() => shields.shieldsStatus(sandbox.name)).toThrow("process exit 2");

      const timerLossErrors = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
      const timerLossLogs = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
      expect(timerLossErrors).toContain("exact live future auto-restore timer authority");
      expect(timerLossErrors).toContain("DOWN (DRIFTED");
      expect(timerLossLogs).not.toContain("DOWN (temporarily unlocked)");
      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: "mutable", rollback: "mutable" }),
      );
    });

    it("falls back to the sealed-plan protocol only after proving capability absence", () => {
      capabilityProbe.presence = "absent";

      expect(shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toBe(true);

      expect(supportSpy).not.toHaveBeenCalled();
      expect(commands.some((command) => command.includes("--help"))).toBe(true);
    });

    it("keeps non-managed Docker Hermes sandboxes on their sealed-plan protocol", () => {
      registrySpy.mockReturnValue({ ...sandbox, workload: undefined });

      expect(shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toBe(true);

      expect(
        commands.some(
          (command) =>
            command.includes("-c") && command.some((entry) => entry.includes("os.lstat")),
        ),
      ).toBe(false);
      expect(supportSpy).not.toHaveBeenCalled();
      expect(commands.some((command) => command.includes("--help"))).toBe(true);
    });

    it("keeps an explicit custom Dockerfile Hermes sandbox on its sealed-plan protocol", () => {
      registrySpy.mockReturnValue({
        ...sandbox,
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: null,
          shared: false,
        },
      });

      expect(shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toBe(true);

      expect(
        commands.some(
          (command) =>
            command.includes("-c") && command.some((entry) => entry.includes("os.lstat")),
        ),
      ).toBe(false);
      expect(supportSpy).not.toHaveBeenCalled();
      expect(commands.some((command) => command.includes("--help"))).toBe(true);
    });

    it("fails closed when a present capability is invalid", () => {
      supportSpy.mockReturnValue(false);

      expect(() => shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toThrow(
        /capability is present but invalid or unsupported/u,
      );
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("fails closed when the capability presence probe cannot inspect the image", () => {
      capabilityProbe.error = new Error("permission denied while inspecting capability");

      expect(() => shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toThrow(
        /permission denied while inspecting capability/u,
      );
      expect(supportSpy).not.toHaveBeenCalled();
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("fails closed when provider selection fails for a present capability", () => {
      supportSpy.mockImplementation(() => {
        throw new Error("runtime provider registry unavailable");
      });

      expect(() => shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toThrow(
        /runtime provider registry unavailable/u,
      );
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("fails closed when a present lifecycle ledger cannot be validated", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const lifecyclePath = path.join(
        statePaths.resolveNemoclawStateDir(),
        "runtime-provider-lifecycle",
      );
      fs.mkdirSync(path.dirname(lifecyclePath), { recursive: true });
      fs.symlinkSync(`${lifecyclePath}.missing`, lifecyclePath);

      expect(() => shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toThrow();
      expect(
        commands.some(
          (command) =>
            command.includes("-c") && command.some((entry) => entry.includes("os.lstat")),
        ),
      ).toBe(false);
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("does not reinterpret a lifecycle scan failure as ledger absence", () => {
      const statePaths = requireSource("../state/paths.js") as typeof import("../state/paths");
      const lifecyclePath = path.join(
        statePaths.resolveNemoclawStateDir(),
        "runtime-provider-lifecycle",
      );
      fs.mkdirSync(lifecyclePath, { recursive: true, mode: 0o700 });
      lifecycleGateSpy.mockImplementation(() => {
        throw Object.assign(new Error("claim disappeared during stable ledger inspection"), {
          code: "ENOENT",
        });
      });

      expect(() => shields.supportsHermesSealedShieldsTransactions(sandbox.name)).toThrow(
        /claim disappeared during stable ledger inspection/u,
      );
      expect(
        commands.some(
          (command) =>
            command.includes("-c") && command.some((entry) => entry.includes("os.lstat")),
        ),
      ).toBe(false);
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });

    it("fails closed when managed Docker registry lifecycle authority is incomplete", () => {
      registrySpy.mockReturnValue({ ...sandbox, lifecycleGeneration: undefined });

      expect(() => shields.lockAgentConfig(sandbox.name, target, false, false)).toThrow(
        /registry authority has no lifecycle generation/u,
      );
      expect(commands.some((command) => command.includes("--help"))).toBe(false);
    });
  });
}
