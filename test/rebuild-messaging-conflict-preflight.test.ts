// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end regression for #5954: a `channels start`/rebuild that shares a
 * messaging credential with another sandbox must abort BEFORE backup/delete,
 * leaving the original sandbox intact — not destroy it first and then fail to
 * recreate, which left the sandbox permanently lost.
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
  tmpFixtures.splice(0).forEach((dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
});

// A minimal valid SandboxMessagingPlan with one active Teams channel and a
// credential binding carrying a hash — staging preserves credentialBindings
// verbatim, so a shared hash across two sandboxes is a "matching-token"
// conflict.
function teamsPlan(sandboxName: string, credentialHash: string) {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "teams",
        displayName: "teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "teams",
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        credentialAvailable: true,
        credentialHash,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function completeSession(sandboxName: string) {
  const step = { status: "complete", startedAt: null, completedAt: null, error: null };
  return {
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
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    hermesAuthMethod: null,
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    policyPresets: [],
    messagingPlan: null,
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    steps: {
      preflight: step,
      gateway: step,
      sandbox: step,
      provider_selection: step,
      inference: step,
      openclaw: step,
      agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
      policies: step,
    },
  };
}

// Build a HOME where `my-assistant` and `hermes` both hold the same Teams
// credential (matching hash). Rebuilding `my-assistant` must detect the
// conflict against `hermes` before touching anything destructive.
function createConflictFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-5954-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });

  const sandboxEntry = (name: string) => ({
    name,
    model: "meta/llama-3.3-70b-instruct",
    provider: "nvidia-prod",
    gpuEnabled: false,
    policies: [],
    agent: null,
    messaging: { schemaVersion: 1, plan: teamsPlan(name, "shared-teams-hash") },
  });

  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "my-assistant",
      sandboxes: {
        "my-assistant": sandboxEntry("my-assistant"),
        hermes: sandboxEntry("hermes"),
      },
    }),
    { mode: 0o600 },
  );

  fs.writeFileSync(
    path.join(nemoclawDir, "onboard-session.json"),
    JSON.stringify(completeSession("my-assistant")),
    { mode: 0o600 },
  );

  const sshConfig = [
    "Host openshell-my-assistant",
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
if (a[0]==="sandbox" && a[1]==="list")       { process.stdout.write("my-assistant\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="ssh-config") { process.stdout.write("${sshConfig}\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="delete")     { process.exit(0); }
if (a[0]==="status")                         { process.stdout.write("running\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="info")       { process.stdout.write("nemoclaw\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="select")     { process.exit(0); }
if (a[0]==="inference" && a[1]==="get")      { process.stdout.write('{"provider":"nvidia-prod","model":"meta/llama-3.3-70b-instruct"}\\n'); process.exit(0); }
if (a[0]==="inference")                      { process.exit(0); }
if (a[0]==="provider" && a[1]==="get")       { process.exit(0); }
if (a[0]==="provider")                       { process.exit(0); }
if (a[0]==="forward")                        { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  // No active SSH sessions.
  fs.writeFileSync(path.join(tmpDir, "ps"), "#!/usr/bin/env node\nprocess.exit(0);\n", {
    mode: 0o755,
  });

  // Docker / ssh should never be invoked: the conflict aborts before backup,
  // base-image build, or delete. Failing loudly here would surface any
  // ordering regression that let the rebuild proceed past the preflight.
  fs.writeFileSync(
    path.join(tmpDir, "docker"),
    `#!/usr/bin/env node
process.stderr.write("docker must not run before the conflict preflight: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(17);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tmpDir, "ssh"),
    `#!/usr/bin/env node
process.stderr.write("ssh must not run before the conflict preflight\\n");
process.exit(17);
`,
    { mode: 0o755 },
  );

  return { tmpDir, nemoclawDir };
}

function runRebuild(tmpDir: string) {
  const argv = [path.join(REPO_ROOT, "bin", "nemoclaw.js"), "my-assistant", "rebuild", "--yes"];
  return spawnSync(process.execPath, argv, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      HOME: tmpDir,
      PATH: `${tmpDir}:${NODE_BIN}:/usr/bin:/bin`,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
      NO_COLOR: "1",
      NVIDIA_INFERENCE_API_KEY: "nvapi-test-key-for-rebuild",
    },
    timeout: 60_000,
  });
}

function registryHasSandbox(nemoclawDir: string, name: string): boolean {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf-8"));
    return Boolean(reg?.sandboxes?.[name]);
  } catch {
    return false;
  }
}

describe("rebuild messaging credential conflict preflight (#5954)", () => {
  it("aborts BEFORE backup/delete when another sandbox shares the Teams credential", {
    timeout: 90_000,
  }, () => {
    const f = createConflictFixture();
    const result = runRebuild(f.tmpDir);
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    // Aborted, with the actionable conflict explanation.
    expect(result.status).not.toBe(0);
    expect(output).toContain("uses the same teams credential");
    expect(output).toContain("Aborting");

    // Nothing destructive ran: the sandbox is untouched and still registered.
    expect(output).not.toContain("Backing up sandbox state");
    expect(output).not.toContain("Old sandbox deleted");
    expect(output).not.toContain("must not run before the conflict preflight");
    expect(registryHasSandbox(f.nemoclawDir, "my-assistant")).toBe(true);
  });
});
