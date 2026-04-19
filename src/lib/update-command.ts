// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/install.sh";

/**
 * Compare two semver strings. Returns true if a >= b.
 */
export function versionGte(a: string, b: string): boolean {
  const normalize = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const aParts = normalize(a);
  const bParts = normalize(b);
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] || 0;
    const bi = bParts[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

/**
 * Fetch content from a URL using Node.js built-in http/https.
 */
export function fetchUrl(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        timeout: 10000,
        headers: { "User-Agent": "NemoClaw" },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error("Too many redirects"));
            return;
          }
          fetchUrl(res.headers.location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

/**
 * Get the current installed version of NemoClaw.
 */
export function getCurrentVersion(rootDir: string, clearCache = false): string {
  try {
    const pkgPath = path.join(rootDir, "package.json");
    if (clearCache) {
      // In TS/ESM we can't easily clear cache like require.cache
      // But for this purpose, reading the file directly is safer
      const raw = fs.readFileSync(pkgPath, "utf-8");
      return JSON.parse(raw).version || "0.0.0";
    }
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return JSON.parse(raw).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Get the current CLI path to determine if running from source.
 */
export function getCurrentCliPath(): string | null {
  try {
    return execSync("which nemoclaw 2>/dev/null", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the latest version from GitHub releases.
 */
export async function getLatestVersion(): Promise<string> {
  try {
    const data = await fetchUrl("https://api.github.com/repos/NVIDIA/NemoClaw/releases/latest");
    const release = JSON.parse(data);
    return release.tag_name || release.name || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Get the latest version from npm.
 */
export async function getLatestNpmVersion(): Promise<string> {
  try {
    const data = await fetchUrl("https://registry.npmjs.org/nemoclaw/latest");
    const pkg = JSON.parse(data);
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  runningFromSource: boolean;
}

/**
 * Check if an update is available.
 */
export async function checkForUpdate(rootDir: string): Promise<UpdateCheckResult> {
  const cliPath = getCurrentCliPath();
  const runningFromSource = !cliPath;

  let current = getCurrentVersion(rootDir);
  if (runningFromSource && cliPath) {
    try {
      const output = execSync(`"${cliPath}" --version 2>/dev/null`, { encoding: "utf-8" });
      const match = output.match(/(\d+\.\d+\.\d+)/);
      if (match) current = match[1];
    } catch {
      /* ignore */
    }
  }

  const [latestNpm, latestGithub] = await Promise.all([
    getLatestNpmVersion(),
    getLatestVersion(),
  ]);

  const latest = versionGte(latestNpm, latestGithub) ? latestNpm : latestGithub;
  const updateAvailable = !versionGte(current, latest);

  return { current, latest, updateAvailable, runningFromSource };
}

export interface RunUpdateOptions {
  force?: boolean;
  yes?: boolean;
  rootDir: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * Run the update. Downloads and executes the install script.
 */
export async function runUpdate(opts: RunUpdateOptions): Promise<boolean> {
  const { force = false, yes = false, rootDir } = opts;
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;

  log("");
  log("  Checking for updates...");
  log("");

  const { current, latest, updateAvailable, runningFromSource } = await checkForUpdate(rootDir);

  log(`  Current version: ${current}`);
  log(`  Latest version:  ${latest}`);

  if (!force && !updateAvailable) {
    log("");
    log("  You are running the latest version.");
    return true;
  }

  if (!yes) {
    log("");
    if (updateAvailable) {
      log("  A new version is available!");
    } else if (force) {
      log("  Reinstalling current version (--force was provided).");
    } else {
      log("  You are running the latest version.");
    }
    log("");
    if (runningFromSource) {
      log("  Since you're running from source, use 'git pull' to update:");
      log("    cd /path/to/NemoClaw && git pull");
    } else {
      const cmd = `nemoclaw update --yes${force ? " --force" : ""}`;
      log(`  Run '${cmd}' to update without prompting.`);
    }
    return false;
  }

  if (runningFromSource) {
    log("");
    log("  Since you're running from source, use 'git pull' to update:");
    log("    cd /path/to/NemoClaw && git pull");
    return false;
  }

  log("");
  log("  Updating NemoClaw...");
  log("");

  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-update-"));

    log("  Downloading installer...");
    const scriptContent = await fetchUrl(INSTALL_SCRIPT_URL);

    const hash = crypto.createHash("sha256").update(scriptContent).digest("hex");
    log(`  Script SHA256: ${hash.substring(0, 16)}...`);

    const scriptPath = path.join(tmpDir, "install.sh");
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    log("  Running installer...");
    execSync(`bash "${scriptPath}"`, {
      stdio: "inherit",
      cwd: tmpDir,
    });

    const newVersion = getCurrentVersion(rootDir, true);
    log("");
    log(`  Successfully updated to v${newVersion}`);
    return true;
  } catch (err: any) {
    error("");
    error(`  Update failed: ${err.message}`);
    error("");
    error("  You can also update manually with:");
    error("    npm install -g nemoclaw");
    return false;
  } finally {
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
