// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProcessControl } from "./services";
import {
  readCloudflaredState,
  signalCloudflaredForPlatform,
  stopAll,
  stopCloudflared,
} from "./services";

vi.mock("./allowed-origins", () => ({ registerTunnelOrigin: vi.fn() }));

describe("cloudflared identity-bound signaling", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-tunnel-signal-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(pidDir, { recursive: true, force: true });
  });

  it("retains service state when identity-bound signaling is unavailable", () => {
    const processControl: ProcessControl = {
      isAlive: () => true,
      commandLine: () => "cloudflared tunnel run",
      signalCloudflared: () => "unavailable",
    };
    writeFileSync(join(pidDir, "cloudflared.pid"), "4242", { mode: 0o600 });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => stopAll({ pidDir, processControl, cleanupOllamaModels: false })).toThrow(
      "cloudflared could not be stopped; its process and state were retained",
    );
    expect(readFileSync(join(pidDir, "cloudflared.pid"), "utf-8")).toBe("4242");
  });

  it("uses identity-bound platform signaling and refuses unsupported platforms", () => {
    const signal = vi.fn(() => "signaled" as const);
    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "darwin", signal)).toBe("signaled");
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
    const windowsSignal = vi.fn(() => "signaled" as const);
    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "win32", signal, windowsSignal)).toBe(
      "signaled",
    );
    expect(windowsSignal).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(signalCloudflaredForPlatform(4242, "SIGTERM", "freebsd" as NodeJS.Platform)).toBe(
      "unavailable",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "signals only the verified cloudflared process through a macOS audit token",
    async () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      const pid = subprocess.pid as number;
      const exited = new Promise<void>((resolveExit) =>
        subprocess.once("exit", () => resolveExit()),
      );

      try {
        expect(signalCloudflaredForPlatform(pid, "SIGTERM")).toBe("signaled");
        await exited;
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound signal already stopped the test-owned process.
        }
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "does not signal a live non-cloudflared process on macOS",
    () => {
      const subprocess = childProcess.spawn("/bin/sleep", ["20"], { stdio: "ignore" });
      const pid = subprocess.pid as number;

      try {
        expect(signalCloudflaredForPlatform(pid, "SIGTERM")).toBe("not-cloudflared");
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The test-owned process already exited.
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "signals only the verified cloudflared process through a Linux pidfd",
    async () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      const pid = subprocess.pid as number;
      const exited = new Promise<void>((resolveExit) =>
        subprocess.once("exit", () => resolveExit()),
      );

      try {
        expect(signalCloudflaredForPlatform(pid, "SIGTERM")).toBe("signaled");
        await exited;
        expect(existsSync(`/proc/${String(pid)}/status`)).toBe(false);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound signal already stopped the test-owned process.
        }
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "stops only the confirmed cloudflared process through its Windows process handle",
    async () => {
      const executable = join(pidDir, "cloudflared.exe");
      copyFileSync(process.execPath, executable);
      const subprocess = childProcess.spawn(executable, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const pid = subprocess.pid as number;
      writeFileSync(join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });
      const exited = new Promise<void>((resolveExit) =>
        subprocess.once("exit", () => resolveExit()),
      );

      try {
        const state = readCloudflaredState(pidDir);
        expect(state).toEqual(
          state.kind === "running"
            ? { kind: "running", pid }
            : { kind: "unverified-pid-process", pid, reason: "inspection-unavailable" },
        );
        expect(stopCloudflared({ pidDir })).toBe(true);
        await exited;
        expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
        expect(signalCloudflaredForPlatform(process.pid, "SIGTERM")).toBe("not-cloudflared");
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound process handle already stopped the test process.
        }
        await exited;
      }
    },
    30_000,
  );
});
