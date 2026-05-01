// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { execTimeout } from "./helpers/timeouts";

const HERMES_CLI = path.join(import.meta.dirname, "..", "bin", "nemohermes.js");
const NEMOCLAW_CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function runHermes(
  args: string,
  env: Record<string, string | undefined> = {},
): { code: number; out: string } {
  try {
    const out = execSync(`node "${HERMES_CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: "/tmp/nemohermes-test-" + Date.now(),
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
        HOME: "/tmp/nemohermes-test-" + Date.now(),
        NEMOCLAW_AGENT: undefined,
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

describe("nemohermes alias", () => {
  it("bin/nemohermes.js exists and is executable", () => {
    expect(fs.existsSync(HERMES_CLI)).toBe(true);
    const stat = fs.statSync(HERMES_CLI);
    // Owner execute bit
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("--version outputs nemohermes branding", () => {
    const { code, out } = runHermes("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemohermes v[\d.]+/);
  });

  it("nemoclaw --version does not contain nemohermes", () => {
    const { code, out } = runNemoClaw("--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemoclaw v[\d.]+/);
    expect(out).not.toContain("nemohermes");
  });

  it("help output shows NemoHermes header", () => {
    const { code, out } = runHermes("--help");
    expect(code).toBe(0);
    expect(out).toContain("NemoHermes");
  });

  it("NEMOCLAW_AGENT is set to hermes via the launcher", () => {
    // The launcher sets the env var before requiring dist/nemoclaw.
    // We verify indirectly: --version shows nemohermes branding which
    // requires both NEMOCLAW_AGENT=hermes AND argv containing nemohermes.
    const { code, out } = runHermes("--version");
    expect(code).toBe(0);
    expect(out).toContain("nemohermes");
  });

  it("nemoclaw onboard --agent hermes uses Hermes branding after agent resolution", () => {
    const { code, out } = runNemoClaw(
      "onboard --agent hermes --resume --non-interactive --yes-i-accept-third-party-software",
    );
    expect(code).toBe(1);
    expect(out).toContain("nemohermes onboard");
  });
});
