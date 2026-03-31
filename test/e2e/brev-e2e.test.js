// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral Brev E2E test suite.
 *
 * Creates a fresh Brev instance, bootstraps it, runs E2E tests remotely,
 * then tears it down. Intended to be run from CI via:
 *
 *   npx vitest run --project e2e-brev
 *
 * Required env vars:
 *   BREV_API_TOKEN   — Brev refresh token for headless auth
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Optional env vars:
 *   TEST_SUITE       — which test to run: full (default), credential-sanitization, all
 *   BREV_CPU         — CPU spec (default: 4x16)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BREV_CPU = process.env.BREV_CPU || "4x16";
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");

// NemoClaw launchable — uses the OpenShell-Community launch script which
// goes through `nemoclaw onboard` (potentially pre-built images / faster path)
// instead of our manual brev-setup.sh bootstrap.
const LAUNCHABLE_SETUP_SCRIPT =
  "https://raw.githubusercontent.com/NVIDIA/OpenShell-Community/refs/heads/feat/brev-nemoclaw-plugin/brev/launch-nemoclaw.sh";
const NEMOCLAW_REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";

// Use launchable by default; set USE_LAUNCHABLE=0 or USE_LAUNCHABLE=false to fall back to brev-setup.sh
const USE_LAUNCHABLE = !["0", "false"].includes(process.env.USE_LAUNCHABLE?.toLowerCase());

let remoteDir;
let instanceCreated = false;

// --- helpers ----------------------------------------------------------------

