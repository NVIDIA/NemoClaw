// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ProcessControl, readCloudflaredState, startAll } from "./services";

vi.mock("./allowed-origins", () => ({ registerTunnelOrigin: vi.fn() }));

describe("concurrent quick-tunnel starts", () => {
  let tmpDir: string;
  let pidDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-concurrent-start-test-"));
    pidDir = join(tmpDir, "pids");
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    const state = readCloudflaredState(pidDir);
    const runningPid = state.kind === "running" ? state.pid : null;
    try {
      runningPid && process.kill(runningPid, "SIGTERM");
    } catch {
      // The test-owned process may already have exited.
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("serializes overlapping starts and leaves one coherent final target", async () => {
    const binDir = join(tmpDir, "bin");
    const fakeCloudflared = join(binDir, "cloudflared");
    const signaledPids = new Set<number>();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeCloudflared,
      [
        "#!/usr/bin/env node",
        "console.log(`argv:${process.argv.slice(2).join(' ')}`);",
        "console.log('https://concurrent.trycloudflare.com');",
        "setInterval(() => {}, 20_000);",
      ].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const processControl: ProcessControl = {
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return !signaledPids.has(pid);
        } catch {
          return false;
        }
      },
      commandLine: (pid) =>
        pid === process.pid
          ? process.argv.join(" ")
          : `/usr/local/bin/cloudflared tunnel --url http://localhost:${readFileSync(join(pidDir, "cloudflared.dashboard-port"), "utf-8")}`,
      signalCloudflared: (pid, signal) => {
        process.kill(pid, signal);
        // The lifecycle poll is synchronous, so Node cannot reap this child
        // until startAll returns to the event loop.
        signaledPids.add(pid);
        return "signaled";
      },
    };

    await Promise.all([
      startAll({ pidDir, dashboardPort: 12_345, processControl }),
      startAll({ pidDir, dashboardPort: 18_791, processControl }),
    ]);

    const finalPid = Number(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8"));
    const finalTarget = readFileSync(join(pidDir, "cloudflared.dashboard-port"), "utf-8");
    const finalLog = readFileSync(join(pidDir, "cloudflared.log"), "utf-8");
    expect(finalPid).toBeGreaterThan(0);
    const expectedArgv = `argv:tunnel --url http://localhost:${finalTarget}`;
    const otherPort = finalTarget === "12345" ? "18791" : "12345";
    expect(["12345", "18791"]).toContain(finalTarget);
    expect(finalLog).toContain(expectedArgv);
    expect(finalLog).not.toContain(`argv:tunnel --url http://localhost:${otherPort}`);
  });
});
