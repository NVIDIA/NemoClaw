// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { execTimeout } from "./helpers/timeouts";

const NEMOCLAW_CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const DEEPAGENTS_ALIAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-deepagents-bin-"));
const DEEPAGENTS_CLI = path.join(DEEPAGENTS_ALIAS_DIR, "nemo-deepagents");
fs.symlinkSync(NEMOCLAW_CLI, DEEPAGENTS_CLI);

afterAll(() => {
  fs.rmSync(DEEPAGENTS_ALIAS_DIR, { force: true, recursive: true });
});

function runDeepAgents(
  args: string,
  env: Record<string, string | undefined> = {},
): { code: number; out: string } {
  try {
    const out = execSync(`"${DEEPAGENTS_CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: "/tmp/nemo-deepagents-test-" + Date.now(),
        // Clear inherited markers so the launcher under test sets them itself.
        NEMOCLAW_AGENT: undefined,
        NEMOCLAW_INVOKED_AS: undefined,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    return { code: e.status ?? 1, out: stdout + stderr };
  }
}

function runNemoClaw(
  args: string,
  env: Record<string, string | undefined> = {},
): { code: number; out: string } {
  try {
    const out = execSync(`node "${NEMOCLAW_CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: "/tmp/nemo-deepagents-test-" + Date.now(),
        // Clear inherited markers so the base nemoclaw bin has a clean slate.
        NEMOCLAW_AGENT: undefined,
        NEMOCLAW_INVOKED_AS: undefined,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    return { code: e.status ?? 1, out: stdout + stderr };
  }
}

describe("nemo-deepagents alias", () => {
  it("package-style nemo-deepagents symlink exists and is executable", () => {
    expect(fs.existsSync(DEEPAGENTS_CLI)).toBe(true);
    const stat = fs.statSync(DEEPAGENTS_CLI);
    // Owner execute bit on the target launcher
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("--version outputs nemo-deepagents branding", () => {
    const { code, out } = runDeepAgents("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemo-deepagents v[\d.]+/);
  });

  it("nemoclaw --version does not contain nemo-deepagents", () => {
    const { code, out } = runNemoClaw("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemoclaw v[\d.]+/);
    expect(out).not.toContain("nemo-deepagents");
  });

  it("help output shows NemoDeepAgents header and alias command names", () => {
    const { code, out } = runDeepAgents("--help");
    expect(code).toBe(0);
    expect(out).toContain("NemoDeepAgents");
    expect(out).toContain("nemo-deepagents onboard");
    expect(out).not.toContain("nemoclaw onboard");
  });

  it("routes nemo-deepagents uninstall as a global command, not a sandbox connect command", () => {
    const { code, out } = runDeepAgents("uninstall --help");
    expect(code).toBe(0);
    expect(out).toContain("NemoDeepAgents Uninstaller");
    expect(out).toContain("internal uninstall run-plan");
    expect(out).not.toContain("uninstall connect");
  });

  it("NEMOCLAW_AGENT and NEMOCLAW_INVOKED_AS are set by the launcher", () => {
    // The launcher sets both env vars before requiring dist/nemoclaw.
    // --version shows nemo-deepagents branding only when both are set.
    const { code, out } = runDeepAgents("--version");
    expect(code).toBe(0);
    expect(out).toContain("nemo-deepagents");
  });

  it("nemoclaw onboard --agent langchain-deepagents-code keeps the nemoclaw CLI name in suggestions", () => {
    const { code, out } = runNemoClaw(
      "onboard --agent langchain-deepagents-code --resume --non-interactive --yes-i-accept-third-party-software",
    );
    expect(code).toBe(1);
    expect(out).toContain("nemoclaw onboard");
    expect(out).not.toMatch(/\bnemo-deepagents\b/);
  });

  it("NEMOCLAW_AGENT=langchain-deepagents-code nemoclaw also keeps the nemoclaw CLI name", () => {
    const { code, out } = runNemoClaw(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      { NEMOCLAW_AGENT: "langchain-deepagents-code" },
    );
    expect(code).toBe(1);
    expect(out).toContain("nemoclaw onboard");
    expect(out).not.toMatch(/\bnemo-deepagents\b/);
  });
});
