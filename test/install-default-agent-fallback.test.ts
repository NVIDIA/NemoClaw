// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const INSTALLER_SOURCE = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");

function extractShellFunctionBefore(name: string, nextName: string): string {
  const start = INSTALLER_SOURCE.indexOf(`${name}() {`);
  const end = INSTALLER_SOURCE.indexOf(`\n${nextName}() {`, start);
  if (start === -1 || end === -1) {
    throw new Error(`expected ${name} before ${nextName} in scripts/install.sh`);
  }
  return INSTALLER_SOURCE.slice(start, end).trimEnd();
}

const WARN_FUNCTION = extractShellFunctionBefore("warn_default_agent_fallback", "print_done");

type Outcome = { status: number | null; stdout: string };

function runWarn(opts: {
  resolvedAgent: string;
  env?: Record<string, string>;
  onboardRan?: string;
}): Outcome {
  const onboardRan = opts.onboardRan ?? "true";
  const snippet = `
    set -euo pipefail
    # Color codes are noise for assertions — blank them so we match on text.
    C_YELLOW=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_RESET=""
    ONBOARD_RAN="${onboardRan}"
    installer_non_interactive() { [[ "\${NON_INTERACTIVE:-}" == "1" || "\${NEMOCLAW_NON_INTERACTIVE:-}" == "1" ]]; }
    ${WARN_FUNCTION}
    warn_default_agent_fallback "${opts.resolvedAgent}"
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
  });
  return { status: result.status, stdout: result.stdout };
}

describe("warn_default_agent_fallback (#5211)", () => {
  it("warns when a non-interactive deploy silently defaults to openclaw", () => {
    const { status, stdout } = runWarn({
      resolvedAgent: "openclaw",
      env: { NEMOCLAW_NON_INTERACTIVE: "1", NEMOCLAW_AGENT: "" },
    });
    expect(status).toBe(0);
    expect(stdout).toContain("defaulted to OpenClaw");
    expect(stdout).toContain("NEMOCLAW_AGENT=hermes");
  });

  it("stays quiet when NEMOCLAW_AGENT was explicitly set (intentional choice)", () => {
    const { stdout } = runWarn({
      resolvedAgent: "openclaw",
      env: { NEMOCLAW_NON_INTERACTIVE: "1", NEMOCLAW_AGENT: "openclaw" },
    });
    expect(stdout).toBe("");
  });

  it("stays quiet for a non-default resolved agent (hermes deployed)", () => {
    const { stdout } = runWarn({
      resolvedAgent: "hermes",
      env: { NEMOCLAW_NON_INTERACTIVE: "1", NEMOCLAW_AGENT: "" },
    });
    expect(stdout).toBe("");
  });

  it("stays quiet for interactive installs (openclaw chosen on purpose)", () => {
    const { stdout } = runWarn({
      resolvedAgent: "openclaw",
      env: { NEMOCLAW_NON_INTERACTIVE: "", NON_INTERACTIVE: "", NEMOCLAW_AGENT: "" },
    });
    expect(stdout).toBe("");
  });

  it("stays quiet when onboarding did not run", () => {
    const { stdout } = runWarn({
      resolvedAgent: "openclaw",
      onboardRan: "false",
      env: { NEMOCLAW_NON_INTERACTIVE: "1", NEMOCLAW_AGENT: "" },
    });
    expect(stdout).toBe("");
  });
});
