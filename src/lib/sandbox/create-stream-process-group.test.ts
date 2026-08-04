// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./create-stream";
import { dockerEnv, FakeChild, makePollingOptions } from "./create-stream-test-fixtures";

let startedProcessGroups: number[] = [];
const startedDirs: string[] = [];

function cleanUpStartedProcesses(): void {
  for (const processGroup of startedProcessGroups.splice(0)) {
    try {
      process.kill(-processGroup, "SIGKILL");
    } catch {
      // Best effort only — the owned process group may already be gone.
    }
  }
  for (const dir of startedDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && isRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

function createChildScript(): { markerPath: string; script: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-group-"));
  startedDirs.push(dir);
  const markerPath = path.join(dir, "pids.json");
  const script = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(
  ${JSON.stringify(markerPath)},
  JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
);
setInterval(() => {}, 1000);
`;
  return { markerPath, script };
}

function readStartedPids(markerPath: string): { child: number; grandchild: number } {
  const pids = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    child: number;
    grandchild: number;
  };
  startedProcessGroups.push(pids.child);
  return pids;
}

function releaseStartedProcessGroup(processGroup: number): void {
  startedProcessGroups = startedProcessGroups.filter((candidate) => candidate !== processGroup);
}

describe("sandbox create stream process group (#7982)", () => {
  afterEach(() => {
    cleanUpStartedProcesses();
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform === "win32")(
    "terminates the whole create process group when the ready gate detaches",
    async () => {
      const { markerPath, script } = createChildScript();

      const result = await streamSandboxCreate(process.execPath, ["-e", script], dockerEnv, {
        pollIntervalMs: 10,
        heartbeatIntervalMs: 1_000,
        silentPhaseMs: 10_000,
        logLine: () => {},
        readyCheck: () => fs.existsSync(markerPath),
      });

      const pids = readStartedPids(markerPath);
      expect(result).toMatchObject({ status: 0, forcedReady: true });
      expect(await waitForExit(pids.child)).toBe(true);
      expect(await waitForExit(pids.grandchild)).toBe(true);
      releaseStartedProcessGroup(pids.child);
    },
    30_000,
  );

  it("signals an injected child directly instead of a process group", async () => {
    const child = new FakeChild();
    const killSpy = vi.spyOn(process, "kill");

    const pending = streamSandboxCreate(
      "openshell",
      ["sandbox", "create"],
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => true }),
    );

    await expect(pending).resolves.toMatchObject({ status: 0, forcedReady: true });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("terminates a pending create when the host receives SIGTERM", async () => {
    const child = new FakeChild();
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const listenersBefore = process.listeners("SIGTERM");

    const pending = streamSandboxCreate(
      "openshell",
      ["sandbox", "create"],
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => false }),
    );

    const installed = process
      .listeners("SIGTERM")
      .filter((listener) => !listenersBefore.includes(listener));
    expect(installed).toHaveLength(1);
    (installed[0] as () => void)();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(process.listeners("SIGTERM")).toEqual(listenersBefore);

    child.emit("close", 0);
    await pending;
  });

  it("stops listening for host signals once the create stream settles", async () => {
    const child = new FakeChild();
    const sigintBefore = process.listeners("SIGINT");
    const sigtermBefore = process.listeners("SIGTERM");

    await streamSandboxCreate(
      "openshell",
      ["sandbox", "create"],
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => true }),
    );

    expect(process.listeners("SIGINT")).toEqual(sigintBefore);
    expect(process.listeners("SIGTERM")).toEqual(sigtermBefore);
  });

  it("stops listening for host exit once the create stream settles", async () => {
    const child = new FakeChild();
    const listenersBefore = process.listenerCount("exit");

    await streamSandboxCreate(
      "openshell",
      ["sandbox", "create"],
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => true }),
    );

    expect(process.listenerCount("exit")).toBe(listenersBefore);
  });
});
