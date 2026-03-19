// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync, spawnSync } = require("child_process");

const CREDS_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");

function loadCredentials() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCredential(key, value) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  const creds = loadCredentials();
  creds[key] = value;
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function getCredential(key) {
  if (process.env[key]) return process.env[key];
  const creds = loadCredentials();
  return creds[key] || null;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") {
          process.stdin.pause();
        }
        if (typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
      }
      resolve(answer.trim());
    });
  });
}

async function ensureApiKey() {
  let key = getCredential("NVIDIA_API_KEY");
  if (key) {
    process.env.NVIDIA_API_KEY = key;
    return;
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────────────────┐");
  console.log("  │  NVIDIA API Key required                                        │");
  console.log("  │                                                                 │");
  console.log("  │  1. Go to https://build.nvidia.com/settings/api-keys            │");
  console.log("  │  2. Sign in with your NVIDIA account                            │");
  console.log("  │  3. Click 'Generate API Key' button                             │");
  console.log("  │  4. Paste the key below (starts with nvapi-)                    │");
  console.log("  └─────────────────────────────────────────────────────────────────┘");
  console.log("");

  key = await prompt("  NVIDIA API Key: ");

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    process.exit(1);
  }

  // Validate the key against the NVIDIA API before saving
  console.log("  Validating API key...");
  const validation = validateApiKey(key);
  if (validation.ok) {
    console.log("  ✓ API key is valid");
  } else if (validation.fatal) {
    console.error(`  ✗ ${validation.message}`);
    process.exit(1);
  } else {
    console.log(`  ⓘ ${validation.message}`);
  }

  saveCredential("NVIDIA_API_KEY", key);
  process.env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

/**
 * Validate an NVIDIA API key by making a lightweight test request.
 * Returns { ok, fatal, message } where:
 *   ok:    true if the key is confirmed valid
 *   fatal: true if the key is definitively invalid (should not proceed)
 *   message: human-readable status
 */
function validateApiKey(key) {
  try {
    // Pass the auth header via stdin using -H @- so the API key
    // does not appear in process arguments visible via ps aux.
    const result = spawnSync(
      "curl",
      [
        "-sf",
        "-o", "/dev/null",
        "-w", "%{http_code}",
        "-H", "@-",
        "https://integrate.api.nvidia.com/v1/models",
      ],
      {
        input: `Authorization: Bearer ${key}`,
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    // Check for local spawn errors (curl missing, timeout) before inspecting stdout.
    if (result.error) {
      if (result.error.code === "ENOENT") {
        return { ok: false, fatal: false, message: "Could not validate key (curl is not installed). Proceeding with saved key." };
      }
      const reason = result.error.code === "ETIMEDOUT" ? "timed out" : result.error.message || "unknown error";
      return { ok: false, fatal: false, message: `Could not validate key (${reason}). Proceeding with saved key.` };
    }
    const httpCode = (result.stdout || "").trim();
    if (httpCode === "200") {
      return { ok: true, fatal: false, message: "API key validated successfully" };
    }
    if (httpCode === "401" || httpCode === "403") {
      return { ok: false, fatal: true, message: "API key is invalid or expired. Check https://build.nvidia.com/settings/api-keys" };
    }
    if (httpCode === "000" || !httpCode) {
      return { ok: false, fatal: false, message: "Could not reach NVIDIA API (network issue). Key format looks valid — proceeding." };
    }
    return { ok: false, fatal: false, message: `Unexpected response (HTTP ${httpCode}). Key format looks valid — proceeding.` };
  } catch {
    // Network failure — don't block onboarding, just warn
    return { ok: false, fatal: false, message: "Could not validate key (network error). Proceeding with saved key." };
  }
}

function isRepoPrivate(repo) {
  try {
    const json = execSync(`gh api repos/${repo} --jq .private 2>/dev/null`, { encoding: "utf-8" }).trim();
    return json === "true";
  } catch {
    return false;
  }
}

async function ensureGithubToken() {
  let token = getCredential("GITHUB_TOKEN");
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  try {
    token = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return;
    }
  } catch {}

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)   │");
  console.log("  │                                                  │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)    │");
  console.log("  │  Option B: Paste a PAT with read:packages scope  │");
  console.log("  └──────────────────────────────────────────────────┘");
  console.log("");

  token = await prompt("  GitHub Token: ");

  if (!token) {
    console.error("  Token required for deploy (repo is private).");
    process.exit(1);
  }

  saveCredential("GITHUB_TOKEN", token);
  process.env.GITHUB_TOKEN = token;
  console.log("");
  console.log("  Token saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

module.exports = {
  CREDS_DIR,
  CREDS_FILE,
  loadCredentials,
  saveCredential,
  getCredential,
  prompt,
  ensureApiKey,
  ensureGithubToken,
  isRepoPrivate,
  validateApiKey,
};
