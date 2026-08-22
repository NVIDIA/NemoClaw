// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHermesShieldsProviderConsumerHarness,
  hermesProviderConsumerSandbox,
} from "./helpers/hermes-shields-provider-consumer-harness";
import { createShieldsFlowHarness } from "./helpers/shields-flow-harness";

const requireSource = createRequire(new URL("../src/lib/shields/index.js", import.meta.url));
const managedInspection = {
  authority: "nemoclaw-managed" as const,
  effectivePolicy: { version: 1, network_policies: {} },
};
const externalInspection = {
  authority: "externally-managed" as const,
  effectivePolicy: { version: 1, network_policies: {} },
};
const openClawConfigPath = "/sandbox/.openclaw/openclaw.json";

function writeLockedShieldsState(homeDir: string, sandboxName: string, configPath: string): void {
  const stateDir = path.join(homeDir, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: false,
      chattrApplied: true,
      fileHashes: { [configPath]: "a".repeat(64) },
    }),
  );
}

function fakeTimerChild(onStart: () => void = () => undefined) {
  onStart();
  return {
    pid: 4242,
    disconnect: () => undefined,
    unref: () => undefined,
    send: () => true,
    kill: () => true,
  };
}

function revokedTimerAuthority() {
  return {
    authorityRevoked: true,
    markerFound: true,
    markerPid: 4242,
    wasAlive: false,
    terminated: false,
    warnings: [],
  };
}

function hasActiveShieldsTransition(homeDir: string): boolean {
  const stateDir = path.join(homeDir, ".nemoclaw", "state");
  return fs
    .readdirSync(stateDir)
    .filter((name) => name.startsWith("shields-transition-"))
    .some(
      (name) => JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")).phase === "active",
    );
}

function expectRestrictiveShieldsDownRecovery(
  harness: ReturnType<typeof createShieldsFlowHarness>,
  homeDir: string,
): void {
  const stateDir = path.join(homeDir, ".nemoclaw", "state");
  const policySetCalls = harness.runSpy.mock.calls.filter(
    ([command]) => Array.isArray(command) && command.includes("policy") && command.includes("set"),
  );
  expect(policySetCalls).toHaveLength(1);
  expect(harness.getOpenClawPosture()).toBe("locked");
  expect(
    harness.dockerSpawnCalls.filter(
      ({ args }) =>
        args.includes("lock") && args.some((arg) => arg.endsWith("openclaw-config-guard.py")),
    ),
  ).toHaveLength(2);
  expect(
    JSON.parse(fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf8")),
  ).toMatchObject({ shieldsDown: true });
  expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(true);
  expect(fs.readdirSync(stateDir).some((name) => name.startsWith("shields-transition-"))).toBe(
    true,
  );
  expect(harness.auditSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "shields_down" }),
  );
  expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Config unlocked for");
}

