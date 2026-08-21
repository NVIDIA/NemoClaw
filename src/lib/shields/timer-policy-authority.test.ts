// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyAuthorityRefusalError } from "../adapters/openshell/policy-authority";
import { getMcpLifecycleLockPath } from "../state/mcp-lifecycle-lock";

const shieldsIndexMock = vi.hoisted(() => ({
  applyShieldsPolicySnapshot: vi.fn(() => ({ status: 0 })),
  assertShieldsPolicyMutationAuthority: vi.fn(),
  completeAutoRestoreTransition: vi.fn(() => true),
  lockAgentConfig: vi.fn() as unknown,
  prepareAutoRestoreTransitionTakeover: vi.fn(),
  relockAgentConfigAfterPolicyAuthorityRefusal: vi.fn() as unknown,
  resolvePersistedAutoRestoreTarget: vi.fn() as unknown,
}));

vi.mock("./index", () => ({
  applyShieldsPolicySnapshot: shieldsIndexMock.applyShieldsPolicySnapshot,
  assertShieldsPolicyMutationAuthority: shieldsIndexMock.assertShieldsPolicyMutationAuthority,
  completeAutoRestoreTransition: shieldsIndexMock.completeAutoRestoreTransition,
  get lockAgentConfig() {
    return shieldsIndexMock.lockAgentConfig;
  },
  prepareAutoRestoreTransitionTakeover: shieldsIndexMock.prepareAutoRestoreTransitionTakeover,
  get relockAgentConfigAfterPolicyAuthorityRefusal() {
    return shieldsIndexMock.relockAgentConfigAfterPolicyAuthorityRefusal;
  },
  get resolvePersistedAutoRestoreTarget() {
    return shieldsIndexMock.resolvePersistedAutoRestoreTarget;
  },
}));

const PROCESS_TOKEN = "a".repeat(32);

describe("Shields timer policy authority", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-timer-authority-"));
    vi.stubEnv("HOME", tmpHome);
    shieldsIndexMock.applyShieldsPolicySnapshot.mockReturnValue({ status: 0 });
    shieldsIndexMock.assertShieldsPolicyMutationAuthority.mockImplementation(() => undefined);
    shieldsIndexMock.completeAutoRestoreTransition.mockReturnValue(true);
    shieldsIndexMock.lockAgentConfig = vi.fn();
    shieldsIndexMock.relockAgentConfigAfterPolicyAuthorityRefusal = vi.fn(() => ({
      chattrApplied: true,
      fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
    }));
    shieldsIndexMock.resolvePersistedAutoRestoreTarget = vi.fn(
      (_sandboxName: string, marker: { configPath?: string; configDir?: string }) =>
        marker.configPath && marker.configDir
          ? {
              configPath: marker.configPath,
              configDir: marker.configDir,
              sensitiveFiles: [`${marker.configDir}/.config-hash`],
              stateLockPlanInImage: false,
            }
          : undefined,
    );
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createFixture(
    sandboxName: string,
    parseTimerArgs: (argv: string[]) => unknown,
    configPath = "",
    configDir = "",
  ) {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const restoreAtIso = new Date().toISOString();
    const mutationLockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  default: {}\n");
    fs.writeFileSync(stateFile, JSON.stringify({ shieldsDown: true }));
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
    const args = parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();
    return {
      args,
      containmentPath: `${mutationLockPath}.containment`,
      markerPath,
      stateFile,
    };
  }

  function captureExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  }

  it("relocks config without retrying a final policy-authority refusal (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture(
      "external-authority",
      timer.parseTimerArgs,
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw",
    );
    shieldsIndexMock.applyShieldsPolicySnapshot.mockImplementation(() => {
      throw new PolicyAuthorityRefusalError(
        "Refusing to restore the Shields policy snapshot: OpenShell policy is externally managed.",
      );
    });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(shieldsIndexMock.relockAgentConfigAfterPolicyAuthorityRefusal).toHaveBeenCalledOnce();
    expect(shieldsIndexMock.relockAgentConfigAfterPolicyAuthorityRefusal).toHaveBeenCalledWith(
      "external-authority",
      expect.objectContaining({
        configDir: "/sandbox/.openclaw",
        configPath: "/sandbox/.openclaw/openclaw.json",
      }),
      PROCESS_TOKEN,
      false,
    );
    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"))).toEqual({
      shieldsDown: true,
    });
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
    expect(fs.existsSync(fixture.containmentPath)).toBe(false);
    const auditPath = path.join(tmpHome, ".nemoclaw", "state", "shields-audit.jsonl");
    const audits = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string });
    expect(audits.some(({ action }) => action === "shields_auto_restore")).toBe(false);
  });

  it("stops after policy restore when policy authority changes (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture("alpha", timer.parseTimerArgs);
    shieldsIndexMock.assertShieldsPolicyMutationAuthority.mockImplementation(() => {
      throw new PolicyAuthorityRefusalError("Policy authority changed during automatic restore");
    });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(shieldsIndexMock.assertShieldsPolicyMutationAuthority).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
    expect(fs.existsSync(fixture.containmentPath)).toBe(false);
  });

  it("stops after config relock when policy authority changes (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture(
      "beta",
      timer.parseTimerArgs,
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw",
    );
    shieldsIndexMock.lockAgentConfig = vi.fn(() => ({
      chattrApplied: true,
      fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
    }));
    shieldsIndexMock.assertShieldsPolicyMutationAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new PolicyAuthorityRefusalError("Policy authority changed after config relock");
      });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(shieldsIndexMock.applyShieldsPolicySnapshot).toHaveBeenCalledTimes(1);
    expect(shieldsIndexMock.assertShieldsPolicyMutationAuthority).toHaveBeenCalledTimes(3);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"))).toEqual({
      shieldsDown: true,
    });
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
  });

  it("checks policy authority before every automatic config relock retry (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture(
      "retry-race",
      timer.parseTimerArgs,
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw",
    );
    const lockResult = {
      chattrApplied: true,
      fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
    };
    shieldsIndexMock.lockAgentConfig = vi
      .fn()
      .mockReturnValueOnce(lockResult)
      .mockImplementationOnce(() => {
        throw new Error("config lock drifted during settle");
      })
      .mockReturnValue(lockResult);
    shieldsIndexMock.assertShieldsPolicyMutationAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new PolicyAuthorityRefusalError("Policy authority changed before relock retry");
      });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(shieldsIndexMock.lockAgentConfig).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
  });

  it("retains timer recovery when authority changes during UP-state persistence (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture("state-race", timer.parseTimerArgs);
    shieldsIndexMock.assertShieldsPolicyMutationAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new PolicyAuthorityRefusalError("Policy authority changed during state persistence");
      });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(shieldsIndexMock.completeAutoRestoreTransition).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"))).toMatchObject({
      shieldsDown: false,
    });
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
  });

  it("retains the timer marker when authority changes during transition persistence (#9833)", async () => {
    const timer = await import("./timer");
    const fixture = createFixture("transition-race", timer.parseTimerArgs);
    shieldsIndexMock.assertShieldsPolicyMutationAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new PolicyAuthorityRefusalError(
          "Policy authority changed during transition persistence",
        );
      });
    const exitSpy = captureExit();

    await timer.runRestoreTimer(fixture.args as never, {
      retryDelayMs: 0,
      maxRestoreAttempts: 7,
    });

    expect(shieldsIndexMock.completeAutoRestoreTransition).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(fixture.markerPath)).toBe(true);
  });
});
