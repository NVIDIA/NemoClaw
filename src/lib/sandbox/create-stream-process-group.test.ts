// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./create-stream";
import { dockerEnv, FakeChild, makePollingOptions } from "./create-stream-test-fixtures";

const startedPids: number[] = [];
const startedDirs: string[] = [];

function cleanUpStartedProcesses(): void {
  for (const pid of startedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort only — the process under test should already be gone.
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
  startedPids.push(pids.child, pids.grandchild);
  return pids;
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

      expect(result).toMatchObject({ status: 0, forcedReady: true });
      const pids = readStartedPids(markerPath);
      expect(await waitForExit(pids.child)).toBe(true);
      expect(await waitForExit(pids.grandchild)).toBe(true);
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
