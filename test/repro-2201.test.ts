// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for issue #2201:
 *   `nemoclaw rebuild` builds the wrong sandbox type because it does not
 *   sync the session's agent field with the registry entry for the sandbox
 *   being rebuilt.
 *
 * Scenario: user onboards sandbox A (openclaw) then sandbox B (hermes).
 * The onboard session now has agent="hermes". When user runs
 * `nemoclaw A rebuild`, sandboxRebuild() updates session.sandboxName
 * but NOT session.agent. The onboard() call then resolves agent from
 * the stale session and builds hermes instead of openclaw.
 *
 * This test verifies the bug by calling resolveAgentName() with the
 * session state that sandboxRebuild() would produce, and checking
 * whether it returns the correct agent for the sandbox being rebuilt.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const AGENT_DEFS_PATH = path.join(REPO_ROOT, "dist", "lib", "agent-defs.js");

/**
 * Run a CJS script in a subprocess and return stdout/stderr/status.
 */
function runScript(body: string): { stdout: string; stderr: string; status: number | null } {
  const preamble = `const agentDefs = require(${JSON.stringify(AGENT_DEFS_PATH)});\n`;
  const result = spawnSync(process.execPath, ["-e", preamble + body], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

describe("Issue #2201: rebuild uses wrong agent from stale session", () => {
  it("resolveAgentName returns correct agent when rebuild syncs session.agent", () => {
    // After the fix: sandboxRebuild() sets session.agent = sb.agent || null
    // before calling onboard(). For an openclaw sandbox, sb.agent is null,
    // so session.agent is set to null, and resolveAgentName returns "openclaw".
    const result = runScript(`
      // After fix: rebuild syncs session.agent from registry (sb.agent || null)
      // For an openclaw sandbox, sb.agent is null → session.agent = null
      const session = { agent: null };

      const resolved = agentDefs.resolveAgentName({ agentFlag: null, session });
      process.stdout.write(resolved);
    `);

    // FIX: resolveAgentName returns "openclaw" because session.agent is null
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("openclaw");
  });

  it("resolveAgentName returns stale agent when session.agent is not synced", () => {
    // Without the fix: if rebuild does NOT update session.agent,
    // a stale session from a previous hermes onboard leaks through.
    const result = runScript(`
      // Stale session: agent=hermes left over from onboarding a different sandbox
      const session = { agent: "hermes" };

      // No agentFlag, no env var — resolveAgentName falls through to session.agent
      const resolved = agentDefs.resolveAgentName({ agentFlag: null, session });
      process.stdout.write(resolved);
    `);

    expect(result.status).toBe(0);
    // This demonstrates the pre-fix bug: returns "hermes" instead of "openclaw"
    expect(result.stdout).toBe("hermes");
  });

  it("resolveAgentName would return correct agent if rebuild set session.agent to hermes", () => {
    // Rebuilding a hermes sandbox: registry has sb.agent="hermes",
    // rebuild should set session.agent="hermes"
    const result = runScript(`
      const session = { agent: "hermes" };
      const resolved = agentDefs.resolveAgentName({ agentFlag: null, session });
      process.stdout.write(resolved);
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hermes"); // correct: hermes sandbox rebuilds as hermes
  });

  it("rebuild session update includes agent field (fix verification)", () => {
    // Read the sandboxRebuild function and verify the session update
    // sets the agent field from the registry — proving the fix is present.
    const fs = require("node:fs");
    const nemoclawSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src", "nemoclaw.ts"),
      "utf-8",
    );

    // Find the rebuild session update block
    // Pattern: updateSession((s) => { s.sandboxName = ...; s.resumable = true; s.status = ...; s.agent = ... })
    const rebuildUpdateMatch = nemoclawSrc.match(
      /sandboxRebuild[\s\S]*?onboardSession\.updateSession\(\(s\)\s*=>\s*\{([^}]+)\}/,
    );

    expect(rebuildUpdateMatch).not.toBeNull();
    const updateBody = rebuildUpdateMatch![1];

    // The update sets sandboxName, resumable, status, AND agent (#2201 fix)
    expect(updateBody).toContain("s.sandboxName");
    expect(updateBody).toContain("s.resumable");
    expect(updateBody).toContain("s.status");
    expect(updateBody).toContain("s.agent"); // FIX: agent is now synced from registry
  });
});