function writeExpiredShieldsTimer(homeDir: string, sandboxName: string): void {
  const stateDir = path.join(homeDir, ".nemoclaw", "state");
  const snapshotPath = path.join(stateDir, "policy-snapshot-test.yaml");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify({
      shieldsDown: true,
      shieldsDownAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      shieldsDownTimeout: 300,
      shieldsDownReason: "testing",
      shieldsDownPolicy: "permissive",
      shieldsPolicySnapshotPath: snapshotPath,
      updatedAt: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(
    path.join(stateDir, `shields-timer-${sandboxName}.json`),
    JSON.stringify({
      pid: 4242,
      sandboxName,
      snapshotPath,
      restoreAt: new Date(Date.now() - 30_000).toISOString(),
      processToken: "token-123",
    }),
  );
}

describe("Shields policy-authority mutation boundaries", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-authority-"));
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("attempts inline recovery for an expired timer marker", () => {
    writeExpiredShieldsTimer(homeDir, "openclaw");
    const harness = createShieldsFlowHarness(requireSource, homeDir);
    const processActions = new Map<string, () => true>([
      [
        "4242:0",
        () => {
          throw Object.assign(new Error("not running"), { code: "ESRCH" });
        },
      ],
    ]);
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) =>
      (processActions.get(`${pid}:${String(signal)}`) ?? (() => true))(),
    );

    harness.shieldsStatus("openclaw");

    expect(harness.errorSpy).toHaveBeenCalledWith(
      "  Warning: auto-restore timer authority is expired, invalid, or no longer live; attempting inline restore.",
    );
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: DOWN (temporarily unlocked)");
  });

  it("attempts inline recovery when a timer PID was reused", () => {
    writeExpiredShieldsTimer(homeDir, "openclaw");
    const harness = createShieldsFlowHarness(requireSource, homeDir);
    vi.spyOn(process, "kill").mockReturnValue(true);
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((target) =>
      String(target) === "/proc/4242/cmdline" ? true : originalExistsSync(target),
    );
    vi.spyOn(fs, "readFileSync").mockImplementation((target, options) =>
      String(target) === "/proc/4242/cmdline"
        ? ("python\0unrelated-process\0" as never)
        : (originalReadFileSync(target, options as never) as never),
    );

    harness.shieldsStatus("openclaw");

    expect(harness.errorSpy).toHaveBeenCalledWith(
      "  Warning: auto-restore timer authority is expired, invalid, or no longer live; attempting inline restore.",
    );
    expect(harness.logSpy).toHaveBeenCalledWith("  Shields: DOWN (temporarily unlocked)");
  });

  it("refuses fresh Shields up before config or state mutation under external authority (#9833)", () => {
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      policyAuthorityInspection: externalInspection,
      sandboxEntry: {
        name: "openclaw",
        openshellDriver: "docker",
        policyAuthority: "externally-managed",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "OpenShell policy is externally managed",
    );

    expect(harness.dockerSpawnCalls).toEqual([]);
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(homeDir, ".nemoclaw/state/shields-openclaw.json"))).toBe(false);
  });

  it("refuses already-locked Shields up before verification or success under external authority (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const statePath = path.join(homeDir, ".nemoclaw/state/shields-openclaw.json");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
      policyAuthorityInspection: externalInspection,
      sandboxEntry: {
        name: "openclaw",
        openshellDriver: "docker",
        policyAuthority: "externally-managed",
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      "OpenShell policy is externally managed",
    );

    expect(harness.dockerSpawnCalls).toEqual([]);
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(harness.logSpy).not.toHaveBeenCalledWith("  Lockdown is already active.");
  });

  it("rechecks after policy set before Shields down unlocks config (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      harness.runSpy.mock.calls.some(
        ([command]) =>
          Array.isArray(command) && command.includes("policy") && command.includes("set"),
      )
        ? externalInspection
        : managedInspection,
    );

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    const policySetCalls = harness.runSpy.mock.calls.filter(
      ([command]) =>
        Array.isArray(command) && command.includes("policy") && command.includes("set"),
    );
    expect(policySetCalls).toHaveLength(1);
    expect(harness.dockerSpawnCalls.some(({ args }) => args.includes("unlock"))).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Config unlocked for");
  });

  it("rechecks after the timer proof before Shields down unlocks config (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const inspectAuthority = vi.mocked(policyAuthority.inspectSandboxPolicyAuthority);
    const timerControl = requireSource(
      "./timer-control.js",
    ) as typeof import("../src/lib/shields/timer-control.js");
    vi.mocked(timerControl.verifyTimerMarkerIdentity).mockImplementation(() => {
      const policyWasApplied = harness.runSpy.mock.calls.some(
        ([command]) =>
          Array.isArray(command) && command.includes("policy") && command.includes("set"),
      );
      inspectAuthority.mockReturnValue(policyWasApplied ? externalInspection : managedInspection);
      return { verified: true };
    });

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(harness.runSpy).toHaveBeenCalledOnce();
    expect(harness.dockerSpawnCalls.some(({ args }) => args.includes("unlock"))).toBe(false);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Config unlocked for");
  });

  it("cleans provisional Shields down recovery before preserving a final policy refusal (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
      run: (command) => {
        const policySet =
          Array.isArray(command) && command.includes("policy") && command.includes("set");
        return {
          status: policySet ? 1 : 0,
          stderr: policySet
            ? "Error: code: 'failed_precondition', message: 'global policy owns this sandbox'"
            : "",
        };
      },
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        reason: "structured policy refusal",
        throwOnError: true,
      }),
    ).toThrow(expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }));

    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsPolicySnapshotPath: null,
    });
    expect(fs.existsSync(path.join(stateDir, "shields-timer-openclaw.json"))).toBe(false);
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith("shields-transition-"))).toBe(
      false,
    );
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.dockerSpawnCalls.some(({ args }) => args.includes("unlock"))).toBe(false);
    expect(
      harness.runSpy.mock.calls.filter(
        ([command]) =>
          Array.isArray(command) && command.includes("policy") && command.includes("set"),
      ),
    ).toHaveLength(1);
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_down" }),
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Config unlocked for");
  });

  it("rechecks after Hermes route wait before Shields down success (#9833)", () => {
    const sandboxName = "hermes";
    const configTarget = {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configFile: "config.yaml",
      configPath: "/sandbox/.hermes/config.yaml",
      format: "yaml" as const,
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
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
    writeLockedShieldsState(homeDir, sandboxName, configTarget.configPath);
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      agentConfigTarget: configTarget,
      initialOpenClawPosture: "mutable",
      sandboxName,
      sandboxEntry: {
        name: sandboxName,
        agent: "hermes",
        openshellDriver: "docker",
        policyAuthority: "nemoclaw-managed",
      },
    });
    let routeWaitCompleted = false;
    const relock = requireSource(
      "./relock-reconfirm.js",
    ) as typeof import("../src/lib/shields/relock-reconfirm.js");
    vi.mocked(relock.waitForHermesInferenceRouteConvergence).mockImplementation(() => {
      routeWaitCompleted = true;
      return { ok: true, attempts: 1, httpStatus: 200 };
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      routeWaitCompleted ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsDown(sandboxName, { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(relock.waitForHermesInferenceRouteConvergence).toHaveBeenCalledOnce();
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Config unlocked for");
  });

  it("rechecks after a fresh config lock before recording Shields up (#9833)", () => {
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      harness.getOpenClawPosture() === "locked" ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Lockdown active for");
  });

  it("rechecks after snapshot policy activation before locking config (#9833)", () => {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "policy-snapshot-openclaw-race.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  restrictive: {}\n");
    fs.writeFileSync(
      path.join(stateDir, "shields-openclaw.json"),
      JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath }),
    );
    const harness = createShieldsFlowHarness(requireSource, homeDir);
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      harness.runSpy.mock.calls.length > 0 ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(harness.runSpy).toHaveBeenCalledOnce();
    expect(harness.getOpenClawPosture()).toBe("mutable");
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("relocks config and preserves recovery after a final snapshot policy refusal (#9833)", () => {
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, "shields-openclaw.json");
    const snapshotPath = path.join(stateDir, "policy-snapshot-openclaw-refused.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  restrictive: {}\n");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ shieldsDown: true, shieldsPolicySnapshotPath: snapshotPath }),
    );
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      run: (command) => {
        const policySet =
          Array.isArray(command) && command.includes("policy") && command.includes("set");
        return {
          status: policySet ? 1 : 0,
          stderr: policySet
            ? "Error: code: 'failed_precondition', message: 'global policy owns this sandbox'"
            : "",
        };
      },
    });

    expect(() => harness.shieldsUp("openclaw", { throwOnError: true })).toThrow(
      expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }),
    );

    const policySetCalls = harness.runSpy.mock.calls.filter(
      ([command]) =>
        Array.isArray(command) && command.includes("policy") && command.includes("set"),
    );
    expect(policySetCalls).toHaveLength(1);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(
      harness.dockerSpawnCalls.filter(
        ({ args }) =>
          args.includes("lock") && args.some((arg) => arg.endsWith("openclaw-config-guard.py")),
      ),
    ).toHaveLength(2);
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Lockdown active for");
  });

  it("rechecks a captured live policy before starting the Shields timer (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const fork = vi.fn(() => fakeTimerChild());
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
      fork,
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      harness.runCaptureSpy.mock.calls.length > 0 ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(fork).not.toHaveBeenCalled();
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("revokes a started timer when authority changes before provisional DOWN state (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    let timerStarted = false;
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      initialOpenClawPosture: "locked",
      fork: () => fakeTimerChild(() => (timerStarted = true)),
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      timerStarted ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      /policy authority changed/u,
    );

    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("relocks config and preserves recovery after a post-unlock authority refusal (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      initialOpenClawPosture: "locked",
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() =>
      hasActiveShieldsTransition(homeDir) ? externalInspection : managedInspection,
    );

    expect(() => harness.shieldsDown("openclaw", { throwOnError: true })).toThrow(
      expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }),
    );

    expectRestrictiveShieldsDownRecovery(harness, homeDir);
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("relocks config when rollback policy restoration is refused (#9833)", () => {
    writeLockedShieldsState(homeDir, "openclaw", openClawConfigPath);
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      fork: () => fakeTimerChild(),
      initialOpenClawPosture: "locked",
      timerDiesAfterUnlock: true,
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const inspectAuthority = vi.mocked(policyAuthority.inspectSandboxPolicyAuthority);
    const timerControl = requireSource(
      "./timer-control.js",
    ) as typeof import("../src/lib/shields/timer-control.js");
    const isProcessAlive = vi.mocked(timerControl.isProcessAlive).getMockImplementation()!;
    const livenessEffects = new Map<boolean, () => void>([
      [false, () => inspectAuthority.mockReturnValue(externalInspection)],
    ]);
    vi.mocked(timerControl.isProcessAlive).mockImplementation((pid, deadline) => {
      const alive = isProcessAlive(pid, deadline);
      livenessEffects.get(alive)?.();
      return alive;
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "rollback policy authority race",
        throwOnError: true,
      }),
    ).toThrow(expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }));

    expectRestrictiveShieldsDownRecovery(harness, homeDir);
  });

  it("checks policy authority before every inline config relock callback (#9833)", () => {
    writeExpiredShieldsTimer(homeDir, "openclaw");
    fs.rmSync(path.join(homeDir, ".nemoclaw", "state", "shields-timer-openclaw.json"));
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      relockAndReconfirm: (lock) => {
        const first = lock();
        lock();
        return { ok: true, attempts: 1, lastResult: first };
      },
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority)
      .mockReset()
      .mockReturnValueOnce(managedInspection)
      .mockReturnValueOnce(managedInspection)
      .mockReturnValueOnce(managedInspection)
      .mockReturnValueOnce(managedInspection)
      .mockReturnValueOnce(managedInspection)
      .mockReturnValue(externalInspection);

    expect(() => harness.getShieldsPosture("openclaw", true)).toThrow(/policy authority changed/i);

    expect(harness.dockerSpawnCalls.filter(({ args }) => args.includes("lock"))).toHaveLength(2);
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });

  it("relocks the persisted target when preparing-transition inline recovery is refused (#9833)", () => {
    const sandboxName = "openclaw";
    const processToken = "d".repeat(32);
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const statePath = path.join(stateDir, `shields-${sandboxName}.json`);
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const transitionPath = path.join(
      stateDir,
      `shields-transition-${sandboxName}-${processToken}.json`,
    );
    const snapshotPath = path.join(stateDir, "policy-snapshot-preparing-refusal.yaml");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  restrictive: {}\n");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120_000).toISOString(),
        shieldsDownTimeout: 60,
        shieldsDownReason: "preparing transition refusal",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
      }),
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 4242,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() - 60_000).toISOString(),
        processToken,
        timerProcessStartIdentity: "expired-timer-start",
        agentName: "openclaw",
        configPath: openClawConfigPath,
        configDir: "/sandbox/.openclaw",
      }),
    );
    fs.writeFileSync(
      transitionPath,
      JSON.stringify({
        version: 1,
        phase: "preparing",
        ownerPid: process.pid,
        ownerStartIdentity: "preparing-owner-start",
        processToken,
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const markerBefore = fs.readFileSync(markerPath, "utf8");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      processStartIdentity: "preparing-owner-start",
    });
    vi.spyOn(Atomics, "wait")
      .mockImplementationOnce(() => {
        const transition = JSON.parse(fs.readFileSync(transitionPath, "utf8"));
        fs.writeFileSync(transitionPath, JSON.stringify({ ...transition, phase: "active" }));
        return "ok";
      })
      .mockReturnValue("ok");
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const refusal = Object.assign(new Error("Preparing transition policy authority refusal"), {
      code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL",
    });
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() => {
      throw refusal;
    });

    let caught: unknown;
    try {
      harness.getShieldsPosture(sandboxName, true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(refusal);
    expect(harness.getOpenClawPosture()).toBe("locked");
    expect(
      harness.dockerSpawnCalls.filter(
        ({ args }) =>
          args.includes("lock") && args.some((arg) => arg.endsWith("openclaw-config-guard.py")),
      ),
    ).toHaveLength(2);
    expect(harness.runSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(markerBefore);
    expect(JSON.parse(fs.readFileSync(transitionPath, "utf8"))).toMatchObject({
      phase: "active",
      processToken,
    });
    expect(harness.auditSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Lockdown active for");
  });

  it("stops mutable rollback when authority changes during timer revocation (#9833)", () => {
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      fork: () => fakeTimerChild(),
      timerAuthorityRevokedSequence: [true, true],
      timerDiesAfterUnlock: true,
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const inspectAuthority = vi.mocked(policyAuthority.inspectSandboxPolicyAuthority);
    const timerControl = requireSource(
      "./timer-control.js",
    ) as typeof import("../src/lib/shields/timer-control.js");
    vi.mocked(timerControl.killTimer)
      .mockReturnValueOnce(revokedTimerAuthority())
      .mockImplementation(() => {
        inspectAuthority.mockReturnValue(externalInspection);
        return revokedTimerAuthority();
      });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "timer authority race",
        throwOnError: true,
      }),
    ).toThrow(expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }));

    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "Original mutable-default posture restored",
    );
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_down" }),
    );
  });

  it("stops mutable rollback when authority changes during state restoration (#9833)", () => {
    const statePath = path.join(homeDir, ".nemoclaw", "state", "shields-openclaw.json");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      fork: () => fakeTimerChild(),
      timerDiesAfterUnlock: true,
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const inspectAuthority = vi.mocked(policyAuthority.inspectSandboxPolicyAuthority);
    const originalRmSync = fs.rmSync.bind(fs);
    const removalEffects = new Map<string, () => void>([
      [statePath, () => inspectAuthority.mockReturnValue(externalInspection)],
    ]);
    vi.spyOn(fs, "rmSync").mockImplementation(((target, options) => {
      originalRmSync(target, options);
      removalEffects.get(String(target))?.();
    }) as typeof fs.rmSync);

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "state authority race",
        throwOnError: true,
      }),
    ).toThrow(expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }));

    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "Original mutable-default posture restored",
    );
    expect(harness.auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "shields_down" }),
    );
  });

  it("does not report fail-closed rollback success after authority changes during persistence (#9833)", () => {
    const statePath = path.join(homeDir, ".nemoclaw", "state", "shields-openclaw.json");
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      confirmOpenClawInodeFlags: true,
      failOpenClawGuardActions: ["unlock"],
      fork: () => fakeTimerChild(),
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const inspectAuthority = vi.mocked(policyAuthority.inspectSandboxPolicyAuthority);
    const stateWrite = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => inspectAuthority.mockReturnValue(externalInspection));
    const originalRenameSync = fs.renameSync.bind(fs);
    const persistenceEffects = new Map<string, () => void>([[statePath, stateWrite]]);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      originalRenameSync(source, destination);
      persistenceEffects.get(String(destination))?.();
    });

    expect(() =>
      harness.shieldsDown("openclaw", {
        timeout: "5m",
        reason: "fail-closed authority race",
        throwOnError: true,
      }),
    ).toThrow(expect.objectContaining({ code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL" }));

    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({ shieldsDown: false });
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "Fail-closed lockdown applied",
    );
  });

  it("keeps a branded inline policy-authority refusal final across module boundaries (#9833)", () => {
    writeExpiredShieldsTimer(homeDir, "openclaw");
    fs.rmSync(path.join(homeDir, ".nemoclaw", "state", "shields-timer-openclaw.json"));
    const harness = createShieldsFlowHarness(requireSource, homeDir);
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    const refusal = Object.assign(new Error("Cross-module policy authority refusal"), {
      code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL",
    });
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockImplementation(() => {
      throw refusal;
    });

    let caught: unknown;
    try {
      harness.getShieldsPosture("openclaw", true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(refusal);
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });
});

