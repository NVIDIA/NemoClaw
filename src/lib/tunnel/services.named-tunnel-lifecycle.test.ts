// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { withMcpLifecycleLock } from "../state/mcp-lifecycle-lock-acquisition";
import { type ProcessControl, readCloudflaredState, showStatus, startAll } from "./services";

describe("showStatus named tunnel diagnostics", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-named-tunnel-status-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("explains how to diagnose a running named tunnel with no logged ingress route", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared: vi.fn(() => "signaled" as const),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    showStatus({ pidDir, dashboardPort: 18_791, processControl });

    const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join("\n");
    expect(output).toContain("cloudflared  (PID");
    expect(output).toContain("dashboard target is unconfirmed for port 18791");
    expect(output).toContain("rerun `nemoclaw tunnel status`");
  });

  it("shows the configured public URL when the named ingress targets the selected port", () => {
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "cloudflared.pid"), String(process.pid));
    writeFileSync(
      join(pidDir, "cloudflared.log"),
      'config="{\\"ingress\\":[{\\"hostname\\":\\"agent.example.com\\", \\"service\\":\\"http://localhost:18791\\"}]}"',
    );
    const commandLine = vi.fn(() => "cloudflared tunnel run");
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine,
      signalCloudflared: vi.fn(() => "signaled" as const),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    showStatus({ pidDir, dashboardPort: 18_791, processControl });

    const output = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join("\n");
    expect(output).toContain("https://agent.example.com");
    expect(output).not.toContain("dashboard target is unconfirmed");
    expect(commandLine).toHaveBeenCalledTimes(2);
  });
});

describe("startAll named tunnel validation", () => {
  let tmpDir: string;
  let pidDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-named-tunnel-test-"));
    pidDir = join(tmpDir, "pids");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it(
    "stops a new named tunnel when its ingress configuration is not confirmed",
    testTimeoutOptions(25_000),
    async () => {
      const originalPath = process.env.PATH;
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      writeFileSync(fakeCloudflared, "#!/usr/bin/env sh\nexec sleep 20\n");
      chmodSync(fakeCloudflared, 0o700);
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let alive = true;
      const signalCloudflared = vi.fn((pid: number, signal: NodeJS.Signals) => {
        alive = false;
        process.kill(pid, signal);
        return "signaled" as const;
      });
      const processControl: ProcessControl = {
        isAlive: () => alive,
        commandLine: () => "cloudflared tunnel run",
        signalCloudflared,
      };
      try {
        await expect(
          startAll({
            pidDir,
            dashboardPort: 18_791,
            cloudflareTunnelToken: "named-secret",
            processControl,
          }),
        ).rejects.toThrow("did not log its ingress route");
        expect(readCloudflaredState(pidDir, processControl).kind).toBe("stopped");
        expect(signalCloudflared).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
        expect(logSpy.mock.calls.flat().join("\n")).not.toContain(
          "dashboard target is unconfirmed",
        );
        expect(() => readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toThrow();
      } finally {
        process.env.PATH = originalPath;
      }
    },
  );

  it("does not stop a replacement tunnel while waiting for the lifecycle lock", async () => {
    mkdirSync(pidDir, { recursive: true });
    const originalPid = process.pid + 1000;
    writeFileSync(join(pidDir, "cloudflared.pid"), String(originalPid));
    writeFileSync(
      join(pidDir, "cloudflared.log"),
      'config="{\\"ingress\\":[{\\"hostname\\":\\"agent.example.com\\", \\"service\\":\\"http://localhost:18791\\"}]}"',
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const signalCloudflared = vi.fn(() => "signaled" as const);
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared,
    };
    const replacementPid = process.pid + 2000;
    const lifecycleLockName = `cloudflared-${createHash("sha256")
      .update(resolve(pidDir))
      .digest("hex")}`;
    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const lockReleased = new Promise<void>((resolveLock) => {
      releaseLock = resolveLock;
    });
    const lockIsAcquired = new Promise<void>((resolveLock) => {
      lockAcquired = resolveLock;
    });
    const lockPromise = withMcpLifecycleLock(lifecycleLockName, async () => {
      lockAcquired();
      await lockReleased;
    });
    await lockIsAcquired;
    const startPromise = startAll({
      pidDir,
      dashboardPort: 18_791,
      cloudflareTunnelToken: "named-secret",
      processControl,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const pidFile = join(pidDir, "cloudflared.pid");
    const replacementPidFile = join(pidDir, "cloudflared.pid.replacement");
    writeFileSync(replacementPidFile, String(replacementPid), { flag: "wx", mode: 0o600 });
    renameSync(replacementPidFile, pidFile);
    releaseLock();
    await lockPromise;
    await startPromise;

    expect(readFileSync(pidFile, "utf-8")).toBe(String(replacementPid));
    expect(signalCloudflared).not.toHaveBeenCalled();
  });
});
