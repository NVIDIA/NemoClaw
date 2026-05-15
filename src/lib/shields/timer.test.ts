// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  lockAgentConfig: vi.fn(),
}));

describe("shields timer authorization", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shields-timer-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function invokeTimerAndCaptureExit(
    runRestoreTimer: (args: any) => void,
    args: unknown,
  ): number {
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
});
