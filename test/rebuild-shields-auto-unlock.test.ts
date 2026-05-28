// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for issue #3113: rebuild should auto-unlock when shields are UP.
 *
 * When the user has opted into shields-up (lockdown), rebuild used to abort
 * at the backup step because state dirs are root-owned. Rebuild must
 * temporarily unlock for backup, complete the rebuild, then re-lock.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const NODE_BIN = path.dirname(process.execPath);
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

function createFixture(opts: { shieldsLocked: boolean }) {
  const sandboxName = "my-assistant";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-3113-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });
  const stateDir = path.join(nemoclawDir, "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const usageNotice = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "bin", "lib", "usage-notice.json"), "utf-8"),
  );
  fs.writeFileSync(
    path.join(nemoclawDir, "usage-notice.json"),
    JSON.stringify(
      {
        acceptedVersion: usageNotice.version,
        acceptedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // Pre-write a saved policy snapshot so the relock path can find it.
  const snapshotPath = path.join(stateDir, "policy-snapshot-prior.yaml");
  fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}\n", { mode: 0o600 });

  if (opts.shieldsLocked) {
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify(
        {
          shieldsDown: false,
          shieldsDownAt: null,
          shieldsDownTimeout: null,
          shieldsDownReason: null,
          shieldsDownPolicy: null,
          shieldsPolicySnapshotPath: snapshotPath,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "meta/llama-3.3-70b-instruct",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
          agent: null,
          openshellDriver: "vm",
          messagingChannels: null,
        },
      },
    }),
    { mode: 0o600 },
  );

  fs.writeFileSync(
    path.join(nemoclawDir, "credentials.json"),
    JSON.stringify({ NVIDIA_API_KEY: "nvapi-test" }),
    { mode: 0o600 },
  );

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
      lastCompletedStep: "policies",
      failure: null,
      agent: null,
      sandboxName,
      provider: "nvidia-prod",
      model: "meta/llama-3.3-70b-instruct",
      endpointUrl: null,
      credentialEnv: "NVIDIA_API_KEY",
      preferredInferenceApi: null,
      nimContainer: null,
      webSearchConfig: null,
      policyPresets: [],
      messagingChannels: null,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
      steps: {
        preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
        gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
        provider_selection: { status: "complete", startedAt: null, completedAt: null, error: null },
        inference: { status: "complete", startedAt: null, completedAt: null, error: null },
        openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
        agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
        policies: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    }),
    { mode: 0o600 },
  );

  // Workspace dir for the backup tar
  const fakeRoot = path.join(tmpDir, "fake-sandbox-root");
  fs.mkdirSync(path.join(fakeRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "workspace", "marker.txt"), "test");
  const lockStatePath = path.join(tmpDir, "config-lock-state.txt");
  fs.writeFileSync(lockStatePath, opts.shieldsLocked ? "locked" : "unlocked");

  // Fake openshell — also returns a parseable YAML policy for the
  // shields-down policy snapshot capture path.
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
if (a[0]==="policy" && a[1]==="get")         { process.stdout.write("version: 1\\nnetwork_policies:\\n  test: {}\\n"); process.exit(0); }
if (a[0]==="policy" && a[1]==="set")         { process.exit(0); }
if (a[0]==="status")                         { process.stdout.write("running\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="info")       { process.stdout.write("nemoclaw\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="select")     { process.exit(0); }
if (a[0]==="inference" && a[1]==="get")      { process.stdout.write('{"provider":"nvidia-prod","model":"meta/llama-3.3-70b-instruct"}\\n'); process.exit(0); }
if (a[0]==="inference" && a[1]==="set")      { process.exit(0); }
if (a[0]==="provider")                       { process.exit(0); }
if (a[0]==="forward")                        { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  // Fake docker — covers both the basic cases and kubectl exec proxying.
  // For shields lock/unlock, we return zero exit with the data shields.ts
  // verification expects (stat for unlock returns sandbox:sandbox 660/2770).
  fs.writeFileSync(
    path.join(tmpDir, "docker"),
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const lockStatePath = ${JSON.stringify(lockStatePath)};
function readLockState() {
  try { return fs.readFileSync(lockStatePath, "utf8").trim(); } catch { return "unlocked"; }
}
function writeLockState(state) {
  fs.writeFileSync(lockStatePath, state);
}
if (a[0]==="build")  { process.exit(0); }
if (a[0]==="image" && a[1]==="inspect") { process.exit(0); }
if (a[0]==="inspect") { process.stdout.write("true\\n"); process.exit(0); }
if (a[0]==="ps")     { process.stdout.write("openshell-${sandboxName}-abc123\\n"); process.exit(0); }
// Supports both direct exec ("docker exec --user root <container> <cmd...>")
// and legacy kubectl proxying ("docker exec <k3s> kubectl exec ... -- <cmd...>").
if (a[0]==="exec") {
  const dashDash = a.indexOf("--");
  let cmd = [];
  if (dashDash >= 0) {
    cmd = a.slice(dashDash + 1);
  } else {
    let index = 1;
    while (index < a.length) {
      if (a[index] === "-i") {
        index++;
        continue;
      }
      if (a[index] === "--user") {
        index += 2;
        continue;
      }
      break;
    }
    index++; // container name
    cmd = a.slice(index);
  }
  // Verification reads:
  //   stat -c '%a %U:%G' <path>      → expect "660 sandbox:sandbox" or "2770 sandbox:sandbox"
  //   lsattr -d <path>               → "----i------" (locked) or no immutable bit (unlocked)
  // shields-up lock verification expects:
  //   stat → "444 root:root" / "755 root:root"
  //   lsattr → "----i------"
  // We are testing the auto-unlock path: shields-down is called on a locked sandbox,
  // verification should look like 660 sandbox:sandbox / 2770 sandbox:sandbox.
  if (cmd[0]==="chattr" && cmd[1]==="-i") { writeLockState("unlocked"); process.exit(0); }
  if (cmd[0]==="chattr" && cmd[1]==="+i") { writeLockState("locked"); process.exit(0); }
  if (cmd[0]==="chown" && cmd[1]==="sandbox:sandbox") { writeLockState("unlocked"); process.exit(0); }
  if (cmd[0]==="chown" && cmd[1]==="root:root") { writeLockState("locked"); process.exit(0); }
  if (cmd[0]==="chmod" && (cmd[1]==="660" || cmd[1]==="2770")) { writeLockState("unlocked"); process.exit(0); }
  if (cmd[0]==="chmod" && cmd[1]==="444") { writeLockState("locked"); process.exit(0); }
  if (cmd[0]==="stat") {
    const target = cmd[cmd.length-1];
    const locked = readLockState() === "locked";
    // Heuristic: directories tend to end with .openclaw or have no extension
    if (target.endsWith(".openclaw") || target.endsWith(".hermes") || /\\/(workspace|skills|hooks|cron|agents|extensions|plugins|memory|credentials|identity|devices|canvas|telegram)$/.test(target)) {
      process.stdout.write(locked ? "755 root:root\\n" : "2770 sandbox:sandbox\\n");
    } else {
      process.stdout.write(locked ? "444 root:root\\n" : "660 sandbox:sandbox\\n");
    }
    process.exit(0);
  }
  if (cmd[0]==="lsattr") {
    const flags = readLockState() === "locked" ? "----i----------" : "---------------";
    process.stdout.write(flags + " " + cmd[cmd.length-1] + "\\n");
    process.exit(0);
  }
  if (cmd[0]==="chattr" || cmd[0]==="chown" || cmd[0]==="chmod" || cmd[0]==="sh" || cmd[0]==="find") { process.exit(0); }
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  // Fake ssh — backup tars from the real fakeRoot
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
if (cmd.includes("rm -rf")) { process.exit(0); }
if (cmd.includes("chown"))  { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, nemoclawDir, sandboxName, snapshotPath };
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
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NO_COLOR: "1",
      },
      timeout: 30_000,
    },
  );
}

