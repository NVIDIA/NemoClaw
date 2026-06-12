// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shieldsIndexMock = vi.hoisted(() => ({
  lockAgentConfig: vi.fn() as unknown,
}));

const runMock = vi.fn(() => ({ status: 0 }));

vi.mock("../runner", () => ({
  run: runMock,
}));

vi.mock("../policy", () => ({
  buildPolicySetCommand: vi.fn((file: string, name: string) => [
    "openshell",
    "policy",
    "set",
    "--policy",
    file,
    "--wait",
    name,
  ]),
}));

vi.mock("../sandbox/config", () => ({
  DEFAULT_AGENT_CONFIG: Symbol("DEFAULT_AGENT_CONFIG"),
  resolveAgentConfig: vi.fn(() => ({
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
  })),
}));

vi.mock("./index", () => ({
  get lockAgentConfig() {
    return shieldsIndexMock.lockAgentConfig;
  },
}));

describe("shields timer authorization", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-timer-"));
    vi.stubEnv("HOME", tmpHome);
    shieldsIndexMock.lockAgentConfig = vi.fn();
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function invokeTimerAndCaptureExit(runRestoreTimer: (args: any) => void, args: unknown): number {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit:${String(code ?? 0)}`);
    });

    try {
      runRestoreTimer(args);
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

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
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

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
    expect(fs.existsSync(markerPath)).toBe(true);
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
        processToken: "tok",
      }),
    );

    const args = timer.parseTimerArgs([sandboxName, snapshotPath, restoreAtIso, "", "", "tok"]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    expect(exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8"))).toEqual(initialState);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("restores and updates state when marker matches current timer invocation", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    const sandboxName = "alpha";
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
        processToken: "tok",
      }),
    );

    const args = timer.parseTimerArgs([sandboxName, snapshotPath, restoreAtIso, "", "", "tok"]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const stateFile = path.join(stateDir, `shields-${sandboxName}.json`);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(exitCode).toBe(0);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(updatedState.shieldsDown).toBe(false);
    expect(updatedState.shieldsDownAt).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("persists chattrApplied and fileHashes from the auto-restore lock result", async () => {
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
        processToken: "tok",
      }),
    );

    const sealedHashes = {
      [configPath]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      [sensitiveHashPath]: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };

    const lockMock = vi.fn(() => ({
      chattrApplied: true,
      fileHashes: sealedHashes,
    }));
    const sandboxConfigModule = await import("../sandbox/config");
    (sandboxConfigModule.resolveAgentConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      agentName: "openclaw",
      configPath,
      configDir,
      sensitiveFiles: [sensitiveHashPath],
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
      "tok",
    ]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

    expect(exitCode).toBe(0);
    expect(runMock).toHaveBeenCalledTimes(1);
    // #4663: relockAndReconfirm applies then re-confirms after the settle
    // window (0ms under test), so lockAgentConfig is invoked twice for a clean
    // lock.
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(updatedState.shieldsDown).toBe(false);
    expect(updatedState.chattrApplied).toBe(true);
    expect(updatedState.fileHashes).toEqual(sealedHashes);
    expect(updatedState.fileHashes[sensitiveHashPath]).toBeDefined();
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
        processToken: "tok",
      }),
    );

    const sandboxConfigModule = await import("../sandbox/config");
    (sandboxConfigModule.resolveAgentConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      agentName: "openclaw",
      configPath,
      configDir,
      sensitiveFiles: [],
    });
    shieldsIndexMock.lockAgentConfig = undefined;

    const timer = await import("./timer");
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      configPath,
      configDir,
      "tok",
    ]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const auditEntries = fs
      .readFileSync(auditFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(exitCode).toBe(1);
    expect(runMock).toHaveBeenCalledTimes(1);
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
    expect(fs.existsSync(markerPath)).toBe(false);
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

  it("#4663 re-verifies the auto-restore lock after settle so a reconciler reverting .config-hash perms is caught", async () => {
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
        processToken: "tok",
      }),
    );

    const sealedHashes = {
      [configPath]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      [sensitiveHashPath]: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };
    const lockMock = vi.fn(() => ({ chattrApplied: true, fileHashes: sealedHashes }));

    const sandboxConfigModule = await import("../sandbox/config");
    (sandboxConfigModule.resolveAgentConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      agentName: "openclaw",
      configPath,
      configDir,
      sensitiveFiles: [sensitiveHashPath],
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
      "tok",
    ]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);

    // A single instantaneous lock+verify cannot prove the gateway didn't
    // re-permission .config-hash afterward. The fix must re-confirm the lock
    // held after the gateway settled, which re-invokes the verified lock path.
    expect(lockMock).toHaveBeenCalledTimes(2);
    expect(exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).shieldsDown).toBe(false);
  });

  it("#4663 leaves shields DOWN and audits when the post-settle re-lock cannot hold .config-hash perms", async () => {
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
        processToken: "tok",
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

    const sandboxConfigModule = await import("../sandbox/config");
    (sandboxConfigModule.resolveAgentConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      agentName: "openclaw",
      configPath,
      configDir,
      sensitiveFiles: [sensitiveHashPath],
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
      "tok",
    ]);
    expect(args).not.toBeNull();

    const exitCode = invokeTimerAndCaptureExit(timer.runRestoreTimer, args);
    const updatedState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    const auditEntries = fs
      .readFileSync(auditFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(exitCode).toBe(1);
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
