// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for issue #2201:
 *   `nemoclaw rebuild` builds the wrong sandbox type because it picks up
 *   the agent from the onboard session — which belongs to whichever
 *   sandbox was onboarded *last* — instead of the registry entry for the
 *   sandbox being rebuilt.
 *
 * Real-world scenario (from the bug report):
 *   1. User onboards "openclaw" (agent=null, i.e. default openclaw)
 *   2. User onboards "hermes"  (agent="hermes")
 *      → session now has agent="hermes", sandboxName="hermes"
 *   3. User runs `nemoclaw openclaw rebuild`
 *      → rebuild calls onboard --resume, which reads session.agent="hermes"
 *      → builds hermes Dockerfile instead of openclaw  ← BUG
 *
 * This test runs the real CLI (`nemoclaw <name> rebuild --yes`) with fake
 * openshell/ssh binaries.  Both sandboxes exist in the registry, but the
 * session points to the one that was onboarded last.  After rebuild, the
 * session file is checked to verify the agent was synced from the registry.
 *
 * Without the fix the session keeps the stale agent → wrong Dockerfile.
 * With the fix the session is overwritten with the registry agent.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const NODE_BIN = path.dirname(process.execPath); // need node on PATH for shebangs
const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

/**
 * Set up a temp HOME that mirrors the reporter's scenario:
 *
 *   - Two sandboxes in the registry (rebuildTarget + lastOnboarded)
 *   - The onboard session left over from whichever sandbox was onboarded
 *     last (lastOnboarded), so session.agent ≠ rebuildTarget's agent
 *   - We then run `nemoclaw <rebuildTarget> rebuild --yes`
 *
 * @param rebuildTarget  - sandbox being rebuilt and its registry agent
 * @param lastOnboarded  - sandbox that was onboarded last (owns the session)
 */
