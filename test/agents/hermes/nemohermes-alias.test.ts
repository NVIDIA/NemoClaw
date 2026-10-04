// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runAgentAliasCommand } from "../../helpers/agent-alias-command";

const HERMES_CLI = path.join(import.meta.dirname, "../../..", "bin", "nemohermes.js");
const NEMOCLAW_CLI = path.join(import.meta.dirname, "../../..", "bin", "nemoclaw.js");

vi.setConfig({ maxConcurrency: 4 });

describe.concurrent("nemohermes alias", () => {
  it("bin/nemohermes.js exists and is executable", () => {
    expect(fs.existsSync(HERMES_CLI)).toBe(true);
    const stat = fs.statSync(HERMES_CLI);
    // Owner execute bit
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("outputs nemohermes branding for --version", async () => {
    const { code, out } = await runAgentAliasCommand(HERMES_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemohermes v[\d.]+/);
  });

  it("nemoclaw --version does not contain nemohermes", async () => {
    const { code, out } = await runAgentAliasCommand(NEMOCLAW_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemoclaw v[\d.]+/);
    expect(out).not.toContain("nemohermes");
  });

  it("help output shows NemoHermes header", async () => {
    const { code, out } = await runAgentAliasCommand(HERMES_CLI, "--help");
    expect(code).toBe(0);
    expect(out).toContain("NemoHermes");
  });

  it("brands deprecated setup help with the invoked alias", async () => {
    const { code, out } = await runAgentAliasCommand(HERMES_CLI, "setup --help");
    expect(code).toBe(0);
    expect(out).toContain("Deprecated: 'nemohermes setup' is now 'nemohermes onboard'");
    expect(out).not.toContain("Deprecated: 'nemoclaw setup'");
  });

  it.sequential("routes nemohermes uninstall as a global command, not a sandbox connect command", async () => {
    const { code, out } = await runAgentAliasCommand(HERMES_CLI, "uninstall --help");
    expect(code).toBe(0);
    expect(out).toContain("NemoHermes Uninstaller");
    expect(out).toContain("internal uninstall run-plan");
    expect(out).not.toContain("uninstall connect");
  });

  it("NEMOCLAW_AGENT and NEMOCLAW_INVOKED_AS are set by the launcher", async () => {
    // The launcher sets both env vars before requiring dist/nemoclaw.
    // --version shows nemohermes branding only when both are set.
    const { code, out } = await runAgentAliasCommand(HERMES_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toContain("nemohermes");
  });

  it("nemoclaw onboard --agent hermes uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runAgentAliasCommand(
      NEMOCLAW_CLI,
      "onboard --agent hermes --resume --non-interactive --yes-i-accept-third-party-software",
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });

  it("NEMOCLAW_AGENT=hermes uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runAgentAliasCommand(
      NEMOCLAW_CLI,
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      { NEMOCLAW_AGENT: "hermes" },
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });
});
