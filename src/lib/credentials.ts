// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side credential helpers.
//
// The OpenShell gateway is the system of record for provider credentials.
// This module holds them only in the current process environment so they
// can be passed through to `openshell provider create/update --credential KEY`
// during onboarding. Nothing is written to disk.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { isErrnoException } from "./errno";

const UNSAFE_HOME_PATHS = new Set(["/tmp", "/var/tmp", "/dev/shm", "/"]);

type CredentialInput = string | null | undefined;

// Credential env keys NemoClaw knows how to round-trip. listCredentialKeys()
// projects the in-process env through this set; entries not in the set are
// invisible to `nemoclaw credentials list` even if exported.
const KNOWN_CREDENTIAL_ENV_KEYS: readonly string[] = [
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_CHAT_IDS",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
];

export function resolveHomeDir(): string {
  const raw = process.env.HOME || os.homedir();
  if (!raw) {
    throw new Error(
      "Cannot determine safe home directory. " +
        "Set the HOME environment variable to a user-owned directory.",
    );
  }
  const home = path.resolve(raw);
  try {
    const real = fs.realpathSync(home);
    if (UNSAFE_HOME_PATHS.has(real)) {
      throw new Error(
        "Cannot use HOME='" +
          real +
          "': resolves to a world-readable path. " +
          "Set HOME to a user-owned directory.",
      );
    }
  } catch (error) {
    if (
      !isErrnoException(error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (UNSAFE_HOME_PATHS.has(home)) {
    throw new Error(
      "Cannot use HOME='" +
        home +
        "': resolves to a world-readable path. " +
        "Set HOME to a user-owned directory.",
    );
  }
  return home;
}

let _cachedHome: string | null = null;
let _credsDir: string | null = null;
let _legacyCredsFile: string | null = null;

export function getCredsDir(): string {
  const home = resolveHomeDir();
  if (_cachedHome !== home) {
    _cachedHome = home;
    _credsDir = path.join(home, ".nemoclaw");
    _legacyCredsFile = null;
  }
  return _credsDir || path.join(home, ".nemoclaw");
}

// Path of the pre-migration plaintext credentials file. Retained only so
// migrateLegacyCredentialsFile() can find and securely delete it. New code
// must NOT write to this path; the gateway is the system of record.
export function getCredsFile(): string {
  const dir = getCredsDir();
  if (!_legacyCredsFile) _legacyCredsFile = path.join(dir, "credentials.json");
  return _legacyCredsFile;
}

export function normalizeCredentialValue(value: CredentialInput): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

// Stage a credential for the current process. The OpenShell upsert that
// follows in onboarding (`openshell provider create/update --credential KEY`)
// reads the value from this env entry. Nothing is persisted to disk.
export function saveCredential(key: string, value: CredentialInput): void {
  const normalized = normalizeCredentialValue(value);
  if (normalized) {
    process.env[key] = normalized;
  } else {
    delete process.env[key];
  }
}

export function getCredential(key: string): string | null {
  const raw = process.env[key];
  if (!raw) return null;
  const normalized = normalizeCredentialValue(raw);
  return normalized || null;
}

export function deleteCredential(key: string): boolean {
  if (!(key in process.env)) return false;
  delete process.env[key];
  return true;
}

export function loadCredentials(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of KNOWN_CREDENTIAL_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    const normalized = normalizeCredentialValue(raw);
    if (normalized) result[key] = normalized;
  }
  return result;
}

export function listCredentialKeys(): string[] {
  return Object.keys(loadCredentials()).sort();
}

// Best-effort secure unlink: zero the file's bytes, fsync, then unlink.
// Does not defeat copy-on-write filesystems or prior backup snapshots, but
// removes the cleartext from the typical ext4/HFS+/APFS-without-snapshot
// path that backup tools and same-user processes tend to read.
function secureUnlink(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 0) {
      const fd = fs.openSync(filePath, "r+");
      try {
        const chunkSize = Math.min(stat.size, 64 * 1024);
        const zeros = Buffer.alloc(chunkSize);
        let written = 0;
        while (written < stat.size) {
          const len = Math.min(chunkSize, stat.size - written);
          fs.writeSync(fd, zeros, 0, len, written);
          written += len;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // best effort
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

// Hydrate process.env from a pre-fix plaintext credentials.json (if one
// exists), then securely remove the file. The next onboarding step pushes
// each value into the OpenShell gateway via the existing upsertProvider
// path. Returns the credential keys that were migrated, or [].
export function migrateLegacyCredentialsFile(): string[] {
  const legacyFile = getCredsFile();
  if (!fs.existsSync(legacyFile)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(legacyFile, "utf-8");
  } catch {
    secureUnlink(legacyFile);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    secureUnlink(legacyFile);
    return [];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    secureUnlink(legacyFile);
    return [];
  }

  const migrated: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeCredentialValue(value);
    if (!normalized) continue;
    // Defer to env values that were already set (e.g. by the user) so the
    // file cannot silently override an explicit override.
    if (!process.env[key]) process.env[key] = normalized;
    migrated.push(key);
  }

  secureUnlink(legacyFile);
  return migrated.sort();
}

export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    let answer = "";
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      if (typeof input.pause === "function") {
        input.pause();
      }
    }

    function resolvePrompt(value: string) {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve(value);
    }

    function rejectPrompt(error: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      reject(error);
    }

    function onData(chunk: Buffer | string) {
      const text = chunk.toString();
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (ch === "\u0003") {
          rejectPrompt(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          return;
        }

        if (ch === "\r" || ch === "\n") {
          resolvePrompt(answer.trim());
          return;
        }

        if (ch === "\u0008" || ch === "\u007f") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }

        if (ch === "\u001b") {
          const rest = text.slice(i);
          // eslint-disable-next-line no-control-regex
          const match = rest.match(/^\u001b(?:\[[0-9;?]*[~A-Za-z]|\][^\u0007]*\u0007|.)/);
          if (match) {
            i += match[0].length - 1;
          }
          continue;
        }

        if (ch >= " ") {
          answer += ch;
          output.write("*");
        }
      }
    }

    output.write(question);
    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });
}