describe("Hermes Shields provider policy authority", () => {
  let harness: ReturnType<typeof createHermesShieldsProviderConsumerHarness>;

  beforeEach(() => {
    harness = createHermesShieldsProviderConsumerHarness(requireSource);
  });

  afterEach(() => {
    harness.cleanup();
  });

  it("refuses mutable status before provider protection mutation under external authority (#9833)", () => {
    harness.lifecycleGateSpy.mockReturnValue(false);
    harness.registrySpy.mockReturnValue({
      ...hermesProviderConsumerSandbox,
      policyAuthority: "externally-managed",
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockReturnValue(externalInspection);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as never);
    harness.spies.push(exitSpy);

    expect(() => harness.shields.shieldsStatus(hermesProviderConsumerSandbox.name)).toThrow(
      "process exit 2",
    );

    expect(harness.transitionSpy).not.toHaveBeenCalled();
  });

  it("restores restrictive provider protection before rejecting mutable persisted posture under external authority (#9833)", () => {
    harness.lifecycleGateSpy.mockReturnValue(true);
    const lifecycleDir = path.join(
      process.env.HOME!,
      ".nemoclaw",
      "state",
      "runtime-provider-lifecycle",
    );
    fs.mkdirSync(lifecycleDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(lifecycleDir, 0o700);
    harness.registrySpy.mockReturnValue({
      ...hermesProviderConsumerSandbox,
      policyAuthority: "externally-managed",
    });
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockReturnValue(externalInspection);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as never);
    harness.spies.push(exitSpy);

    expect(() => harness.shields.shieldsStatus(hermesProviderConsumerSandbox.name)).toThrow(
      "process exit 2",
    );

    expect(harness.transitionSpy).toHaveBeenCalledOnce();
    expect(harness.transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: "locked", rollback: "locked" }),
    );
  });

  it("rebinds a replacement config lock under external authority (#9833)", () => {
    harness.lifecycleGateSpy.mockReturnValue(false);
    harness.registrySpy.mockReturnValue({
      ...hermesProviderConsumerSandbox,
      policyAuthority: "externally-managed",
    });
    writeLockedShieldsState(
      process.env.HOME!,
      hermesProviderConsumerSandbox.name,
      "/sandbox/.hermes/config.yaml",
    );
    const policyAuthority = requireSource(
      "../adapters/openshell/policy-authority.js",
    ) as typeof import("../src/lib/adapters/openshell/policy-authority.js");
    vi.mocked(policyAuthority.inspectSandboxPolicyAuthority).mockReturnValue(externalInspection);

    harness.shields.rebindReplacementConfigLock(hermesProviderConsumerSandbox.name, true);

    expect(harness.transitionSpy).toHaveBeenCalledTimes(2);
    expect(harness.transitionSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target: "locked", rollback: "locked" }),
    );
    expect(harness.transitionSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ target: "locked", rollback: "locked" }),
    );
  });
});
