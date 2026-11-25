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
          : `/usr/local/bin/cloudflared tunnel --url http://localhost:${readFileSync(join(pidDir, "cloudflared.dashboard-port"), "utf-8")} --http-host-header localhost`,
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
    const expectedArgv = `argv:tunnel --url http://localhost:${finalTarget} --http-host-header localhost`;
    const otherPort = finalTarget === "12345" ? "18791" : "12345";
    expect(["12345", "18791"]).toContain(finalTarget);
    expect(finalLog).toContain(expectedArgv);
    expect(finalLog).not.toContain(`argv:tunnel --url http://localhost:${otherPort}`);
  });

  it("replaces a running quick tunnel that lacks the host header flag", async () => {
    const binDir = join(tmpDir, "bin");
    const fakeCloudflared = join(binDir, "cloudflared");
    const signaledPids = new Set<number>();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeCloudflared,
      [
        "#!/usr/bin/env node",
        "console.log(`argv:${process.argv.slice(2).join(' ')}`);",
        "console.log('https://replaced.trycloudflare.com');",
        "setInterval(() => {}, 20_000);",
      ].join("\n"),
    );
    chmodSync(fakeCloudflared, 0o700);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    vi.spyOn(console, "log").mockImplementation(() => {});

    mkdirSync(pidDir, { recursive: true });
    const oldPid = 42424;
    writeFileSync(join(pidDir, "cloudflared.pid"), String(oldPid));
    writeFileSync(join(pidDir, "cloudflared.dashboard-port"), "18789");
    writeFileSync(join(pidDir, "cloudflared.log"), "https://old.trycloudflare.com\n");

    const processControl: ProcessControl = {
      isAlive: (pid) => (pid === oldPid ? !signaledPids.has(oldPid) : true),
      commandLine: (pid) =>
        pid === oldPid
          ? "/usr/local/bin/cloudflared tunnel --url http://localhost:18789"
          : "/usr/local/bin/cloudflared tunnel --url http://localhost:18789 --http-host-header localhost",
      signalCloudflared: (pid) => {
        signaledPids.add(pid);
        return "signaled";
      },
    };

    await startAll({ pidDir, dashboardPort: 18_789, processControl });

    expect(signaledPids.has(oldPid)).toBe(true);
    const finalPid = Number(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8"));
    const finalLog = readFileSync(join(pidDir, "cloudflared.log"), "utf-8");
    expect(finalPid).not.toBe(oldPid);
    expect(finalLog).toContain(
      "argv:tunnel --url http://localhost:18789 --http-host-header localhost",
    );
  });

  it("reuses a running quick tunnel when target and host header match", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(pidDir, { recursive: true });
    const existingPid = 53535;
    writeFileSync(join(pidDir, "cloudflared.pid"), String(existingPid));
    writeFileSync(join(pidDir, "cloudflared.dashboard-port"), "18789");
    writeFileSync(join(pidDir, "cloudflared.log"), "https://reused.trycloudflare.com\n");

    let signalCalled = false;
    const processControl: ProcessControl = {
      isAlive: (pid) => pid === existingPid,
      commandLine: () =>
        "/usr/local/bin/cloudflared tunnel --url http://localhost:18789 --http-host-header localhost",
      signalCloudflared: () => {
        signalCalled = true;
        return "signaled";
      },
    };

    await startAll({ pidDir, dashboardPort: 18_789, processControl });

    expect(signalCalled).toBe(false);
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe(String(existingPid));
  });
});
