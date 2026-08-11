// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";

type RequireSource = NodeJS.Require;

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

export type HermesUnsafeConfigScenario =
  | "preflight-symlink"
  | "unlock-symlink"
  | "unlock-ok-relock-symlink";

type DockerExecImpl = (cmd: string[]) => string;

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

function shieldsMode(cmd: string[]): string | undefined {
  const index = cmd.indexOf("--shields-mode");
  return index >= 0 ? cmd[index + 1] : undefined;
}

function defaultDockerExec(cmd: string[]): string {
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
}

function wrapScenario(scenario: HermesUnsafeConfigScenario, prior: DockerExecImpl): DockerExecImpl {
  const unsafePathError = new Error("refusing to follow symlink: /sandbox/.hermes/config.yaml");
  const preflightError = new Error("refusing symlink path: /sandbox/.hermes/config.yaml");

  return (cmd: string[]) => {
    if (scenario === "preflight-symlink" && isPathPreflight(cmd)) {
      throw preflightError;
    }
    if (scenario !== "preflight-symlink" && isPathPreflight(cmd)) {
      return "";
    }
    if (scenario === "unlock-symlink" && isGuardAction(cmd, "begin-shields-transition")) {
      throw unsafePathError;
    }
    if (
      scenario === "unlock-ok-relock-symlink" &&
      isGuardAction(cmd, "begin-shields-transition") &&
      shieldsMode(cmd) === "locked"
    ) {
      throw unsafePathError;
    }
    return prior(cmd);
  };
}

export type HermesUnsafeConfigHarness = {
  auditSpy: MockInstance;
  dockerExecSpy: MockInstance;
  errorSpy: MockInstance;
  homeDir: string;
  runSpy: MockInstance;
  seedLockedState: (sandboxName: string) => string;
  setScenario: (scenario: HermesUnsafeConfigScenario) => void;
  shields: typeof import("../../src/lib/shields/index.js");
};

/** Paths are relative to the calling shields `*.test.ts` createRequire root. */
export function createHermesUnsafeConfigHarness(
  requireSource: RequireSource,
  indexModule: string,
): {
  afterEachHook: () => void;
  beforeEachHook: () => HermesUnsafeConfigHarness;
} {
  let homeDir = "";
  let shields: HermesUnsafeConfigHarness["shields"];
  let runSpy: MockInstance;
  let dockerExecSpy: MockInstance;
  let auditSpy: MockInstance;
  let errorSpy: MockInstance;
  let baseDockerExec: DockerExecImpl = defaultDockerExec;

  const seedLockedState = (sandboxName: string): string => {
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
  };

  const setScenario = (scenario: HermesUnsafeConfigScenario) => {
    dockerExecSpy.mockImplementation(wrapScenario(scenario, baseDockerExec));
  };

  return {
    beforeEachHook: () => {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-unsafe-"));
      vi.stubEnv("HOME", homeDir);
      delete require.cache[requireSource.resolve(indexModule)];
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
      fs.writeFileSync(permissivePolicyPath, "version: 1\nnetwork_policies: {}\n", {
        mode: 0o600,
      });

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
      vi.spyOn(policy, "buildPolicySetCommand").mockImplementation(
        (file: unknown, name: unknown) => ["policy", "set", String(file), String(name)],
      );
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

      baseDockerExec = defaultDockerExec;
      dockerExecSpy.mockImplementation(baseDockerExec);
      shields = requireSource(indexModule);

      return {
        auditSpy,
        dockerExecSpy,
        errorSpy,
        homeDir,
        runSpy,
        seedLockedState,
        setScenario,
        shields,
      };
    },
    afterEachHook: () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      delete require.cache[requireSource.resolve(indexModule)];
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

export function expectHermesShieldsUpRecord(
  stateDir: string,
  sandboxName: string,
  shields: HermesUnsafeConfigHarness["shields"],
): void {
  expect(
    JSON.parse(fs.readFileSync(path.join(stateDir, `shields-${sandboxName}.json`), "utf-8")),
  ).toMatchObject({ shieldsDown: false, chattrApplied: true });
  expect(fs.existsSync(path.join(stateDir, `shields-timer-${sandboxName}.json`))).toBe(false);
  expect(shields.isShieldsDown(sandboxName)).toBe(false);
}

export function failHermesInferenceConvergence(requireSource: RequireSource): void {
  const relockReconfirm = requireSource("./relock-reconfirm.js");
  vi.spyOn(relockReconfirm, "waitForHermesInferenceRouteConvergence").mockReturnValue({
    ok: false,
    attempts: 3,
    httpStatus: 503,
  });
}
