// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const GATEWAY_PORT = 9123;

type PortStateWriters = {
  saveUsageNoticeAcceptance: (version: string) => void;
  collectSandboxCreateFailureDiagnostics: (
    sandboxName: string,
    options: { homeDir: string; now: Date },
  ) => { dir: string } | null;
  collectDockerGpuPatchDiagnostics: (
    sandboxName: string,
    options: object,
    deps: {
      dockerCapture: () => string;
      dockerLogs: () => string;
      homedir: () => string;
      now: () => Date;
    },
  ) => { dir: string } | null;
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadPortStateWriters(home: string): Promise<PortStateWriters> {
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(GATEWAY_PORT));

  const usageNotice = await import("./usage-notice.js");
  const sandboxDiagnostics = await import("./sandbox-create-failure.js");
  const dockerDiagnostics = await import("./docker-gpu-patch-diagnostics.js");
  return {
    saveUsageNoticeAcceptance: usageNotice.saveUsageNoticeAcceptance,
    collectSandboxCreateFailureDiagnostics:
      sandboxDiagnostics.collectSandboxCreateFailureDiagnostics,
    collectDockerGpuPatchDiagnostics: dockerDiagnostics.collectDockerGpuPatchDiagnostics,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("port-scoped host-state writers", () => {
  it("writes each artifact beneath the selected nondefault gateway root", async () => {
    const home = makeTempDir("nemoclaw-port-writers-home-");
    const writers = await loadPortStateWriters(home);
    const now = new Date("2026-07-13T12:00:00.000Z");

    writers.saveUsageNoticeAcceptance("test-version");
    const sandboxDiagnostics = writers.collectSandboxCreateFailureDiagnostics("sandbox", {
      homeDir: home,
      now,
    });
    const dockerDiagnostics = writers.collectDockerGpuPatchDiagnostics(
      "sandbox",
      {},
      {
        dockerCapture: () => "",
        dockerLogs: () => "",
        homedir: () => home,
        now: () => now,
      },
    );

    const selectedRoot = path.join(home, ".nemoclaw", "gateways", String(GATEWAY_PORT));
    expect(fs.existsSync(path.join(selectedRoot, "usage-notice.json"))).toBe(true);
    expect(sandboxDiagnostics?.dir.startsWith(selectedRoot)).toBe(true);
    expect(dockerDiagnostics?.dir.startsWith(selectedRoot)).toBe(true);
  });

  it.each([
    "gateways",
    "port",
  ] as const)("rejects a symlinked %s state ancestor without writing through it", async (symlinkLevel) => {
    const home = makeTempDir("nemoclaw-port-writers-home-");
    const controlled = makeTempDir("nemoclaw-port-writers-target-");
    const sharedRoot = path.join(home, ".nemoclaw");
    const gatewaysRoot = path.join(sharedRoot, "gateways");
    fs.mkdirSync(symlinkLevel === "gateways" ? sharedRoot : gatewaysRoot, { recursive: true });
    fs.symlinkSync(
      controlled,
      symlinkLevel === "gateways" ? gatewaysRoot : path.join(gatewaysRoot, String(GATEWAY_PORT)),
      "dir",
    );
    const writers = await loadPortStateWriters(home);
    const now = new Date("2026-07-13T12:00:00.000Z");

    expect(() => writers.saveUsageNoticeAcceptance("test-version")).toThrow(/symbolic link/i);
    expect(
      writers.collectSandboxCreateFailureDiagnostics("sandbox", { homeDir: home, now }),
    ).toBeNull();
    expect(
      writers.collectDockerGpuPatchDiagnostics(
        "sandbox",
        {},
        {
          dockerCapture: () => "",
          dockerLogs: () => "",
          homedir: () => home,
          now: () => now,
        },
      ),
    ).toBeNull();
    expect(fs.readdirSync(controlled)).toEqual([]);
  });
});
