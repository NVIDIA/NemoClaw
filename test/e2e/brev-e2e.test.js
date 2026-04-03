// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ephemeral Brev E2E test suite.
 *
 * Creates a fresh Brev instance (via launchable or bare CPU), bootstraps it,
 * runs E2E tests remotely, then tears it down.
 *
 * Intended to be run from CI via:
 *   npx vitest run --project e2e-brev
 *
 * Required env vars:
 *   BREV_API_TOKEN   — Brev refresh token for headless auth
 *   NVIDIA_API_KEY   — passed to VM for inference config during onboarding
 *   GITHUB_TOKEN     — passed to VM for OpenShell binary download
 *   INSTANCE_NAME    — Brev instance name (e.g. pr-156-test)
 *
 * Optional env vars:
 *   TEST_SUITE             — which test to run: full (default), credential-sanitization, telegram-injection, all
 *   USE_LAUNCHABLE         — "1" (default) to use CI launchable, "0" for bare brev create + brev-setup.sh
 *   LAUNCHABLE_SETUP_SCRIPT — URL to setup script for launchable path (default: brev-launchable-ci-cpu.sh on main)
 *   BREV_MIN_VCPU          — Minimum vCPUs for CPU instance (default: 4)
 *   BREV_MIN_RAM           — Minimum RAM in GB for CPU instance (default: 16)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Instance configuration
const BREV_MIN_VCPU = parseInt(process.env.BREV_MIN_VCPU || "4", 10);
const BREV_MIN_RAM = parseInt(process.env.BREV_MIN_RAM || "16", 10);
const INSTANCE_NAME = process.env.INSTANCE_NAME;
const TEST_SUITE = process.env.TEST_SUITE || "full";
const REPO_DIR = path.resolve(import.meta.dirname, "../..");

// Launchable configuration
// CI-Ready CPU setup script: pre-bakes Docker, Node.js, OpenShell CLI, npm deps, Docker images.
// The Brev CLI (v0.6.322+) uses `brev search cpu | brev create --startup-script @file`.
// Default: use the repo-local script (hermetic — always matches the checked-out branch).
// Override via LAUNCHABLE_SETUP_SCRIPT env var to test a remote URL instead.
const DEFAULT_SETUP_SCRIPT_PATH =
  process.env.LAUNCHABLE_SETUP_SCRIPT ||
  path.join(REPO_DIR, "scripts", "brev-launchable-ci-cpu.sh");
const USE_LAUNCHABLE = !["0", "false"].includes(process.env.USE_LAUNCHABLE?.toLowerCase());

// Sentinel file written by brev-launchable-ci-cpu.sh when setup is complete.
// More reliable than grepping log files.
const LAUNCHABLE_SENTINEL = "/var/run/nemoclaw-launchable-ready";

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

