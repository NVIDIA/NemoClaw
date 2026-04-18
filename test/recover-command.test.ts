// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function runWithEnv(args: string, env: Record<string, string> = {}) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 10000),
      env: {
        ...process.env,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status: number; stdout?: string; stderr?: string };
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function setupSandboxHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recover-"));
  const localBin = path.join(home, "bin");
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        "test-sb": {
          name: "test-sb",
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "test-sb",
    }),
    { mode: 0o600 },
  );

  // Stub openshell so sandbox exec calls don't fail
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    ["#!/usr/bin/env bash", 'echo "{}"', "exit 0"].join("\n"),
    { mode: 0o755 },
  );

  return { home, localBin };
}

describe("nemoclaw <name> recover", () => {
  const homes: string[] = [];
  afterAll(() => {
    for (const home of homes) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("recover is listed as a valid action in the error message for unknown actions", () => {
    const { home } = setupSandboxHome();
    homes.push(home);
    const r = runWithEnv("test-sb bogusaction", {
      HOME: home,
      PATH: `${path.join(home, "bin")}:${process.env.PATH}`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("recover");
    expect(r.out).toContain("Valid actions");
  });

  it("recover exits 0 when gateway is not detectable (no-op / idempotent)", () => {
    const { home } = setupSandboxHome();
    homes.push(home);
    const r = runWithEnv("test-sb recover", {
      HOME: home,
      PATH: `${path.join(home, "bin")}:${process.env.PATH}`,
    });
    // checkAndRecoverSandboxProcesses returns early when isSandboxGatewayRunning
    // returns null (sandbox not reachable) — no crash, exit 0
    expect(r.code).toBe(0);
  });
});
