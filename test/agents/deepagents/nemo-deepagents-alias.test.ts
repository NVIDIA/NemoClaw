// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runAgentAliasCommand } from "../../helpers/agent-alias-command";

const NEMOCLAW_CLI = path.join(import.meta.dirname, "../../..", "bin", "nemoclaw.js");
const DEEPAGENTS_ALIAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-deepagents-bin-"));
const DEEPAGENTS_CLI = path.join(DEEPAGENTS_ALIAS_DIR, "nemo-deepagents");
fs.symlinkSync(NEMOCLAW_CLI, DEEPAGENTS_CLI);

vi.setConfig({ maxConcurrency: 4 });

afterAll(() => {
  fs.rmSync(DEEPAGENTS_ALIAS_DIR, { force: true, recursive: true });
});

function createDeepAgentsRegistry(): { home: string; registryPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-deepagents-use-"));
  const registryDir = path.join(home, ".nemoclaw");
  const registryPath = path.join(registryDir, "sandboxes.json");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      sandboxes: {
        "dcode-alpha": { name: "dcode-alpha", agent: "langchain-deepagents-code" },
        "dcode-beta": { name: "dcode-beta", agent: "langchain-deepagents-code" },
      },
      defaultSandbox: "dcode-alpha",
    }),
    { mode: 0o600 },
  );
  return { home, registryPath };
}

describe.concurrent("nemo-deepagents alias", () => {
  it("package-style nemo-deepagents symlink exists and is executable", () => {
    expect(fs.existsSync(DEEPAGENTS_CLI)).toBe(true);
    const stat = fs.statSync(DEEPAGENTS_CLI);
    // Owner execute bit on the target launcher
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it("outputs nemo-deepagents branding for --version", async () => {
    const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemo-deepagents v[\d.]+/);
  });

  it("nemoclaw --version does not contain nemo-deepagents", async () => {
    const { code, out } = await runAgentAliasCommand(NEMOCLAW_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toMatch(/^nemoclaw v[\d.]+/);
    expect(out).not.toContain("nemo-deepagents");
  });

  it("help output shows NemoDeepAgents header and alias command names", async () => {
    const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "--help");
    expect(code).toBe(0);
    expect(out).toContain("NemoDeepAgents");
    expect(out).toContain("nemo-deepagents onboard");
    expect(out).toContain("nemo-deepagents use <name>");
    expect(out).not.toContain("nemoclaw onboard");
  });

  it("promotes a registered Deep Agents sandbox through the alias command", async () => {
    const { home, registryPath } = createDeepAgentsRegistry();

    try {
      const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "use dcode-beta", {
        HOME: home,
      });

      expect(code).toBe(0);
      expect(out).toContain("Default sandbox set to 'dcode-beta' (was 'dcode-alpha').");
      expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual(
        expect.objectContaining({ defaultSandbox: "dcode-beta" }),
      );
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("reports an already-default Deep Agents sandbox through the alias command", async () => {
    const { home } = createDeepAgentsRegistry();

    try {
      const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "use dcode-alpha", {
        HOME: home,
      });

      expect(code).toBe(0);
      expect(out).toContain("Sandbox 'dcode-alpha' is already the default.");
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("returns structured not-found output through the alias command", async () => {
    const { home, registryPath } = createDeepAgentsRegistry();

    try {
      const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "use dcode-missing --json", {
        HOME: home,
      });

      expect(code).toBe(1);
      expect(JSON.parse(out)).toEqual({
        outcome: "not-found",
        sandboxName: "dcode-missing",
        knownSandboxes: ["dcode-alpha", "dcode-beta"],
      });
      expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual(
        expect.objectContaining({ defaultSandbox: "dcode-alpha" }),
      );
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it.sequential("routes nemo-deepagents uninstall as a global command, not a sandbox connect command", async () => {
    const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "uninstall --help");
    expect(code).toBe(0);
    expect(out).toContain("NemoDeepAgents Uninstaller");
    expect(out).toContain("internal uninstall run-plan");
    expect(out).not.toContain("uninstall connect");
  });

  it("NEMOCLAW_AGENT and NEMOCLAW_INVOKED_AS are set by the launcher", async () => {
    // The launcher sets both env vars before requiring dist/nemoclaw.
    // --version shows nemo-deepagents branding only when both are set.
    const { code, out } = await runAgentAliasCommand(DEEPAGENTS_CLI, "--version");
    expect(code).toBe(0);
    expect(out).toContain("nemo-deepagents");
  });

  it("nemoclaw onboard --agent deep agents uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runAgentAliasCommand(
      NEMOCLAW_CLI,
      "onboard --agent langchain-deepagents-code --resume --non-interactive --yes-i-accept-third-party-software",
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });

  it("NEMOCLAW_AGENT=deep agents uses an agent-neutral no-session diagnostic (#9035)", async () => {
    const { code, out } = await runAgentAliasCommand(
      NEMOCLAW_CLI,
      "onboard --resume --non-interactive --yes-i-accept-third-party-software",
      { NEMOCLAW_AGENT: "langchain-deepagents-code" },
    );
    expect(code).toBe(1);
    expect(out.trim()).toBe("No resumable onboarding session was found.");
  });
});