function ssh(cmd, { timeout = 120_000, stream = false } = {}) {
  const escaped = cmd.replace(/'/g, "'\\''");
  /** @type {import("child_process").StdioOptions} */
  const stdio = stream ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"];
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
function shellEscape(value) {
  return String(value).replace(/'/g, "'\\''");
}

/** Run a command on the remote VM with env vars set for NemoClaw. */
function sshEnv(cmd, { timeout = 600_000, stream = false } = {}) {
  const envPrefix = [
    `export NVIDIA_API_KEY='${shellEscape(process.env.NVIDIA_API_KEY)}'`,
    `export GITHUB_TOKEN='${shellEscape(process.env.GITHUB_TOKEN)}'`,
    `export NEMOCLAW_NON_INTERACTIVE=1`,
    `export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`,
    `export NEMOCLAW_SANDBOX_NAME=e2e-test`,
  ].join(" && ");

  return ssh(`${envPrefix} && ${cmd}`, { timeout, stream });
}

function waitForSsh(maxAttempts = 90, intervalMs = 5_000) {
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

/**
 * Wait for the launchable setup script to finish by checking a sentinel file.
 * Much more reliable than grepping log files.
 */
function waitForLaunchableReady(maxWaitMs = 1_200_000, pollIntervalMs = 15_000) {
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

function runRemoteTest(scriptPath) {
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

    // Pre-cleanup: delete any leftover instance with the same name.
    // This can happen when a previous run's create succeeded on the backend
    // but the CLI got a network error (unexpected EOF) before confirming,
    // then the retry/fallback fails with "duplicate workspace".
    try {
      brev("delete", INSTANCE_NAME);
      console.log(`[${elapsed()}] Deleted leftover instance "${INSTANCE_NAME}"`);
    } catch {
      // Expected — no leftover instance exists
    }

    if (USE_LAUNCHABLE) {
      // ── Launchable path: pre-baked CI environment ──────────────────
      // Uses brev search cpu | brev create with --startup-script.
      // The script pre-installs Docker, Node.js, OpenShell CLI, npm deps,
      // and pre-pulls Docker images. We just need to rsync branch code and
      // run onboard.
      //
      // brev create (v0.6.322+) accepts --startup-script as a string or
      // @filepath — not a URL. So we download the script first.
      console.log(
        `[${elapsed()}] Creating instance via launchable (brev search cpu | brev create + startup-script)...`,
      );
      console.log(`[${elapsed()}]   setup-script: ${DEFAULT_SETUP_SCRIPT_PATH}`);
      console.log(`[${elapsed()}]   cpu: min ${BREV_MIN_VCPU} vCPU, ${BREV_MIN_RAM} GB RAM`);

      // Resolve the setup script to a local file path.
      // Default: repo-local scripts/brev-launchable-ci-cpu.sh (hermetic).
      // Override: set LAUNCHABLE_SETUP_SCRIPT to a URL and it gets downloaded.
      let setupScriptPath;
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

      // brev search cpu | brev create: finds cheapest CPU instance matching
      // our specs and creates it with the setup script attached.
      //
      // The Brev API sometimes returns "unexpected EOF" after the instance
      // is actually created server-side. The CLI then falls back to the next
      // instance type, which fails with "duplicate workspace". To handle this,
      // we catch create failures and check if the instance exists anyway.
      try {
        execSync(
          `brev search cpu --min-vcpu ${BREV_MIN_VCPU} --min-ram ${BREV_MIN_RAM} --sort price | ` +
            `brev create ${INSTANCE_NAME} --startup-script @${setupScriptPath} --detached`,
          { encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "inherit", "inherit"] },
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
        if (!lsOutput.includes(INSTANCE_NAME)) {
          throw new Error(
            `brev create failed and instance "${INSTANCE_NAME}" not found in brev ls. ` +
              `Original error: ${createErr.message}`,
            { cause: createErr },
          );
        }
        console.log(
          `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
        );
      }
      instanceCreated = true;
      console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);

      // Wait for SSH
      try {
        brev("refresh");
      } catch {
        /* ignore */
      }
      waitForSsh();
      console.log(`[${elapsed()}] SSH is up`);

      // Wait for launchable setup to finish (sentinel file)
      console.log(`[${elapsed()}] Waiting for launchable setup to complete...`);
      waitForLaunchableReady();

      // The launchable clones NemoClaw to ~/NemoClaw
      const remoteHome = ssh("echo $HOME");
      remoteDir = `${remoteHome}/NemoClaw`;

      // Rsync PR branch code over the launchable's clone
      console.log(`[${elapsed()}] Syncing PR branch code over launchable's clone...`);
      execSync(
        `rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude .venv "${REPO_DIR}/" "${INSTANCE_NAME}:${remoteDir}/"`,
        { encoding: "utf-8", timeout: 120_000 },
      );
      console.log(`[${elapsed()}] Code synced`);

      // Re-install deps for our branch (most already cached by launchable).
      // Use `npm install` instead of `npm ci` because the rsync'd branch code
      // may have a package.json/package-lock.json that are slightly out of sync
      // (e.g. new transitive deps). npm install is more forgiving and still
      // benefits from the launchable's pre-cached node_modules.
      console.log(`[${elapsed()}] Running npm install to sync dependencies...`);
      ssh(
        [
          `set -o pipefail`,
          `source ~/.nvm/nvm.sh 2>/dev/null || true`,
          `cd ${remoteDir}`,
          `npm install --ignore-scripts 2>&1 | tail -5`,
        ].join(" && "),
        { timeout: 300_000, stream: true },
      );
      console.log(`[${elapsed()}] Dependencies synced`);

      // Rebuild TS plugin for our branch (reinstall plugin deps in case they changed)
      console.log(`[${elapsed()}] Building TypeScript plugin...`);
      ssh(
        `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir}/nemoclaw && npm install && npm run build`,
        {
          timeout: 120_000,
          stream: true,
        },
      );
      console.log(`[${elapsed()}] Plugin built`);

      // Install nemoclaw CLI.
      // Use `sudo npm link` because Node.js is installed system-wide via
      // nodesource (global prefix is /usr), so creating the global symlink
      // requires elevated permissions.
      console.log(`[${elapsed()}] Installing nemoclaw CLI (npm link)...`);
      ssh(
        `source ~/.nvm/nvm.sh 2>/dev/null || true && cd ${remoteDir} && sudo npm link && sudo chown -R $(whoami):$(whoami) ${remoteDir}`,
        {
          timeout: 120_000,
          stream: true,
        },
      );
      console.log(`[${elapsed()}] nemoclaw CLI linked`);

      // Run onboard in the background. The `nemoclaw onboard` process hangs
      // after sandbox creation because `openshell sandbox create` keeps a
      // long-lived SSH connection to the sandbox entrypoint, and the dashboard
      // port-forward also blocks. We launch it in background, poll for sandbox
      // readiness via `openshell sandbox list`, then kill the hung process and
      // write the registry file ourselves.
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
            const tail = ssh(
              "tail -2 /tmp/nemoclaw-onboard.log 2>/dev/null || echo '(no log yet)'",
              {
                timeout: 10_000,
              },
            );
            console.log(
              `[${onboardElapsed()}] Onboard in progress... ${tail.replace(/\n/g, " | ")}`,
            );
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
          if (e.message.startsWith("Onboard failed")) throw e;
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

      // Kill the hung onboard process tree and write the sandbox registry
      // manually. The onboard hangs on the dashboard port-forward step and
      // never writes sandboxes.json.
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
          version: 1,
          defaultSandbox: "e2e-test",
          sandboxes: {
            "e2e-test": {
              name: "e2e-test",
              createdAt: new Date().toISOString(),
              model: null,
              nimContainer: null,
              provider: null,
              gpuEnabled: false,
              policies: [],
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
    } else {
      // ── Bare instance path: brev create + brev-setup.sh ────────────
      // Full bootstrap from scratch. Slower but doesn't require a launchable.
      console.log(`[${elapsed()}] Creating bare CPU instance via brev search cpu | brev create...`);
      console.log(`[${elapsed()}]   min-vcpu: ${BREV_MIN_VCPU}, min-ram: ${BREV_MIN_RAM}GB`);
      try {
        execSync(
          `brev search cpu --min-vcpu ${BREV_MIN_VCPU} --min-ram ${BREV_MIN_RAM} --sort price | ` +
            `brev create ${INSTANCE_NAME} --detached`,
          { encoding: "utf-8", timeout: 180_000, stdio: ["pipe", "inherit", "inherit"] },
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
        if (!lsOutput.includes(INSTANCE_NAME)) {
          throw new Error(
            `brev create failed and instance "${INSTANCE_NAME}" not found in brev ls. ` +
              `Original error: ${createErr.message}`,
            { cause: createErr },
          );
        }
        console.log(
          `[${elapsed()}] Instance "${INSTANCE_NAME}" found in brev ls despite create error — proceeding`,
        );
      }
      instanceCreated = true;
      console.log(`[${elapsed()}] brev create returned (instance provisioning in background)`);

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
      console.log(`[${elapsed()}] Running brev-setup.sh (bootstrap)...`);
      sshEnv(`cd ${remoteDir} && SKIP_VLLM=1 bash scripts/brev-setup.sh`, {
        timeout: 2_400_000,
        stream: true,
      });
      console.log(`[${elapsed()}] Bootstrap complete`);

      // Verify the CLI installed by brev-setup.sh is visible
      console.log(`[${elapsed()}] Verifying nemoclaw CLI...`);
      ssh(
        [
          `export npm_config_prefix=$HOME/.local`,
          `export PATH=$HOME/.local/bin:$PATH`,
          `which nemoclaw && nemoclaw --version`,
        ].join(" && "),
        { timeout: 120_000 },
      );
      console.log(`[${elapsed()}] nemoclaw CLI verified`);
    }

    // Verify sandbox registry (common to both paths)
    console.log(`[${elapsed()}] Verifying sandbox registry...`);
    const registry = JSON.parse(ssh(`cat ~/.nemoclaw/sandboxes.json`, { timeout: 10_000 }));
    expect(registry.defaultSandbox).toBe("e2e-test");
    expect(registry.sandboxes).toHaveProperty("e2e-test");
    const sandbox = registry.sandboxes["e2e-test"];
    expect(sandbox).toMatchObject({
      name: "e2e-test",
      gpuEnabled: false,
      policies: [],
    });
    console.log(`[${elapsed()}] Sandbox registry verified`);

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
});