function brev(...args) {
  return execFileSync("brev", args, {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function ssh(cmd, { timeout = 120_000 } = {}) {
  // Use single quotes to prevent local shell expansion of remote commands
  const escaped = cmd.replace(/'/g, "'\\''");
  return execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${INSTANCE_NAME}" '${escaped}'`,
    { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

function shellEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with secrets passed via stdin (not CLI args). */
function sshWithSecrets(cmd, { timeout = 600_000, stream = false } = {}) {
  const secretPreamble = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ].join("\n");

  // When stream=true, pipe stdout/stderr to the CI log in real time
  // so long-running steps (bootstrap) show progress instead of silence.
  /** @type {import("child_process").StdioOptions} */
  const stdio = stream ? ["pipe", "inherit", "inherit"] : ["pipe", "pipe", "pipe"];

  // Pipe secrets via stdin so they don't appear in ps/process listings
  const result = execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${INSTANCE_NAME}" 'eval "$(cat)" && ${cmd.replace(/'/g, "'\\''")}'`,
    {
      encoding: "utf-8",
      timeout,
      input: secretPreamble,
      stdio,
    },
  );
  return stream ? "" : result.trim();
}

function waitForSsh(maxAttempts = 60, intervalMs = 5_000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      ssh("echo ok", { timeout: 10_000 });
      return;
    } catch {
      if (i === maxAttempts) throw new Error(`SSH not ready after ${maxAttempts} attempts`);
      if (i % 5 === 0) {
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
      }
      execSync(`sleep ${intervalMs / 1000}`);
    }
  }
}

function runRemoteTest(scriptPath) {
  const cmd = [
    `set -o pipefail`,
    `source ~/.nvm/nvm.sh 2>/dev/null || true`,
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    `bash ${scriptPath} 2>&1 | tee /tmp/test-output.log`,
  ].join(" && ");

  // Stream test output to CI log AND capture it for assertions
  sshWithSecrets(cmd, { timeout: 900_000, stream: true });
  // Retrieve the captured output for assertion checking
  return ssh("cat /tmp/test-output.log", { timeout: 30_000 });
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["BREV_API_TOKEN", "NVIDIA_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);

describe.runIf(hasRequiredVars)("Brev E2E", () => {
  beforeAll(() => {
    const bootstrapStart = Date.now();
    const elapsed = () => `${Math.round((Date.now() - bootstrapStart) / 1000)}s`;

    // Authenticate with Brev
    mkdirSync(path.join(homedir(), ".brev"), { recursive: true });
    writeFileSync(
      path.join(homedir(), ".brev", "onboarding_step.json"),
      '{"step":1,"hasRunBrevShell":true,"hasRunBrevOpen":true}',
    );
    brev("login", "--token", process.env.BREV_API_TOKEN);

    if (USE_LAUNCHABLE) {
      // --- Launchable path: brev start with the NemoClaw launch script ---
      // This uses the OpenShell-Community launch-nemoclaw.sh which goes through
      // nemoclaw's own install/onboard flow — potentially faster than our manual
      // brev-setup.sh (different sandbox build strategy, pre-built images, etc.)
      console.log(`[${elapsed()}] Creating instance via launchable (brev start + setup-script)...`);
      console.log(`[${elapsed()}]   setup-script: ${LAUNCHABLE_SETUP_SCRIPT}`);
      console.log(`[${elapsed()}]   repo: ${NEMOCLAW_REPO_URL}`);
      console.log(`[${elapsed()}]   cpu: ${BREV_CPU}`);

      // brev start with a git URL may take longer than the default 60s brev() timeout
      // (it registers the instance + kicks off provisioning before returning)
      execFileSync(
        "brev",
        [
          "start",
          NEMOCLAW_REPO_URL,
          "--name",
          INSTANCE_NAME,
          "--cpu",
          BREV_CPU,
          "--setup-script",
          LAUNCHABLE_SETUP_SCRIPT,
          "--detached",
        ],
        { encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "inherit", "inherit"] },
      );
      instanceCreated = true;
      console.log(`[${elapsed()}] brev start returned (instance provisioning in background)`);

      // Wait for SSH
      try {
        brev("refresh");
      } catch {
        /* ignore */
      }
      waitForSsh();
      console.log(`[${elapsed()}] SSH is up`);

      // The launchable clones NemoClaw to ~/NemoClaw. We need to find where it landed
      // and then rsync our branch code over it.
      const remoteHome = ssh("echo $HOME");
      // The launch script clones to $HOME/NemoClaw (PLUGIN_DIR default)
      remoteDir = `${remoteHome}/NemoClaw`;

      // Wait for the launch script to finish — it runs as the VM's startup script
      // and may still be in progress when SSH becomes available. Poll for completion.
      console.log(`[${elapsed()}] Waiting for launchable setup to complete...`);
      const setupMaxWait = 2_400_000; // 40 min max
      const setupStart = Date.now();
      const setupPollInterval = 15_000; // check every 15s
      while (Date.now() - setupStart < setupMaxWait) {
        try {
          // The launch script writes to /tmp/launch-plugin.log and the last step
          // prints "=== Ready ===" when complete
          const log = ssh("cat /tmp/launch-plugin.log 2>/dev/null || echo 'NO_LOG'", {
            timeout: 15_000,
          });
          if (log.includes("=== Ready ===")) {
            console.log(
              `[${elapsed()}] Launchable setup complete (detected '=== Ready ===' in log)`,
            );
            break;
          }
          // Also check if nemoclaw onboard has run (install marker)
          const markerCheck = ssh(
            "test -f ~/.cache/nemoclaw-plugin/install-ran && echo DONE || echo PENDING",
            { timeout: 10_000 },
          );
          if (markerCheck.includes("DONE")) {
            console.log(`[${elapsed()}] Launchable setup complete (install-ran marker found)`);
            break;
          }
          // Print last few lines of log for progress visibility
          const tail = ssh("tail -3 /tmp/launch-plugin.log 2>/dev/null || echo '(no log yet)'", {
            timeout: 10_000,
          });
          console.log(`[${elapsed()}] Setup still running... ${tail.replace(/\n/g, " | ")}`);
        } catch {
          console.log(`[${elapsed()}] Setup poll: SSH command failed, retrying...`);
        }
        execSync(`sleep ${setupPollInterval / 1000}`);
      }

      // Fail fast if neither readiness marker appeared within the timeout
      if (Date.now() - setupStart >= setupMaxWait) {
        throw new Error(
          `Launchable setup did not complete within ${setupMaxWait / 60_000} minutes. ` +
            `Neither '=== Ready ===' in /tmp/launch-plugin.log nor install-ran marker found.`,
        );
      }

      // The launch script installs Docker, OpenShell CLI, clones NemoClaw main,
      // and sets up code-server — but it does NOT run `nemoclaw onboard` (that's
      // deferred to an interactive code-server terminal). So at this point we have:
      //   ✅ Docker, OpenShell CLI, Node.js, NemoClaw repo (main)
      //   ❌ No sandbox yet
      //
      // Now: rsync our PR branch code over the main clone, then run onboard ourselves.

      console.log(`[${elapsed()}] Syncing PR branch code over launchable's clone...`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );
      console.log(`[${elapsed()}] Code synced`);

      // Install deps for our branch
      console.log(`[${elapsed()}] Running npm ci to sync dependencies...`);
      sshWithSecrets(
        `set -o pipefail && source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir} && npm ci --ignore-scripts 2>&1 | tail -5`,
        { timeout: 300_000, stream: true },
      );
      console.log(`[${elapsed()}] Dependencies synced`);

      // Run nemoclaw onboard (non-interactive) — this is the path real users take.
      // It installs the nemoclaw CLI, builds the sandbox via `nemoclaw onboard`,
      // which may use a different (faster) strategy than our manual setup.sh.
      // Source nvm first — the launchable installs Node.js via nvm which sets up
      // PATH in .bashrc/.nvm/nvm.sh, but non-interactive SSH doesn't source these.
      console.log(`[${elapsed()}] Running nemoclaw install + onboard (the user-facing path)...`);
      sshWithSecrets(
        `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir} && npm link && nemoclaw onboard --non-interactive 2>&1`,
        { timeout: 2_400_000, stream: true },
      );
      console.log(`[${elapsed()}] nemoclaw onboard complete`);

      // Verify sandbox is ready
      try {
        const sandboxStatus = ssh("openshell sandbox list 2>&1 | head -5", { timeout: 15_000 });
        console.log(`[${elapsed()}] Sandbox status: ${sandboxStatus}`);
      } catch (e) {
        console.log(`[${elapsed()}] Warning: could not check sandbox status: ${e.message}`);
      }
    } else {
      // --- Legacy path: bare brev create + brev-setup.sh ---
      console.log(`[${elapsed()}] Creating bare instance via brev create...`);
      brev("create", INSTANCE_NAME, "--cpu", BREV_CPU, "--detached");
      instanceCreated = true;

      // Wait for SSH
      try {
        brev("refresh");
      } catch {
        /* ignore */
      }
      waitForSsh();
      console.log(`[${elapsed()}] SSH is up`);

      // Sync code
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
      ssh(`mkdir -p ${remoteDir}`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );
      console.log(`[${elapsed()}] Code synced`);

      // Bootstrap VM — stream output to CI log so we can see progress
      console.log(`[${elapsed()}] Running brev-setup.sh (manual bootstrap)...`);
      sshWithSecrets(`cd ${remoteDir} && SKIP_VLLM=1 bash scripts/brev-setup.sh`, {
        timeout: 2_400_000,
        stream: true,
      });
      console.log(`[${elapsed()}] Bootstrap complete`);

      // Install nemoclaw CLI — brev-setup.sh creates the sandbox but doesn't
      // install the host-side CLI that the test scripts need for `nemoclaw <name> status`.
      // The `bin` field is in the root package.json (not nemoclaw/), so we need to:
      //   1. Build the TypeScript plugin (in nemoclaw/)
      //   2. npm link from the repo root (where bin.nemoclaw is defined)
      // Use npm_config_prefix so npm link writes to ~/.local/bin (no sudo needed),
      // which is already on PATH in runRemoteTest.
      console.log(`[${elapsed()}] Installing nemoclaw CLI...`);
      ssh(
        [
          `export npm_config_prefix=$HOME/.local`,
          `export PATH=$HOME/.local/bin:$PATH`,
          `cd ${remoteDir}/nemoclaw && npm install && npm run build`,
          `cd ${remoteDir} && npm install --ignore-scripts && npm link`,
          `which nemoclaw && nemoclaw --version`,
        ].join(" && "),
        { timeout: 120_000 },
      );
      console.log(`[${elapsed()}] nemoclaw CLI installed`);

      // Register the sandbox in nemoclaw's local registry.
      // setup.sh creates the sandbox via openshell directly but doesn't write
      // ~/.nemoclaw/sandboxes.json, which `nemoclaw <name> status` needs.
      console.log(`[${elapsed()}] Registering sandbox in nemoclaw registry...`);
      ssh(
        `mkdir -p ~/.nemoclaw && cat > ~/.nemoclaw/sandboxes.json << 'REGISTRY'
{
  "sandboxes": {
    "e2e-test": {
      "name": "e2e-test",
      "createdAt": "${new Date().toISOString()}",
      "model": null,
      "nimContainer": null,
      "provider": "nvidia-nim",
      "gpuEnabled": false,
      "policies": []
    }
  },
  "defaultSandbox": "e2e-test"
}
REGISTRY`,
        { timeout: 10_000 },
      );
      console.log(`[${elapsed()}] Sandbox registered`);
    }

    console.log(`[${elapsed()}] beforeAll complete — total bootstrap time: ${elapsed()}`);
  }, 2_700_000); // 45 min — covers both paths

  afterAll(() => {
    if (!instanceCreated) return;
    if (process.env.KEEP_ALIVE === "true") {
      console.log(`\n  Instance "${INSTANCE_NAME}" kept alive for debugging.`);
      console.log(`  To connect: brev refresh && ssh ${INSTANCE_NAME}`);
      console.log(`  To delete:  brev delete ${INSTANCE_NAME}\n`);
      return;
    }
    try {
      brev("delete", INSTANCE_NAME);
    } catch {
      // Best-effort cleanup — instance may already be gone
    }
  });

  // NOTE: The full E2E test runs install.sh --non-interactive which destroys and
  // rebuilds the sandbox from scratch. It cannot run alongside the security tests
  // (credential-sanitization, telegram-injection) which depend on the sandbox
  // that beforeAll already created. Run it only when TEST_SUITE=full.
  it.runIf(TEST_SUITE === "full")(
    "full E2E suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-full-e2e.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    900_000, // 15 min — install.sh --non-interactive rebuilds sandbox (~6 min) + inference tests
  );

  it.runIf(TEST_SUITE === "credential-sanitization" || TEST_SUITE === "all")(
    "credential sanitization suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-credential-sanitization.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );

  it.runIf(TEST_SUITE === "telegram-injection" || TEST_SUITE === "all")(
    "telegram bridge injection suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-telegram-injection.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    600_000,
  );
});
