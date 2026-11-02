// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { expectPackageDatabaseReadOnly } from "../live/package-database-read-only.ts";

it("prepares a writable sentinel without chown and removes it after a failed sandbox probe", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dpkg-probe-"));
  const sentinel = path.join(directory, "sentinel");
  const execSandboxAsRoot = vi.fn(async (_name: string, args: readonly string[]) => {
    // Execute the fixture's real commands against a test-owned host path.
    const command = [...args.slice(0, -1), sentinel];
    const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8" });
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    } as ShellProbeResult;
  });
  const execShell = vi.fn(async () => {
    const metadata = fs.statSync(sentinel);
    expect({ mode: metadata.mode & 0o777, uid: metadata.uid }).toEqual({
      mode: 0o666,
      uid: process.getuid!(),
    });
    throw new Error("sandbox probe failed");
  });
  try {
    await expect(
      expectPackageDatabaseReadOnly({
        artifactPrefix: "package-database",
        env: {},
        runtimeProvider: { execSandboxAsRoot } as unknown as RuntimeProviderPrerequisite,
        sandbox: { execShell } as unknown as SandboxClient,
        sandboxName: "alpha",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow("sandbox probe failed");
    expect(execShell).toHaveBeenCalledOnce();
    expect(fs.existsSync(sentinel)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