export function prompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const silent = opts.secret === true && process.stdin.isTTY && process.stderr.isTTY;
    if (silent) {
      promptSecret(question)
        .then(resolve)
        .catch((error: NodeJS.ErrnoException) => {
          if (error && error.code === "SIGINT") {
            reject(error);
            process.kill(process.pid, "SIGINT");
            return;
          }
          reject(error);
        });
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let finished = false;

    function cleanup() {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") {
          process.stdin.pause();
        }
        if (typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
      }
    }

    function resolvePrompt(value: string) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    }

    function rejectPrompt(error: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    }

    rl.on("SIGINT", () => {
      const error = Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
      rejectPrompt(error);
      process.kill(process.pid, "SIGINT");
    });
    rl.question(question, (answer) => {
      resolvePrompt(answer.trim());
    });
  });
}

export async function ensureApiKey(): Promise<void> {
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

  while (true) {
    key = normalizeCredentialValue(await prompt("  NVIDIA API Key: ", { secret: true }));

    if (!key) {
      console.error("  NVIDIA API Key is required.");
      continue;
    }

    if (!key.startsWith("nvapi-")) {
      console.error("  Invalid NVIDIA API key. Must start with nvapi-");
      continue;
    }

    break;
  }

  saveCredential("NVIDIA_API_KEY", key);
  process.env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key staged for the OpenShell gateway. It is held in process memory only;");
  console.log("  onboarding registers it with the gateway and nothing is written to disk.");
  console.log("");
}

export function isRepoPrivate(repo: string): boolean {
  try {
    const json = execFileSync("gh", ["api", `repos/${repo}`, "--jq", ".private"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return json === "true";
  } catch {
    return false;
  }
}

export async function ensureGithubToken(): Promise<void> {
  let token = getCredential("GITHUB_TOKEN");
  if (token) {
    process.env.GITHUB_TOKEN = token;
    return;
  }

  // Preferred path: gh CLI keeps tokens in the OS keychain.
  try {
    token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return;
    }
  } catch {
    /* gh not available or not logged in */
  }

  console.log("");
  console.log("  ┌────────────────────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)                 │");
  console.log("  │                                                                │");
  console.log("  │  Recommended: run 'gh auth login' so the token is stored in    │");
  console.log("  │  the system keychain. NemoClaw will pick it up automatically.  │");
  console.log("  │                                                                │");
  console.log("  │  Otherwise, paste a PAT below for this run only.               │");
  console.log("  └────────────────────────────────────────────────────────────────┘");
  console.log("");

  token = await prompt("  GitHub Token: ", { secret: true });

  if (!token) {
    console.error("  Token required for deploy (repo is private).");
    process.exit(1);
  }

  saveCredential("GITHUB_TOKEN", token);
  process.env.GITHUB_TOKEN = token;
  console.log("");
  console.log("  Token loaded for this session only. Run 'gh auth login' to persist");
  console.log("  it in the system keychain so future runs do not prompt.");
  console.log("");
}
