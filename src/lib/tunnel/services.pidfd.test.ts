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

import { stopAll } from "./services";

const linuxPidfdAvailable =
  process.platform === "linux" &&
  (() => {
    const probe = childProcess.spawnSync(
      "python3",
      [
        "-c",
        "import os, signal; fd = os.pidfd_open(os.getpid()) if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal') else None; os.close(fd) if fd is not None else None; print('available' if fd is not None else 'unavailable')",
      ],
      { encoding: "utf8", timeout: 1000 },
    );
    return probe.status === 0 && probe.stdout.trim() === "available";
  })();

describe("stopAll Linux pidfd capability", () => {
  let pidDir: string;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-pidfd-test-"));
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
  });

  it.skipIf(!linuxPidfdAvailable)(
    "signals a verified cloudflared process through a Linux pidfd",
    () => {
      const executable = join(pidDir, "cloudflared");
      copyFileSync("/bin/sleep", executable);
      chmodSync(executable, 0o700);
      const subprocess = childProcess.spawn(executable, ["20"], { stdio: "ignore" });
      const pid =
        subprocess.pid ??
        (() => {
          throw new Error("cloudflared test process has no PID");
        })();
      writeFileSync(join(pidDir, "cloudflared.pid"), String(pid), { mode: 0o600 });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const unmanagedCloudflaredPids = (): number[] => [];
      try {
        stopAll({ pidDir, unloadOllamaModels: () => undefined, unmanagedCloudflaredPids });
        const deadline = Date.now() + 1000;
        let processStopped = false;
        while (!processStopped && Date.now() < deadline) {
          try {
            const status = readFileSync(`/proc/${String(pid)}/status`, "utf-8");
            processStopped = /^State:\s+(?:Z|X)/m.test(status);
          } catch {
            // A missing /proc entry also proves that the process exited.
            processStopped = true;
          }
        }
        expect(processStopped).toBe(true);
      } finally {
        logSpy.mockRestore();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The identity-bound stop path already reaped the process.
        }
      }

      expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    },
  );
});
