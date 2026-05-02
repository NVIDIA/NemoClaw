// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Branch Validation E2E — installs NemoClaw FROM SOURCE on a fresh Brev instance.
 *
 * Answers: "Does this branch work if you install from source on a clean machine?"
 *
 * Creates a fresh Brev instance, rsyncs the checked-out branch code, runs
 * install.sh from source, onboards a sandbox, then executes the selected test
 * suite against the live environment. Tears down the instance when done.
 *
 * NOTE: This does NOT test the community Launchable install path
 * (launch-plugin.sh). For that, see test-launchable-smoke.sh wired into
 * nightly-e2e.yaml.
 *
 * Intended to be run from CI via:
 *   npx vitest run --project e2e-branch-validation
 *
 * Required env vars:
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Prerequisite:
 *   The local `brev` CLI must already be authenticated before this suite runs.
 *
 * Optional env vars:
 *   TEST_SUITE             — which test to run: full (default), deploy-cli, credential-sanitization,
 *                             telegram-injection, messaging-providers,
 *                             messaging-compatible-endpoint, all
 *   LAUNCHABLE_SETUP_SCRIPT — URL to setup script for launchable path (default: brev-launchable-ci-cpu.sh on main)
 *   BREV_MIN_VCPU          — Minimum vCPUs for CPU instance (default: 4)
 *   BREV_MIN_RAM           — Minimum RAM in GB for CPU instance (default: 16)
 *   BREV_PROVIDER          — Cloud provider filter for brev search (default: gcp)
 *   BREV_MIN_DISK          — Minimum disk size in GB (default: 50)
 *   TELEGRAM_BOT_TOKEN       — Telegram bot token for messaging-providers test (fake OK)
 *   DISCORD_BOT_TOKEN        — Discord bot token for messaging-providers test (fake OK)
 *   SLACK_BOT_TOKEN          — Slack bot token for messaging-providers test (fake OK)
 *   SLACK_APP_TOKEN          — Slack app token for messaging-providers test (fake OK)
 *   SLACK_BOT_TOKEN_REVOKED  — Revoked xoxb- token to test auth pre-validation (#2340)
 *   SLACK_APP_TOKEN_REVOKED  — Paired xapp- token for the revoked bot token
 *   TELEGRAM_BOT_TOKEN_REAL  — Real Telegram token for optional live round-trip
 *   DISCORD_BOT_TOKEN_REAL   — Real Discord token for optional live round-trip
 *   TELEGRAM_CHAT_ID_E2E     — Telegram chat ID for optional sendMessage test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync, type StdioOptions } from "node:child_process";
import path from "node:path";

// Instance configuration
const BREV_MIN_VCPU = parseInt(process.env.BREV_MIN_VCPU || "4", 10);
const BREV_MIN_RAM = parseInt(process.env.BREV_MIN_RAM || "16", 10);
const BREV_PROVIDER = process.env.BREV_PROVIDER || "gcp";
const BREV_MIN_DISK = parseInt(process.env.BREV_MIN_DISK || "50", 10);
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(REPO_DIR, "bin", "nemoclaw.js");

function requireInstanceName(): string {
  if (!INSTANCE_NAME) {
    throw new Error("INSTANCE_NAME is required for Brev E2E tests");
  }
  return INSTANCE_NAME;
}

// Launchable configuration
// CI-Ready CPU setup script: pre-bakes Docker, Node.js, OpenShell CLI, npm deps, Docker images.
// The Brev CLI (v0.6.322+) uses `brev search cpu | brev create --startup-script @file`.
// Default: use the repo-local script (hermetic — always matches the checked-out branch).
// Override via LAUNCHABLE_SETUP_SCRIPT env var to test a remote URL instead.
const DEFAULT_SETUP_SCRIPT_PATH =
  process.env.LAUNCHABLE_SETUP_SCRIPT ||
  path.join(REPO_DIR, "scripts", "brev-launchable-ci-cpu.sh");
// Sentinel file written by brev-launchable-ci-cpu.sh when setup is complete.
// More reliable than grepping log files.
const LAUNCHABLE_SENTINEL = "/var/run/nemoclaw-launchable-ready";

let remoteDir = "";
let instanceCreated = false;

const STREAM_STDIO: StdioOptions = ["inherit", "inherit", "inherit"];
const CAPTURE_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];
const PIPE_INPUT_STDIO: StdioOptions = ["pipe", "inherit", "inherit"];

