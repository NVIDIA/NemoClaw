// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedMcpPolicyOmission } from "../actions/sandbox/mcp-bridge-policy";
import {
  beginCommittedMcpLifecycleContainmentSync,
  getMcpLifecycleLockPath,
  withMcpLifecycleLock,
} from "../state/mcp-lifecycle-lock";

const shieldsIndexMock = vi.hoisted(() => ({
  applyShieldsPolicySnapshot: vi.fn(
    (): {
      status: number;
      managedMcpOmissions?: ManagedMcpPolicyOmission[];
    } => ({ status: 0 }),
  ),
  completeAutoRestoreTransition: vi.fn(() => true),
  hermesProviderLockConfirmation: vi.fn() as unknown,
  lockAgentConfig: vi.fn() as unknown,
  prepareAutoRestoreTransitionTakeover: vi.fn(),
  resolvePersistedAutoRestoreTarget: vi.fn() as unknown,
  resolveHermesShieldsProtocol: vi.fn() as unknown,
}));

const PROCESS_TOKEN = "a".repeat(32);

interface TimerTestOptions {
  retryDelayMs?: number;
  maxRestoreAttempts?: number;
}

vi.mock("./index", () => ({
  applyShieldsPolicySnapshot: shieldsIndexMock.applyShieldsPolicySnapshot,
  completeAutoRestoreTransition: shieldsIndexMock.completeAutoRestoreTransition,
  get hermesProviderLockConfirmation() {
    return shieldsIndexMock.hermesProviderLockConfirmation;
  },
  get lockAgentConfig() {
    return shieldsIndexMock.lockAgentConfig;
  },
  prepareAutoRestoreTransitionTakeover: shieldsIndexMock.prepareAutoRestoreTransitionTakeover,
  get resolvePersistedAutoRestoreTarget() {
    return shieldsIndexMock.resolvePersistedAutoRestoreTarget;
  },
  get resolveHermesShieldsProtocol() {
    return shieldsIndexMock.resolveHermesShieldsProtocol;
  },
}));