describe("Issue #3113: rebuild auto-unlocks when shields are UP", () => {
  it(
    "detects locked shields and prints auto-unlock notice",
    { timeout: 60_000 },
    () => {
      const f = createFixture({ shieldsLocked: true });
      const r = runRebuild(f);
      const output = (r.stdout || "") + (r.stderr || "");

      // Without the fix this would be:
      //   "Failed to back up sandbox state. Aborting rebuild to prevent data loss."
      expect(output).not.toContain("Aborting rebuild to prevent data loss");
      // With the fix, rebuild detects shields-up and unlocks before backup.
      expect(output).toContain("Shields are UP");
      expect(output).toContain("temporarily unlocking for rebuild backup");
      // Shields-down was invoked programmatically (no permissive policy printout
      // is required to assert; we just verify the snapshot capture step ran).
      expect(output).toContain("Capturing current policy snapshot");
      // Backup proceeds.
      expect(output).toContain("Backing up sandbox state");
    },
  );

  it(
    "skips auto-unlock when shields are not configured",
    { timeout: 60_000 },
    () => {
      const f = createFixture({ shieldsLocked: false });
      const r = runRebuild(f);
      const output = (r.stdout || "") + (r.stderr || "");

      expect(output).not.toContain("Shields are UP");
      expect(output).not.toContain("temporarily unlocking for rebuild backup");
      expect(output).toContain("Backing up sandbox state");
    },
  );
});