function createFixture({
  rebuildTarget,
  lastOnboarded,
  fromDockerfile = null,
}: {
  rebuildTarget: { name: string; agent: string | null };
  lastOnboarded: { name: string; agent: string | null };
  fromDockerfile?: string | null;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2201-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });

  // ── Registry — both sandboxes exist ───────────────────────────
  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: rebuildTarget.name,
      sandboxes: {
        [rebuildTarget.name]: {
          name: rebuildTarget.name,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: rebuildTarget.agent,
        },
        [lastOnboarded.name]: {
          name: lastOnboarded.name,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: lastOnboarded.agent,
        },
      },
    }),
    { mode: 0o600 },
  );

  // ── Session left over from the last onboard (lastOnboarded) ───
  fs.writeFileSync(
    path.join(nemoclawDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sessionId: "s",
      resumable: true,
      status: "complete",
      mode: "interactive",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      lastStepStarted: null,
      lastCompletedStep: "inference",
      failure: null,
      agent: lastOnboarded.agent,
      sandboxName: lastOnboarded.name,
      provider: "p",
      model: "m",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: null,
      nimContainer: null,
      webSearchConfig: null,
      policyPresets: [],
      messagingChannels: null,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile },
      steps: {
        preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
        gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
        provider_selection: { status: "complete", startedAt: null, completedAt: null, error: null },
        inference: { status: "complete", startedAt: null, completedAt: null, error: null },
        openclaw: { status: "pending", startedAt: null, completedAt: null, error: null },
        agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
        policies: { status: "pending", startedAt: null, completedAt: null, error: null },
      },
    }),
    { mode: 0o600 },
  );

  const sandboxName = rebuildTarget.name;

  // ── Dummy workspace dir for the fake ssh tar call ─────────────
  const workspaceDir = path.join(tmpDir, "fake-sandbox-root", "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, ".keep"), "");

  // ── Fake openshell ────────────────────────────────────────────
  const sshConfig = [
    `Host openshell-${sandboxName}`,
    "  HostName 127.0.0.1",
    "  Port 2222",
    "  User sandbox",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
  ].join("\\n");

  fs.writeFileSync(
    path.join(tmpDir, "openshell"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0]==="sandbox" && a[1]==="list")       { process.stdout.write("${sandboxName}\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="ssh-config") { process.stdout.write("${sshConfig}\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="delete")     { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  // ── Fake ssh ──────────────────────────────────────────────────
  // backupSandboxState makes two ssh calls:
  //   1. dir-existence check (command has "[ -d") → print "workspace"
  //   2. tar download (command has "tar") → produce a real tar archive
  const fakeRoot = path.join(tmpDir, "fake-sandbox-root");
  fs.writeFileSync(
    path.join(tmpDir, "ssh"),
    `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("[ -d")) {
  process.stdout.write("workspace\\n");
  process.exit(0);
}
if (cmd.includes("tar")) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(fakeRoot)}, "workspace"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.status || 0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, nemoclawDir, sandboxName };
}

function runRebuild(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "nemoclaw.js"), fixture.sandboxName, "rebuild", "--yes"],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: fixture.tmpDir,
        PATH: fixture.tmpDir + ":" + NODE_BIN + ":/usr/bin:/bin",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NO_COLOR: "1",
      },
      timeout: 30_000,
    },
  );
}

type SessionFixture = { agent?: string | null };

function readSession(fixture: ReturnType<typeof createFixture>): SessionFixture {
  const p = path.join(fixture.nemoclawDir, "onboard-session.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function readSessionAgent(fixture: ReturnType<typeof createFixture>): string | null | undefined {
  return readSession(fixture).agent;
}

describe("Issue #2201: rebuild syncs agent from registry, not stale session", () => {
  it(
    "rebuild openclaw after hermes was onboarded last (reporter scenario)",
    { timeout: 60_000 },
    () => {
      // Exact scenario from the bug report: user has openclaw + hermes,
      // hermes was onboarded last, then runs `nemoclaw openclaw rebuild`.
      const f = createFixture({
        rebuildTarget: { name: "openclaw", agent: null },
        lastOnboarded: { name: "hermes", agent: "hermes" },
      });
      runRebuild(f);
      // With fix: session.agent = null (synced from openclaw registry entry)
      // Without fix: session.agent stays "hermes" (from hermes onboard)
      expect(readSessionAgent(f)).toBeNull();
    },
  );

  it(
    "rebuild hermes after openclaw was onboarded last (reverse scenario)",
    { timeout: 60_000 },
    () => {
      const f = createFixture({
        rebuildTarget: { name: "hermes", agent: "hermes" },
        lastOnboarded: { name: "openclaw", agent: null },
      });
      runRebuild(f);
      // With fix: session.agent = "hermes" (synced from hermes registry entry)
      // Without fix: session.agent stays null (from openclaw onboard)
      expect(readSessionAgent(f)).toBe("hermes");
    },
  );
});

describe("Issue #2301: rebuild forwards stored --from Dockerfile to onboard", () => {
  it(
    "rebuild does not hit fromDockerfile conflict when session has a stored --from path",
    { timeout: 60_000 },
    () => {
      // Scenario: user onboarded with --from /path/to/Dockerfile, then
      // runs rebuild.  Without the fix, onboard's conflict check sees
      // requestedFrom=null vs recordedFrom="/path/to/Dockerfile" and
      // exits with a conflict error.
      const f = createFixture({
        rebuildTarget: { name: "openclaw", agent: null },
        lastOnboarded: { name: "openclaw", agent: null },
        fromDockerfile: "/tmp/custom/Dockerfile",
      });
      const result = runRebuild(f);
      // Without fix: exits with "Session was started with --from ..."
      // With fix: rebuild proceeds past conflict check (may still fail
      // later in the fake-env backup step — that's expected with stubs).
      expect(result.stderr).not.toMatch(/Session was started with --from/);
    },
  );
});