describe("shields timer authorization", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-timer-"));
    vi.stubEnv("HOME", tmpHome);
    shieldsIndexMock.applyShieldsPolicySnapshot.mockImplementation(() => ({ status: 0 }));
    shieldsIndexMock.hermesProviderLockConfirmation = vi.fn(() => undefined);
    shieldsIndexMock.lockAgentConfig = vi.fn();
    shieldsIndexMock.resolveHermesShieldsProtocol = vi.fn(() => "sealed-plan-v1");
    shieldsIndexMock.resolvePersistedAutoRestoreTarget = vi.fn(
      (
        _sandboxName: string,
        marker: { agentName?: string; configPath?: string; configDir?: string },
      ) =>
        marker.configPath && marker.configDir
          ? {
              ...(marker.agentName ? { agentName: marker.agentName } : {}),
              configPath: marker.configPath,
              configDir: marker.configDir,
              sensitiveFiles: [
                `${marker.configDir.replace(/\/+$/, "")}/.config-hash`,
                ...(marker.agentName === "hermes"
                  ? [`${marker.configDir.replace(/\/+$/, "")}/.env`]
                  : []),
              ],
              stateLockPlanInImage: false,
            }
          : undefined,
    );
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function invokeTimerAndCaptureExit(
    runRestoreTimer: (args: any, options?: TimerTestOptions) => Promise<void>,
    args: unknown,
    options: TimerTestOptions = { retryDelayMs: 1 },
  ): Promise<number> {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit:${String(code ?? 0)}`);
    });

    try {
      await runRestoreTimer(args, options);
      throw new Error("Expected runRestoreTimer to exit");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.startsWith("process.exit:")).toBe(true);
      const code = Number.parseInt(message.slice("process.exit:".length), 10);
      return Number.isNaN(code) ? 0 : code;
    } finally {
      exitSpy.mockRestore();
    }
  }

  async function waitForRetryBoundary(deadlinePath: string, auditPath: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(fs.existsSync(deadlinePath)).toBe(true);
        expect(fs.existsSync(auditPath)).toBe(true);
      },
      { interval: 1, timeout: 2_000 },
    );
  }

  async function invokeTimerAndExpectRetry(
    runRestoreTimer: (args: any, options?: TimerTestOptions) => Promise<void>,
    args: unknown,
  ): Promise<void> {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const { markerPath, sandboxName } = args as {
      markerPath: string;
      sandboxName: string;
    };
    const markerContents = fs.readFileSync(markerPath);
    const deadlinePath = `${getMcpLifecycleLockPath(
      sandboxName,
      path.join(tmpHome, ".nemoclaw", "state"),
    )}.deadline`;
    const auditPath = path.join(path.dirname(markerPath), "shields-audit.jsonl");
    const pending = runRestoreTimer(args, { retryDelayMs: 50 });
    try {
      await waitForRetryBoundary(deadlinePath, auditPath);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(deadlinePath)).toBe(true);
      const policyApplicationsBeforeRevocation =
        shieldsIndexMock.applyShieldsPolicySnapshot.mock.calls.length;
      fs.rmSync(markerPath, { force: true });
      await pending;
      expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(
        policyApplicationsBeforeRevocation,
      );
    } finally {
      fs.writeFileSync(markerPath, markerContents);
      exitSpy.mockRestore();
    }
  }

  function createFailedRestoreFixture(
    sandboxName: string,
    parseTimerArgs: (argv: string[]) => unknown,
  ) {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const mutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    const writeMarker = (processToken: string) =>
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          pid: process.pid,
          sandboxName,
          snapshotPath,
          restoreAt: restoreAtIso,
          processToken,
        }),
      );
    writeMarker(PROCESS_TOKEN);
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValue({ status: 1 });
    const args = parseTimerArgs([sandboxName, snapshotPath, restoreAtIso, "", "", PROCESS_TOKEN]);
    expect(args).not.toBeNull();
    return {
      args,
      containmentPath: `${mutationLockPath}.containment`,
      deadlinePath: `${mutationLockPath}.deadline`,
      markerPath,
      mutationLockPath,
      sandboxName,
      stateDir,
      writeMarker,
    };
  }

  it("does not restore or rewrite state when marker is missing", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const initialState = { shieldsDown: true, updatedAt: "2026-01-01T00:00:00.000Z" };

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));

    const args = timer.parseTimerArgs([sandboxName, snapshotPath, restoreAtIso, "", "", "tok"]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
  });

  it("does not restore or rewrite state when marker processToken mismatches", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const initialState = { shieldsDown: true, updatedAt: "2026-01-01T00:00:00.000Z" };

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: "wrong-token",
      }),
    );

    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      "right-token",
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not restore or rewrite state through a symlinked timer marker",
    async () => {
      const timer = await import("./timer");
      const stateDir = path.join(tmpHome, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const sandboxName = "alpha";
      const snapshotPath = path.join(stateDir, "snapshot.yaml");
      const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
      const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
      const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
      const markerTargetPath = path.join(stateDir, "operator-owned-marker.json");
      const initialState = { shieldsDown: true, updatedAt: "2026-01-01T00:00:00.000Z" };
      const markerTarget = JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      });

      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
      fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
      fs.writeFileSync(markerTargetPath, markerTarget);
      fs.symlinkSync(markerTargetPath, markerPath);
      const args = timer.parseTimerArgs([
        sandboxName,
        snapshotPath,
        restoreAtIso,
        "",
        "",
        PROCESS_TOKEN,
      ]);
      expect(args).not.toBeNull();

      const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

      expect(exitCode).toBe(0);
      expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
      expect(fs.lstatSync(markerPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(markerTargetPath, "utf-8")).toBe(markerTarget);
    },
  );

  it("binds rebuild-only legacy authorization to both argv and the root-owned marker", async () => {
    const timerControl = await import("./timer-control");
    const selfStartIdentity = "proc:self-start";
    const identitySpy = vi
      .spyOn(timerControl, "readProcessStartIdentity")
      .mockReturnValue(selfStartIdentity);
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "legacy-hermes";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
        timerProcessStartIdentity: selfStartIdentity,
        allowLegacyHermesProtocol: true,
        agentName: "openclaw",
        configPath: "/sandbox/.hermes/config.yaml",
        configDir: "/sandbox/.hermes",
      }),
    );

    const authorized = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "/sandbox/.hermes/config.yaml",
      "/sandbox/.hermes",
      PROCESS_TOKEN,
      "1",
      "",
      "",
      "openclaw",
    ]);
    const ordinary = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "/sandbox/.hermes/config.yaml",
      "/sandbox/.hermes",
      PROCESS_TOKEN,
      "0",
      "",
      "",
      "openclaw",
    ]);
    const mismatchedAgent = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "/sandbox/.hermes/config.yaml",
      "/sandbox/.hermes",
      PROCESS_TOKEN,
      "1",
      "",
      "",
      "langchain-deepagents-code",
    ]);
    const mismatchedTarget = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw",
      PROCESS_TOKEN,
      "1",
      "",
      "",
      "openclaw",
    ]);

    expect(authorized).not.toBeNull();
    expect(mismatchedAgent).not.toBeNull();
    expect(mismatchedTarget).not.toBeNull();
    expect(authorized?.allowLegacyHermesProtocol).toBe(true);
    expect(timer.markerMatchesCurrentTimer(authorized!)).toBe(true);
    expect(timer.markerMatchesCurrentTimer(ordinary!)).toBe(false);
    expect(timer.markerMatchesCurrentTimer(mismatchedAgent!)).toBe(false);
    expect(timer.markerMatchesCurrentTimer(mismatchedTarget!)).toBe(false);
    expect(identitySpy).toHaveBeenCalledTimes(1);
    expect(
      timer.parseTimerArgs([sandboxName, snapshotPath, restoreAtIso, "", "", PROCESS_TOKEN, "yes"]),
    ).toBeNull();
  });

  it("defers the rebuild auto-restore deadline while the exact rebuild owner is alive", async () => {
    vi.useFakeTimers();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    try {
      const timer = await import("./timer");
      const { readProcessStartIdentity } = await import("./timer-control");
      const ownerIdentity = readProcessStartIdentity(process.pid);
      expect(ownerIdentity).toBeTruthy();
      const stateDir = path.join(tmpHome, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const sandboxName = "rebuild-live";
      const snapshotPath = path.join(stateDir, "snapshot.yaml");
      const restoreAtIso = new Date().toISOString();
      const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          pid: process.pid,
          sandboxName,
          snapshotPath,
          restoreAt: restoreAtIso,
          processToken: PROCESS_TOKEN,
          leaseOwnerPid: process.pid,
          leaseOwnerStartIdentity: ownerIdentity,
        }),
      );
      const args = timer.parseTimerArgs([
        sandboxName,
        snapshotPath,
        restoreAtIso,
        "",
        "",
        PROCESS_TOKEN,
        "0",
        String(process.pid),
        ownerIdentity!,
      ]);
      expect(args).not.toBeNull();

      await timer.runRestoreTimer(args!);

      expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("audits a successful restore retry without stale MCP warnings or timestamps", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "rebuild-dead";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const sandboxMutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    const deadlinePath = `${sandboxMutationLockPath}.deadline`;
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
        leaseOwnerPid: 2_147_483_000,
        leaseOwnerStartIdentity: "proc:dead-owner",
      }),
    );
    shieldsIndexMock.applyShieldsPolicySnapshot.mockImplementationOnce(() => {
      expect(fs.existsSync(sandboxMutationLockPath)).toBe(true);
      expect(fs.existsSync(deadlinePath)).toBe(true);
      return {
        status: 17,
        managedMcpOmissions: [{ server: "beta", reason: "incomplete add" }],
      };
    });
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValueOnce({
      status: 0,
      managedMcpOmissions: [],
    });
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
      "0",
      "2147483000",
      "proc:dead-owner",
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(2);
    expect(shieldsIndexMock.completeAutoRestoreTransition).toHaveBeenCalledWith(
      sandboxName,
      PROCESS_TOKEN,
      snapshotPath,
    );
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(sandboxMutationLockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
    const audits = fs
      .readFileSync(path.join(stateDir, "shields-audit.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const successAudits = audits.filter((audit) => audit.action === "shields_auto_restore");
    expect(successAudits).toEqual([
      expect.objectContaining({
        action: "shields_auto_restore",
        sandbox: sandboxName,
      }),
    ]);
    expect(successAudits[0]).not.toHaveProperty("warning");
    const failedAudit = audits.find(
      (audit) =>
        audit.action === "shields_up_failed" &&
        audit.error === "Policy restore exited with status 17",
    );
    expect(failedAudit).toEqual(expect.objectContaining({ timestamp: expect.any(String) }));
    expect(Date.parse(successAudits[0].timestamp)).toBeGreaterThan(
      Date.parse(failedAudit.timestamp),
    );
  });

  it("does not restore or rewrite state when marker pid mismatches", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const initialState = { shieldsDown: true, updatedAt: "2026-01-01T00:00:00.000Z" };

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid + 1,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("does not delete a replacement timer marker during owned-marker cleanup", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "marker-race";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const oldMarker = {
      pid: process.pid,
      sandboxName,
      snapshotPath,
      restoreAt: restoreAtIso,
      processToken: PROCESS_TOKEN,
    };
    const replacementMarker = {
      ...oldMarker,
      restoreAt: new Date(Date.now() + 60_000).toISOString(),
      processToken: "b".repeat(32),
    };
    fs.writeFileSync(markerPath, JSON.stringify(oldMarker));
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    const originalRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      originalRename(source, destination);
      String(source) === markerPath &&
        fs.writeFileSync(markerPath, JSON.stringify(replacementMarker));
    });
    try {
      expect(timer.cleanupOwnedTimerMarker(args!)).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(markerPath, "utf-8"))).toEqual(replacementMarker);
  });

  it("does not preempt a transition owner after timer authority is revoked", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "revoked-takeover";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const mutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    const deadlinePath = `${mutationLockPath}.deadline`;
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();
    shieldsIndexMock.prepareAutoRestoreTransitionTakeover.mockImplementationOnce(
      (
        _sandboxName: string,
        _processToken: string,
        _snapshotPath: string,
        assertTakeoverAuthority: () => void,
      ) => {
        expect(fs.existsSync(deadlinePath)).toBe(true);
        fs.rmSync(markerPath);
        assertTakeoverAuthority();
      },
    );

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(1);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(fs.existsSync(mutationLockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(fs.existsSync(`${mutationLockPath}.containment`)).toBe(false);
  });

  it("retires successful timer authority only after lifecycle gates are released (#9750)", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const sandboxMutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    const lockPath = path.join(stateDir, `shields-transition-lock-${sandboxName}.json`);
    const deadlinePath = `${sandboxMutationLockPath}.deadline`;
    const lifecycleGateStatesAtMarkerCleanup: boolean[] = [];
    const renameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      oldPath === markerPath &&
        lifecycleGateStatesAtMarkerCleanup.push(
          fs.existsSync(sandboxMutationLockPath) || fs.existsSync(deadlinePath),
        );
      renameSync(oldPath, newPath);
    });
    shieldsIndexMock.applyShieldsPolicySnapshot.mockImplementationOnce(() => {
      expect(fs.existsSync(sandboxMutationLockPath)).toBe(true);
      expect(fs.existsSync(deadlinePath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
        sandboxName,
        command: "shields auto-restore",
        takeoverToken: PROCESS_TOKEN,
      });
      return {
        status: 0,
        managedMcpOmissions: [{ server: "beta", reason: "incomplete add" }],
      };
    });

    const exitCode = await (async () => {
      try {
        return await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
      } finally {
        renameSpy.mockRestore();
      }
    })();
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(updatedState.shieldsDown).toBe(false);
    expect(updatedState.shieldsDownAt).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(sandboxMutationLockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(lifecycleGateStatesAtMarkerCleanup).toEqual([false]);
    expect(shieldsIndexMock.completeAutoRestoreTransition).toHaveBeenCalledWith(
      sandboxName,
      PROCESS_TOKEN,
      snapshotPath,
    );
    expect(
      fs
        .readFileSync(path.join(stateDir, "shields-audit.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toContainEqual(
      expect.objectContaining({
        action: "shields_auto_restore",
        warning: "Auto-restore omitted 1 unproven managed MCP policy entries",
      }),
    );
  });

  it("keeps the deadline gate closed while a failed restore retries", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "retry-gate";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date().toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const mutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );
    shieldsIndexMock.applyShieldsPolicySnapshot
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValue({ status: 0 });
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      "",
      "",
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    let contenderEntered = false;

    try {
      const restore = timer.runRestoreTimer(args!, { retryDelayMs: 100 });
      await vi.waitFor(
        () => expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1),
        {
          interval: 1,
          timeout: 2_000,
        },
      );
      expect(fs.existsSync(`${mutationLockPath}.deadline`)).toBe(true);

      const contender = withMcpLifecycleLock(
        sandboxName,
        () => {
          contenderEntered = true;
        },
        { stateDir, pollIntervalMs: 5, timeoutMs: 2_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(contenderEntered).toBe(false);
      expect(fs.existsSync(`${mutationLockPath}.deadline`)).toBe(true);

      await Promise.all([restore, contender]);
      expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(2);
      expect(contenderEntered).toBe(true);
      expect(shieldsIndexMock.completeAutoRestoreTransition).toHaveBeenCalledWith(
        sandboxName,
        PROCESS_TOKEN,
        snapshotPath,
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("commits durable containment after the default seven-attempt auto-restore budget", async () => {
    const timer = await import("./timer");
    const fixture = createFailedRestoreFixture("retry-containment", timer.parseTimerArgs);
    const {
      args,
      containmentPath,
      deadlinePath,
      markerPath,
      mutationLockPath,
      sandboxName,
      stateDir,
    } = fixture;
    const auditPath = path.join(stateDir, "shields-audit.jsonl");

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args, {
      retryDelayMs: 0,
    });

    expect(exitCode).toBe(1);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(7);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(mutationLockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(containmentPath, "utf-8"))).toMatchObject({
      sandboxName,
      shieldsTakeoverToken: PROCESS_TOKEN,
      containmentReason: expect.stringContaining("failed after 7 attempts"),
    });
    await expect(withMcpLifecycleLock(sandboxName, () => undefined, { stateDir })).rejects.toThrow(
      "Sandbox mutation containment is active",
    );
    const auditEntries = fs
      .readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(auditEntries).toHaveLength(8);
    expect(auditEntries.at(-1)).toMatchObject({
      action: "shields_up_failed",
      sandbox: sandboxName,
      error: expect.stringContaining("Durable containment now blocks sandbox mutations"),
    });
  });

  it("reclaims its exact containment generation when timer authority changes during publication", async () => {
    const timer = await import("./timer");
    const fixture = createFailedRestoreFixture(
      "containment-publication-revoked",
      timer.parseTimerArgs,
    );
    const { args, containmentPath, deadlinePath, markerPath, mutationLockPath, writeMarker } =
      fixture;
    const replacementToken = "f".repeat(32);
    const originalLink = fs.linkSync.bind(fs);
    const publishReplacement = (existingPath: fs.PathLike, newPath: fs.PathLike): void => {
      originalLink(existingPath, newPath);
      writeMarker(replacementToken);
    };
    const linkHandlers = new Map([[containmentPath, publishReplacement]]);
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      return (linkHandlers.get(String(newPath)) ?? originalLink)(existingPath, newPath);
    });

    try {
      const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args, {
        retryDelayMs: 0,
        maxRestoreAttempts: 1,
      });
      expect(exitCode).toBe(1);
    } finally {
      linkSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(markerPath, "utf-8"))).toMatchObject({
      processToken: replacementToken,
    });
    expect(fs.existsSync(containmentPath)).toBe(false);
    expect(fs.existsSync(mutationLockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
  });

  it("retains the exact deadline gates when revoked containment rollback cannot be proven", async () => {
    const timer = await import("./timer");
    const fixture = createFailedRestoreFixture("contain-rollback", timer.parseTimerArgs);
    const { args, containmentPath, deadlinePath, markerPath, mutationLockPath, writeMarker } =
      fixture;
    const replacementToken = "e".repeat(32);
    const originalLink = fs.linkSync.bind(fs);
    const publishReplacement = (existingPath: fs.PathLike, newPath: fs.PathLike): void => {
      originalLink(existingPath, newPath);
      writeMarker(replacementToken);
    };
    const linkHandlers = new Map([[containmentPath, publishReplacement]]);
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      return (linkHandlers.get(String(newPath)) ?? originalLink)(existingPath, newPath);
    });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath) => {
      expect(String(oldPath)).toBe(containmentPath);
      const error = new Error("simulated exact rollback failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args, {
        retryDelayMs: 0,
        maxRestoreAttempts: 1,
      });
      expect(exitCode).toBe(1);
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(markerPath, "utf-8"))).toMatchObject({
      processToken: replacementToken,
    });
    expect(fs.existsSync(containmentPath)).toBe(true);
    expect(fs.existsSync(mutationLockPath)).toBe(true);
    expect(fs.existsSync(deadlinePath)).toBe(true);
  });

  it("retains the exact deadline gates when durable containment cannot be committed", async () => {
    const timer = await import("./timer");
    const { args, containmentPath, deadlinePath, markerPath, mutationLockPath, stateDir } =
      createFailedRestoreFixture("retry-contain", timer.parseTimerArgs);
    const originalLink = fs.linkSync.bind(fs);
    const rejectContainment = (): never => {
      const error = new Error("simulated containment commit failure") as NodeJS.ErrnoException;
      error.code = "EROFS";
      throw error;
    };
    const linkHandlers = new Map<string, typeof fs.linkSync>([
      [containmentPath, rejectContainment],
    ]);
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((_existingPath, newPath) => {
      return (linkHandlers.get(String(newPath)) ?? originalLink)(_existingPath, newPath);
    });

    try {
      const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args, {
        retryDelayMs: 1,
        maxRestoreAttempts: 1,
      });
      expect(exitCode).toBe(1);
    } finally {
      linkSpy.mockRestore();
    }

    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(false);
    expect(fs.existsSync(mutationLockPath)).toBe(true);
    expect(fs.existsSync(deadlinePath)).toBe(true);
    expect(fs.readFileSync(path.join(stateDir, "shields-audit.jsonl"), "utf-8")).toContain(
      "Correct the state-directory write failure",
    );
  });

  it("stops retrying when transition takeover commits durable containment", async () => {
    const timer = await import("./timer");
    const { args, markerPath, mutationLockPath, sandboxName, stateDir } =
      createFailedRestoreFixture("takeover-contain", timer.parseTimerArgs);
    shieldsIndexMock.prepareAutoRestoreTransitionTakeover.mockImplementationOnce(() => {
      beginCommittedMcpLifecycleContainmentSync(
        sandboxName,
        PROCESS_TOKEN,
        "transition takeover requires operator recovery",
        stateDir,
      );
      throw new Error("transition takeover stopped");
    });

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args, {
      retryDelayMs: 1,
      maxRestoreAttempts: 3,
    });

    expect(exitCode).toBe(1);
    expect(shieldsIndexMock.prepareAutoRestoreTransitionTakeover).toHaveBeenCalledTimes(1);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(mutationLockPath)).toBe(false);
    expect(fs.existsSync(`${mutationLockPath}.deadline`)).toBe(false);
    expect(fs.existsSync(`${mutationLockPath}.containment`)).toBe(true);
  });

  it("retains recovery authority when the locked-state commit cannot be persisted", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify({ shieldsDown: true }), { mode: 0o600 });
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    const originalRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      switch (String(destination)) {
        case stateFile: {
          const error = new Error("simulated state commit failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      }
      return originalRename(source, destination);
    });
    try {
      const args = timer.parseTimerArgs([
        sandboxName,
        snapshotPath,
        restoreAtIso,
        "",
        "",
        PROCESS_TOKEN,
      ]);
      expect(args).not.toBeNull();
      await invokeTimerAndExpectRetry(timer.runRestoreTimer, args);
    } finally {
      renameSpy.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).shieldsDown).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("persists the Hermes lock result after one runtime provider state mutation and read-only confirmation (#10155)", async () => {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const agentName = "hermes";
    const configPath = "/sandbox/.hermes/config.yaml";
    const configDir = "/sandbox/.hermes";
    const sensitiveHashPath = `${configDir}/.config-hash`;
    const sensitiveEnvPath = `${configDir}/.env`;
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
        agentName,
      }),
    );

    const sealedHashes = {
      [configPath]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      [sensitiveHashPath]: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      [sensitiveEnvPath]: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    };

    const lockMock = vi.fn(() => ({
      chattrApplied: false,
      fileHashes: { [configPath]: "0".repeat(64) },
    }));
    const confirmMock = vi.fn(() => ({
      chattrApplied: true,
      fileHashes: sealedHashes,
    }));
    const indexModule = await import("./index");
    (indexModule.lockAgentConfig as ReturnType<typeof vi.fn>).mockImplementation(lockMock);
    (
      indexModule.resolveHermesShieldsProtocol as ReturnType<typeof vi.fn>
    ).mockReturnValue("provider-state-mutation-v2");
    (
      indexModule.hermesProviderLockConfirmation as ReturnType<typeof vi.fn>
    ).mockReturnValue(confirmMock);

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
      "0",
      "",
      "",
      agentName,
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(exitCode).toBe(0);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledWith(
      sandboxName,
      snapshotPath,
      { deadlineAuthoritative: true, transitionProcessToken: PROCESS_TOKEN },
    );
    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(
      confirmMock.mock.invocationCallOrder[0]!,
    );
    expect(updatedState.shieldsDown).toBe(false);
    expect(updatedState.chattrApplied).toBe(true);
    expect(updatedState.fileHashes).toEqual(sealedHashes);
    expect(updatedState.fileHashes[sensitiveHashPath]).toBeDefined();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("preserves the Deep Agents lock protocol through shared target resolution (#7977)", async () => {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "dcode-safety";
    const agentName = "langchain-deepagents-code";
    const configPath = "/sandbox/.deepagents/config.toml";
    const configDir = "/sandbox/.deepagents";
    const sensitiveHashPath = `${configDir}/.config-hash`;
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
        agentName,
      }),
    );

    const lockMock = vi.fn(() => ({
      chattrApplied: false,
      fileHashes: {
        [configPath]: "a".repeat(64),
        [sensitiveHashPath]: "b".repeat(64),
      },
    }));
    const indexModule = await import("./index");
    (indexModule.lockAgentConfig as ReturnType<typeof vi.fn>).mockImplementation(lockMock);

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
      "0",
      "",
      "",
      agentName,
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const fallbackTarget = {
      agentName,
      configPath,
      configDir,
      sensitiveFiles: [sensitiveHashPath],
      stateLockPlanInImage: false,
    };

    expect(shieldsIndexMock.resolvePersistedAutoRestoreTarget).toHaveBeenCalledWith(
      sandboxName,
      args,
    );
    expect(exitCode).toBe(0);
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(lockMock).toHaveBeenNthCalledWith(
      1,
      sandboxName,
      fallbackTarget,
      false,
      false,
      "sealed-plan-v1",
    );
    expect(lockMock).toHaveBeenNthCalledWith(
      2,
      sandboxName,
      fallbackTarget,
      false,
      false,
      "sealed-plan-v1",
    );
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("leaves shields down and audits when the lock helper export is unavailable", async () => {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const configPath = "/sandbox/.openclaw/openclaw.json";
    const configDir = "/sandbox/.openclaw";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const auditFile = path.join(stateDir, "shields-audit.jsonl");

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify({ shieldsDown: true }, null, 2));
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    shieldsIndexMock.lockAgentConfig = undefined;

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    await invokeTimerAndExpectRetry(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const auditEntries = fs
      .readFileSync(auditFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(updatedState.shieldsDown).toBe(true);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "shields_auto_restore_lock_warning",
        sandbox: sandboxName,
        warning: "Shields lock helper is unavailable; cannot verify auto-restore lock state",
        lock_verified: false,
      }),
    );
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "shields_up_failed",
        sandbox: sandboxName,
        error: "Config re-lock verification failed — shields remain DOWN",
      }),
    );
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #4663 — auto-restore durability against post-lock perm revert
  //
  // On DGX Station / DGX Spark the auto-restore lock succeeds and verifies
  // (444 root:root), but an in-sandbox reconciler (OpenClaw gateway /
  // doctor-style perm normalization) re-touches `.config-hash` in place
  // *after* the lock returns, reverting it to 660 sandbox:sandbox. Content is
  // unchanged (the SHA-256 seal still matches), so only mode/owner drift, and
  // the next `shields status` reports UP (DRIFTED). The auto-restore path
  // performs a single instantaneous verify (inside lockAgentConfig) and never
  // re-confirms after the gateway has had a chance to settle.
  //
  // Contract the fix must satisfy: after restoring policy, the timer must
  // re-verify the lock held once the gateway has settled and re-apply if it
  // drifted; it must only mark shields UP when a re-confirm passes 444 root:root
  // after the settle window, otherwise leave shields DOWN with an audit warning.
  // (This narrows the revert window; it does not close the TOCTOU.)
  // -------------------------------------------------------------------------

  it("re-verifies the auto-restore lock after settle so a reconciler reverting .config-hash perms is caught (#4663)", async () => {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const configPath = "/sandbox/.openclaw/openclaw.json";
    const configDir = "/sandbox/.openclaw";
    const sensitiveHashPath = `${configDir}/.config-hash`;
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    const sealedHashes = {
      [configPath]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      [sensitiveHashPath]: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };
    const lockMock = vi.fn(() => ({ chattrApplied: true, fileHashes: sealedHashes }));

    const indexModule = await import("./index");
    (indexModule.lockAgentConfig as ReturnType<typeof vi.fn>).mockImplementation(lockMock);

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    const exitCode = await invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    // A single instantaneous lock+verify cannot prove the gateway didn't
    // re-permission .config-hash afterward. The fix must re-confirm the lock
    // held after the gateway settled, which re-invokes the verified lock path.
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).shieldsDown).toBe(false);
  });

  it("leaves shields DOWN and audits when the post-settle re-lock cannot hold .config-hash perms (#4663)", async () => {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
    const configPath = "/sandbox/.openclaw/openclaw.json";
    const configDir = "/sandbox/.openclaw";
    const sensitiveHashPath = `${configDir}/.config-hash`;
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const auditFile = path.join(stateDir, "shields-audit.jsonl");

    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify({ shieldsDown: true }, null, 2));
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAtIso,
        processToken: PROCESS_TOKEN,
      }),
    );

    const sealedHashes = {
      [configPath]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      [sensitiveHashPath]: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };
    // First lock succeeds and verifies; on re-confirmation the gateway has
    // reverted .config-hash, so the verified lock path throws drift.
    const lockMock = vi
      .fn()
      .mockImplementationOnce(() => ({ chattrApplied: true, fileHashes: sealedHashes }))
      .mockImplementation(() => {
        throw new Error(
          "Config not locked: /sandbox/.openclaw/.config-hash mode=660 (expected 444), /sandbox/.openclaw/.config-hash owner=sandbox:sandbox (expected root:root)",
        );
      });

    const indexModule = await import("./index");
    (indexModule.lockAgentConfig as ReturnType<typeof vi.fn>).mockImplementation(lockMock);

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();

    await invokeTimerAndExpectRetry(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const auditEntries = fs
      .readFileSync(auditFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(updatedState.shieldsDown).toBe(true);
    // Both audit outcomes must fire: the re-lock warning AND the terminal
    // fail-closed entry that keeps shields DOWN.
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "shields_auto_restore_lock_warning",
        sandbox: sandboxName,
        lock_verified: false,
      }),
    );
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: "shields_up_failed",
        sandbox: sandboxName,
        error: "Config re-lock verification failed — shields remain DOWN",
      }),
    );
  });
});