// --- low-level helpers ------------------------------------------------------

function brev(...args: string[]): string {
  return execFileSync("brev", args, {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function listBrevInstances(): Array<{ name: string; status?: string }> {
  try {
    return JSON.parse(brev("ls", "--json"));
  } catch {
    return [];
  }
}

function hasBrevInstance(instanceName: string): boolean {
  return listBrevInstances().some((instance) => instance.name === instanceName);
}

function isBrevInstanceDeleting(instanceName: string): boolean {
  const instances = listBrevInstances();
  const instance = instances.find(
    (i: { name: string; status?: string }) => i.name === instanceName,
  );
  return Boolean(instance && (instance.status === "DELETING" || instance.status === "STOPPING"));
}

function deleteBrevInstance(instanceName: string): boolean {
  if (!hasBrevInstance(instanceName)) {
    return true;
  }

  try {
    brev("delete", instanceName);
  } catch {
    // Best-effort delete
  }

  // If the instance is gone or in DELETING/STOPPING state, that's success —
  // Brev will finish the teardown asynchronously.
  if (!hasBrevInstance(instanceName) || isBrevInstanceDeleting(instanceName)) {
    return true;
  }

  return false;
}

function ssh(
  cmd: string,
  { timeout = 120_000, stream = false }: { timeout?: number; stream?: boolean } = {},
): string {
  const escaped = cmd.replace(/'/g, "'\\''");
  const stdio = stream ? STREAM_STDIO : CAPTURE_STDIO;
  const result = execSync(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR "${INSTANCE_NAME}" '${escaped}'`,
    { encoding: "utf-8", timeout, stdio },
  );
  return stream ? "" : result.trim();
}

/**
 * Escape a value for safe inclusion in a single-quoted shell string.
 * Replaces single quotes with the shell-safe sequence: '\''
 */
function shellEscape(value: string | null | undefined): string {
  return String(value).replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with env vars set for NemoClaw. */
function sshEnv(
  cmd: string,
  { timeout = 600_000, stream = false }: { timeout?: number; stream?: boolean } = {},
): string {
  const envParts = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ];
  // Forward optional messaging tokens for the messaging-providers test
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN_REVOKED",
    "SLACK_APP_TOKEN_REVOKED",
    "TELEGRAM_BOT_TOKEN_REAL",
    "DISCORD_BOT_TOKEN_REAL",
    "TELEGRAM_CHAT_ID_E2E",
  ]) {
    if (process.env[key]) {
      envParts.push(`export ${key}='${shellEscape(process.env[key])}'`);
    }
  }
  const envPrefix = envParts.join(" && ");

  return ssh(`${envPrefix} && ${cmd}`, { timeout, stream });
}

function waitForSsh(maxAttempts = 40, intervalMs = 5_000): void {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      ssh("echo ok", { timeout: 10_000 });
      return;
    } catch {
      if (i === maxAttempts)
        throw new Error(
          `SSH not ready after ${maxAttempts} attempts (~${Math.round((maxAttempts * (intervalMs + 10_000)) / 60_000)} min)`,
        );
      console.log(`  SSH attempt ${i}/${maxAttempts} failed, retrying in ${intervalMs / 1000}s...`);
      if (i % 5 === 0) {
        console.log(`  Refreshing brev SSH config...`);
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

/**
 * Wait for the launchable setup script to finish by checking a sentinel file.
 * Much more reliable than grepping log files.
 */
function waitForLaunchableReady(maxWaitMs = 1_200_000, pollIntervalMs = 15_000): void {
  const start = Date.now();
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`;
  let consecutiveSshFailures = 0;

  while (Date.now() - start < maxWaitMs) {
    try {
      const result = ssh(`test -f ${LAUNCHABLE_SENTINEL} && echo READY || echo PENDING`, {
        timeout: 15_000,
      });
      consecutiveSshFailures = 0; // reset on success
      if (result.includes("READY")) {
        console.log(`[${elapsed()}] Launchable setup complete (sentinel file found)`);
        return;
      }
      // Show progress from the setup log
      try {
        const tail = ssh("tail -2 /tmp/launch-plugin.log 2>/dev/null || echo '(no log yet)'", {
          timeout: 10_000,
        });
        console.log(`[${elapsed()}] Setup still running... ${tail.replace(/\n/g, " | ")}`);
      } catch {
        /* ignore */
      }
    } catch {
      consecutiveSshFailures++;
      console.log(
        `[${elapsed()}] Setup poll: SSH command failed (${consecutiveSshFailures} consecutive), retrying...`,
      );
      // Brev VMs sometimes reboot during setup (kernel upgrades, etc.)
      // Refresh the SSH config every 3 consecutive failures to pick up
      // new IP/port assignments after a reboot.
      if (consecutiveSshFailures % 3 === 0) {
        console.log(
          `[${elapsed()}] Refreshing brev SSH config after ${consecutiveSshFailures} failures...`,
        );
        try {
          brev("refresh");
        } catch {
          /* ignore */
        }
      }
    }
    execSync(`sleep ${pollIntervalMs / 1000}`);
  }

  throw new Error(
    `Launchable setup did not complete within ${maxWaitMs / 60_000} minutes. ` +
      `Sentinel file ${LAUNCHABLE_SENTINEL} not found.`,
  );
}

function runRemoteTest(scriptPath: string): string {
  const cmd = [
    `set -o pipefail`,
    `source ~/.nvm/nvm.sh 2>/dev/null || true`,
    `cd ${remoteDir}`,
    `export npm_config_prefix=$HOME/.local`,
    `export PATH=$HOME/.local/bin:$PATH`,
    // Docker socket is chmod 666 by setup script, no sg docker needed.

    `bash ${scriptPath} 2>&1 | tee /tmp/test-output.log`,
  ].join(" && ");

  // Stream test output to CI log AND capture it for assertions
  sshEnv(cmd, { timeout: 900_000, stream: true });
  // Retrieve the captured output for assertion checking
  return ssh("cat /tmp/test-output.log", { timeout: 30_000 });
}

function runLocalDeploy(instanceName: string): void {
  const env = {
    ...process.env,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-test",
    NEMOCLAW_PROVIDER: process.env.NEMOCLAW_PROVIDER || "build",
    NEMOCLAW_DEPLOY_NO_CONNECT: "1",
    NEMOCLAW_DEPLOY_NO_START_SERVICES: "1",
  };

  execFileSync("node", [CLI_PATH, "deploy", instanceName], {
    timeout: 2_700_000,
    env,
    stdio: "inherit",
  });
}

// --- beforeAll orchestration helpers ----------------------------------------

/**
 * Delete any leftover instance with the same name.
 * This can happen when a previous run's create succeeded on the backend
 * but the CLI got a network error (unexpected EOF) before confirming,
 * then the retry/fallback fails with "duplicate workspace".
 */
function cleanupLeftoverInstance(elapsed: () => string): void {
  const instanceName = requireInstanceName();
  if (hasBrevInstance(instanceName)) {
    if (!deleteBrevInstance(instanceName)) {
      throw new Error(`Failed to delete leftover instance "${instanceName}"`);
    }
    console.log(`[${elapsed()}] Deleted leftover instance "${instanceName}"`);
  }
}

/**
 * Refresh brev SSH config and wait for SSH connectivity.
 * Shared by both the deploy-cli and launchable paths.
 */
function refreshAndWaitForSsh(elapsed: () => string): void {
  try {
    brev("refresh");
  } catch {
    /* ignore */
  }
  waitForSsh();
  console.log(`[${elapsed()}] SSH is up`);
}

/**
 * Create a Brev instance via `brev search cpu | brev create` with a startup script.
 *
 * The Brev API sometimes returns "unexpected EOF" after the instance is actually
 * created server-side. The CLI then falls back to the next instance type, which
 * fails with "duplicate workspace". To handle this, we catch create failures and
 * check if the instance exists anyway.
 */
function createBrevInstance(elapsed: () => string): void {
  console.log(
    `[${elapsed()}] Creating instance via launchable (brev search cpu | brev create + startup-script)...`,
  );
  console.log(`[${elapsed()}]   setup-script: ${DEFAULT_SETUP_SCRIPT_PATH}`);
  console.log(
    `[${elapsed()}]   cpu: min ${BREV_MIN_VCPU} vCPU, ${BREV_MIN_RAM} GB RAM, ${BREV_MIN_DISK} GB disk, provider: ${BREV_PROVIDER}`,
  );

  // Resolve the setup script to a local file path.
  // Default: repo-local scripts/brev-launchable-ci-cpu.sh (hermetic).
  // Override: set LAUNCHABLE_SETUP_SCRIPT to a URL and it gets downloaded.
  let setupScriptPath: string;
  if (DEFAULT_SETUP_SCRIPT_PATH.startsWith("http")) {
    setupScriptPath = "/tmp/brev-ci-setup.sh";
    execSync(`curl -fsSL -o ${setupScriptPath} "${DEFAULT_SETUP_SCRIPT_PATH}"`, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    console.log(`[${elapsed()}] Setup script downloaded to ${setupScriptPath}`);
  } else {
    setupScriptPath = DEFAULT_SETUP_SCRIPT_PATH;
    console.log(`[${elapsed()}] Using repo-local setup script`);
  }

  try {
    execSync(
      `brev search cpu --min-vcpu ${BREV_MIN_VCPU} --min-ram ${BREV_MIN_RAM} --min-disk ${BREV_MIN_DISK} --provider ${BREV_PROVIDER} --sort price | ` +
        `brev create ${INSTANCE_NAME} --startup-script @${setupScriptPath} --detached`,
      { encoding: "utf-8", timeout: 180_000, stdio: PIPE_INPUT_STDIO },
    );
  } catch (createErr) {
    console.log(
      `[${elapsed()}] brev create exited with error — checking if instance was created anyway...`,
    );
    try {
      brev("refresh");
    } catch {
      /* ignore */
    }
    const lsOutput = execSync(`brev ls 2>&1 || true`, { encoding: "utf-8", timeout: 30_000 });
    const instanceName = requireInstanceName();
    if (!lsOutput.includes(instanceName)) {
      const createMessage = createErr instanceof Error ? createErr.message : String(createErr);
      throw new Error(
        `brev create failed and instance "${instanceName}" not found in brev ls. ` +
          `Original error: ${createMessage}`,
        { cause: createErr },
      );
    }
    console.log(
      `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
    );
  }
  console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);
}

/**
 * Bootstrap the launchable environment on the remote VM:
 * rsync branch code, install deps, build plugin, and npm link the CLI.
 *
 * Returns { remoteDir, needsOnboard } so the caller can see what was
 * resolved without relying on hidden side-effects.
 */
function bootstrapLaunchable(elapsed: () => string): { remoteDir: string; needsOnboard: boolean } {
  // The launchable clones NemoClaw to ~/NemoClaw
  const remoteHome = ssh("echo $HOME");
  const resolvedRemoteDir = `${remoteHome}/NemoClaw`;

  // Rsync PR branch code over the launchable's clone
  console.log(`[${elapsed()}] Syncing PR branch code over launchable's clone...`);
  execSync(
    `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${resolvedRemoteDir}/"`,
    { encoding: "utf-8", timeout: 120_000 },
  );
  console.log(`[${elapsed()}] Code synced`);

  // Re-install deps for our branch (most already cached by launchable).
  // Use `npm install` instead of `npm ci` because the rsync'd branch code
  // may have a package.json/package-lock.json that are slightly out of sync
  // (e.g. new transitive deps). npm install is more forgiving and still
  // benefits from the launchable's pre-cached node_modules.
  // Always run this even for TEST_SUITE=full — it primes the cache so
  // install.sh's npm install is a fast no-op.
  console.log(`[${elapsed()}] Running npm install to sync dependencies...`);
  ssh(
    [
      `set -o pipefail`,
      `source ~/.nvm/nvm.sh 2>/dev/null || true`,
      `cd ${resolvedRemoteDir}`,
      `npm install --ignore-scripts 2>&1 | tail -5`,
    ].join(" && "),
    { timeout: 300_000, stream: true },
  );
  console.log(`[${elapsed()}] Dependencies synced`);

  // When TEST_SUITE=full, test-full-e2e.sh runs install.sh which handles
  // plugin build, npm link, and onboard from scratch. Skip those steps
  // to avoid ~8 min of redundant work.
  if (TEST_SUITE === "full") {
    console.log(
      `[${elapsed()}] Skipping plugin build, npm link, and onboard (TEST_SUITE=full — install.sh handles it)`,
    );
    return { remoteDir: resolvedRemoteDir, needsOnboard: false };
  }

  // Rebuild CLI dist/ for our branch. The rsync above excludes dist/, so
  // without this step bin/nemoclaw.js would `require("../dist/nemoclaw")`
  // against the launchable's main-branch build and crash with
  // MODULE_NOT_FOUND if main differs from the PR branch. `npm install
  // --ignore-scripts` skipped the `prepare` lifecycle that normally runs
  // `build:cli`, so do it explicitly.
  console.log(`[${elapsed()}] Building CLI (dist/) for PR branch...`);
  ssh(`source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${resolvedRemoteDir} && npm run build:cli`, {
    timeout: 120_000,
    stream: true,
  });
  console.log(`[${elapsed()}] CLI built`);

  // Rebuild TS plugin for our branch (reinstall plugin deps in case they changed)
  console.log(`[${elapsed()}] Building TypeScript plugin...`);
  ssh(
    `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${resolvedRemoteDir}/nemoclaw && npm install && npm run build`,
    {
      timeout: 120_000,
      stream: true,
    },
  );
  console.log(`[${elapsed()}] Plugin built`);

  // Expose the nemoclaw CLI on PATH. The launchable setup script already
  // creates /usr/local/bin/nemoclaw → $NEMOCLAW_CLONE_DIR/bin/nemoclaw.js
  // as a direct symlink, and rsync above preserves that path, so this is
  // an idempotent re-link to make local dev runs (that skip the launchable)
  // still work. Avoid `sudo npm link` on cold CPU Brev — it routinely
  // hangs inside npm's global-prefix housekeeping.
  console.log(`[${elapsed()}] Linking nemoclaw CLI (direct symlink)...`);
  ssh(
    `sudo ln -sf ${resolvedRemoteDir}/bin/nemoclaw.js /usr/local/bin/nemoclaw && sudo chmod +x ${resolvedRemoteDir}/bin/nemoclaw.js`,
    {
      timeout: 30_000,
      stream: true,
    },
  );
  console.log(`[${elapsed()}] nemoclaw CLI linked`);

  return { remoteDir: resolvedRemoteDir, needsOnboard: true };
}

/**
 * Launch nemoclaw onboard in background and poll until the sandbox is Ready.
 *
 * The `nemoclaw onboard` process hangs after sandbox creation because
 * `openshell sandbox create` keeps a long-lived SSH connection to the sandbox
 * entrypoint, and the dashboard port-forward also blocks. We launch it in
 * background, poll for sandbox readiness via `openshell sandbox list`, then
 * hand off to writeManualRegistry() to kill the hung process.
 */
function pollForSandboxReady(elapsed: () => string): void {
  // Launch onboard fully detached. We chmod the docker socket so we don't
  // need sg docker (which complicates backgrounding). nohup + </dev/null +
  // disown ensures the SSH session can exit cleanly without waiting for
  // the background process.
  console.log(`[${elapsed()}] Starting nemoclaw onboard in background...`);
  ssh(`sudo chmod 666 /var/run/docker.sock 2>/dev/null || true`, { timeout: 10_000 });
  // Launch onboard in background. The SSH command may exit with code 255
  // (SSH error) because background processes keep file descriptors open.
  // That's fine — we just need the process to start; we'll poll for
  // sandbox readiness separately.
  try {
    sshEnv(
      [
        `source ~/.nvm/nvm.sh 2>/dev/null || true`,
        `cd ${remoteDir}`,
        `nohup nemoclaw onboard --non-interactive </dev/null >/tmp/nemoclaw-onboard.log 2>&1 & disown`,
        `sleep 2`,
        `echo "onboard launched"`,
      ].join(" && "),
      { timeout: 30_000 },
    );
  } catch (bgErr) {
    // SSH exit 255 or ETIMEDOUT is expected when backgrounding processes.
    // Verify the process actually started by checking the log file.
    try {
      const check = ssh("test -f /tmp/nemoclaw-onboard.log && echo OK || echo MISSING", {
        timeout: 10_000,
      });
      if (check.includes("OK")) {
        console.log(
          `[${elapsed()}] Background launch returned non-zero but log file exists — continuing`,
        );
      } else {
        throw bgErr;
      }
    } catch {
      throw bgErr;
    }
  }
  console.log(`[${elapsed()}] Onboard launched in background`);

  // Poll until openshell reports the sandbox as Ready (or onboard fails).
  // The sandbox step is the slow part (~5-10 min for image build + upload).
  const maxOnboardWaitMs = 1_200_000; // 20 min
  const onboardPollMs = 15_000;
  const onboardStart = Date.now();
  const onboardElapsed = () => `${Math.round((Date.now() - onboardStart) / 1000)}s`;

  while (Date.now() - onboardStart < maxOnboardWaitMs) {
    try {
      const sandboxList = ssh(`openshell sandbox list 2>/dev/null || true`, {
        timeout: 15_000,
      });
      if (sandboxList.includes("e2e-test") && sandboxList.includes("Ready")) {
        console.log(`[${onboardElapsed()}] Sandbox e2e-test is Ready!`);
        break;
      }
      // Show onboard progress from the log
      try {
        const tail = ssh("tail -2 /tmp/nemoclaw-onboard.log 2>/dev/null || echo '(no log yet)'", {
          timeout: 10_000,
        });
        console.log(`[${onboardElapsed()}] Onboard in progress... ${tail.replace(/\n/g, " | ")}`);
      } catch {
        /* ignore */
      }
    } catch {
      console.log(`[${onboardElapsed()}] Poll: SSH command failed, retrying...`);
    }

    // Check if onboard failed (process exited and no sandbox)
    try {
      const session = ssh("cat ~/.nemoclaw/onboard-session.json 2>/dev/null || echo '{}'", {
        timeout: 10_000,
      });
      const parsed = JSON.parse(session);
      if (parsed.status === "failed") {
        const failLog = ssh("cat /tmp/nemoclaw-onboard.log 2>/dev/null || echo 'no log'", {
          timeout: 10_000,
        });
        throw new Error(`Onboard failed: ${parsed.failure || "unknown"}\n${failLog}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Onboard failed")) throw e;
      /* ignore parse errors */
    }

    execSync(`sleep ${onboardPollMs / 1000}`);
  }

  // Verify sandbox is actually ready
  const finalList = ssh(`openshell sandbox list 2>/dev/null`, { timeout: 15_000 });
  if (!finalList.includes("e2e-test") || !finalList.includes("Ready")) {
    const failLog = ssh("cat /tmp/nemoclaw-onboard.log 2>/dev/null || echo 'no log'", {
      timeout: 10_000,
    });
    throw new Error(`Sandbox not ready after ${maxOnboardWaitMs / 60_000} min.\n${failLog}`);
  }
}

/**
 * Kill the hung onboard process tree and write the sandbox registry manually.
 *
 * The onboard hangs on the dashboard port-forward step and never writes
 * sandboxes.json. We kill it and write the registry ourselves.
 *
 * Note: The registry shape matches SandboxRegistry from src/lib/registry.ts
 * (sandboxes + defaultSandbox only — no version field).
 */
function writeManualRegistry(elapsed: () => string): void {
  console.log(`[${elapsed()}] Sandbox ready — killing hung onboard and writing registry...`);
  // Kill hung onboard processes. pkill may kill the SSH connection itself
  // if the pattern matches too broadly, so wrap in try/catch.
  try {
    ssh(
      `pkill -f "nemoclaw onboard" 2>/dev/null; pkill -f "openshell sandbox create" 2>/dev/null; sleep 1; true`,
      { timeout: 15_000 },
    );
  } catch {
    // SSH exit 255 is expected — pkill may terminate the connection
    console.log(
      `[${elapsed()}] pkill returned non-zero (expected — SSH connection may have been affected)`,
    );
  }
  // Write the sandbox registry using printf to avoid heredoc quoting issues over SSH
  const registryJson = JSON.stringify(
    {
      defaultSandbox: "e2e-test",
      sandboxes: {
        "e2e-test": {
          name: "e2e-test",
          createdAt: new Date().toISOString(),
          model: null,
          nimContainer: null,
          provider: null,
          gpuEnabled: false,
          policies: ["pypi", "npm"],
        },
      },
    },
    null,
    2,
  );
  ssh(
    `mkdir -p ~/.nemoclaw && printf '%s' '${shellEscape(registryJson)}' > ~/.nemoclaw/sandboxes.json`,
    { timeout: 15_000 },
  );
  console.log(`[${elapsed()}] Registry written, onboard workaround complete`);
}

// --- suite ------------------------------------------------------------------

const REQUIRED_VARS = ["NVIDIA_API_KEY", "GITHUB_TOKEN", "INSTANCE_NAME"];
const hasRequiredVars = REQUIRED_VARS.every((key) => process.env[key]);
const hasAuthenticatedBrev = (() => {
  try {
    brev("ls");
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasRequiredVars && hasAuthenticatedBrev)("Brev E2E", () => {
  beforeAll(() => {
    const bootstrapStart = Date.now();
    const elapsed = () => `${Math.round((Date.now() - bootstrapStart) / 1000)}s`;

    cleanupLeftoverInstance(elapsed);

    if (TEST_SUITE === "deploy-cli") {
      console.log(`[${elapsed()}] Running nemoclaw deploy end to end...`);
      instanceCreated = true;
      runLocalDeploy(requireInstanceName());
      refreshAndWaitForSsh(elapsed);
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/nemoclaw`;
    } else {
      // ── Launchable path: pre-baked CI environment ──────────────────
      // Uses brev search cpu | brev create with --startup-script.
      // The script pre-installs Docker, Node.js, OpenShell CLI, npm deps,
      // and pre-pulls Docker images. We just need to rsync branch code and
      // run onboard.
      createBrevInstance(elapsed);
      instanceCreated = true;
      refreshAndWaitForSsh(elapsed);

      // Wait for launchable setup to finish (sentinel file)
      console.log(`[${elapsed()}] Waiting for launchable setup to complete...`);
      waitForLaunchableReady();

      const result = bootstrapLaunchable(elapsed);
      remoteDir = result.remoteDir;

      if (result.needsOnboard) {
        pollForSandboxReady(elapsed);
        writeManualRegistry(elapsed);
      }
    }

    // Verify sandbox registry (only when beforeAll created a sandbox)
    if (TEST_SUITE !== "full") {
      console.log(`[${elapsed()}] Verifying sandbox registry...`);
      const registry = JSON.parse(ssh(`cat ~/.nemoclaw/sandboxes.json`, { timeout: 10_000 }));
      expect(registry.defaultSandbox).toBe("e2e-test");
      expect(registry.sandboxes).toHaveProperty("e2e-test");
      const sandbox = registry.sandboxes["e2e-test"];
      expect(sandbox).toMatchObject({
        name: "e2e-test",
        gpuEnabled: false,
        policies: ["pypi", "npm"],
      });
      console.log(`[${elapsed()}] Sandbox registry verified`);
    }

    console.log(`[${elapsed()}] beforeAll complete — total bootstrap time: ${elapsed()}`);
  }, 2_700_000); // 45 min

  afterAll(() => {
    if (!instanceCreated) return;
    if (process.env.KEEP_ALIVE === "true") {
      console.log(`\n  Instance "${INSTANCE_NAME}" kept alive for debugging.`);
      console.log(`  To connect: brev refresh && ssh ${INSTANCE_NAME}`);
      console.log(`  To delete:  brev delete ${INSTANCE_NAME}\n`);
      return;
    }
    deleteBrevInstance(requireInstanceName());
  }, 120_000); // 2 min for cleanup

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
    900_000,
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

  it.runIf(TEST_SUITE === "deploy-cli")(
    "deploy CLI provisions a remote sandbox end to end",
    () => {
      const sandboxList = ssh(
        "export PATH=$HOME/.local/bin:$PATH && openshell sandbox list 2>/dev/null",
        { timeout: 30_000 },
      );
      expect(sandboxList).toContain("e2e-test");
      expect(sandboxList).toContain("Ready");

      const registry = JSON.parse(ssh("cat ~/.nemoclaw/sandboxes.json", { timeout: 10_000 }));
      expect(registry.defaultSandbox).toBe("e2e-test");
      expect(registry.sandboxes).toHaveProperty("e2e-test");
    },
    120_000,
  );

  // NOTE: The messaging-providers test creates its own sandbox (e2e-msg-provider)
  // with messaging tokens attached. It does not conflict with the e2e-test sandbox
  // used by other tests, but it may recreate the gateway.
  it.runIf(TEST_SUITE === "messaging-providers" || TEST_SUITE === "all")(
    "messaging credential provider suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-messaging-providers.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    900_000, // 15 min — creates a new sandbox with messaging providers
  );

  // NOTE: The compatible-endpoint messaging test creates its own sandbox
  // (e2e-msg-compat) with Telegram attached and a local OpenAI-compatible
  // mock endpoint. It covers the inference.local path used by Telegram turns.
  it.runIf(TEST_SUITE === "messaging-compatible-endpoint" || TEST_SUITE === "all")(
    "messaging compatible endpoint suite passes on remote VM",
    () => {
      const output = runRemoteTest("test/e2e/test-messaging-compatible-endpoint.sh");
      expect(output).toContain("PASS");
      expect(output).not.toMatch(/FAIL:/);
    },
    900_000, // 15 min — creates a new sandbox with Telegram + compatible endpoint
  );
});
