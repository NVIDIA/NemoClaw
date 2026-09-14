// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { execTimeout } from "../../helpers/timeouts";

const HERMES_CLI = path.join(import.meta.dirname, "../../..", "bin", "nemohermes.js");
const NEMOCLAW_CLI = path.join(import.meta.dirname, "../../..", "bin", "nemoclaw.js");

vi.setConfig({ maxConcurrency: 4 });

function runHermes(
  args: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-test-"));
  return new Promise((resolve) => {
    exec(
      `node "${HERMES_CLI}" ${args}`,
      {
        encoding: "utf-8",
        timeout: execTimeout(),
        env: {
          ...process.env,
          HOME: home,
          // Clear inherited markers so the launcher under test sets them itself.
          NEMOCLAW_AGENT: undefined,
          NEMOCLAW_INVOKED_AS: undefined,
          NEMOCLAW_HEALTH_POLL_COUNT: "1",
          NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        fs.rmSync(home, { force: true, recursive: true });
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, out: error ? stdout + stderr : stdout });
      },
    );
  });
}

function runNemoClaw(
  args: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-test-"));
  return new Promise((resolve) => {
    exec(
      `node "${NEMOCLAW_CLI}" ${args}`,
      {
        encoding: "utf-8",
        timeout: execTimeout(),
        env: {
          ...process.env,
          HOME: home,
          // Clear inherited markers so the base nemoclaw bin has a clean slate.
          // The base launcher does not set NEMOCLAW_INVOKED_AS, so leaving an
          // inherited value would silently re-brand the CLI as the alias.
          NEMOCLAW_AGENT: undefined,
          NEMOCLAW_INVOKED_AS: undefined,
          NEMOCLAW_HEALTH_POLL_COUNT: "1",
          NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        fs.rmSync(home, { force: true, recursive: true });
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, out: error ? stdout + stderr : stdout });
      },
    );
  });
}

describe.concurrent("nemohermes alias", () => {
  it("bin/nemohermes.js exists and is executable", () => {
    expect(fs.existsSync(HERMES_CLI)).toBe(true);
    const stat = fs.statSync(HERMES_CLI);
    // Owner execute bit
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("outputs nemohermes branding for --version", async () => {
    const { code, out } = await runHermes("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemohermes v[\d.]+/);
  });

  it("nemoclaw --version does not contain nemohermes", async () => {
    const { code, out } = await runNemoClaw("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemoclaw v[\d.]+/);
    expect(out).not.toContain("nemohermes");
  });

  it("help output shows NemoHermes header", async () => {
    const { code, out } = await runHermes("--help");
    expect(code).toBe(0);
    expect(out).toContain("NemoHermes");
  });

  it("brands deprecated setup help with the invoked alias", async () => {
    const { code, out } = await runHermes("setup --help");
    expect(code).toBe(0);
    expect(out).toContain("Deprecated: 'nemohermes setup' is now 'nemohermes onboard'");
    expect(out).not.toContain("Deprecated: 'nemoclaw setup'");
  });

  it.sequential("routes nemohermes uninstall as a global command, not a sandbox connect command", async () => {
    const { code, out } = await runHermes("uninstall --help");
    expect(code).toBe(0);
    expect(out).toContain("NemoHermes Uninstaller");
    expect(out).toContain("internal uninstall run-plan");
    expect(out).not.toContain("uninstall connect");
  });

  it("NEMOCLAW_AGENT and NEMOCLAW_INVOKED_AS are set by the launcher", async () => {
    // The launcher sets both env vars before requiring dist/nemoclaw.
    // --version shows nemohermes branding only when both are set.
    const { code, out } = await runHermes("--version");
    expect(code).toBe(0);
    expect(out).toContain("nemohermes");
  });

  it("nemoclaw onboard --agent hermes uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runNemoClaw(
      "onboard --agent hermes --resume --non-interactive --yes-i-accept-third-party-software",
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });

  it("NEMOCLAW_AGENT=hermes uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runNemoClaw(
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      { NEMOCLAW_AGENT: "hermes" },
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });
});
