// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { readConfigFile, writeConfigFile } from "./config-io";
import { isErrnoException } from "./errno";

const UNSAFE_HOME_PATHS = new Set(["/tmp", "/var/tmp", "/dev/shm", "/"]);

type CredentialInput = string | null | undefined;

export function resolveHomeDir(): string {
  const raw = process.env.HOME || os.homedir();
  if (!raw) {
    throw new Error(
      "Cannot determine safe home directory for credential storage. " +
        "Set the HOME environment variable to a user-owned directory.",
    );
  }
  const home = path.resolve(raw);
  try {
    const real = fs.realpathSync(home);
    if (UNSAFE_HOME_PATHS.has(real)) {
      throw new Error(
        "Cannot store credentials: HOME resolves to '" +
          real +
          "' which is world-readable. " +
          "Set the HOME environment variable to a user-owned directory.",
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
      "Cannot store credentials: HOME resolves to '" +
        home +
        "' which is world-readable. " +
        "Set the HOME environment variable to a user-owned directory.",
    );
  }
  return home;
}

let _cachedHome: string | null = null;
let _credsDir: string | null = null;
let _credsFile: string | null = null;

export function getCredsDir(): string {
  const home = resolveHomeDir();
  if (_cachedHome !== home) {
    _cachedHome = home;
    _credsDir = path.join(home, ".nemoclaw");
    _credsFile = null;
  }
  return _credsDir || path.join(home, ".nemoclaw");
}

export function getCredsFile(): string {
  const dir = getCredsDir();
  if (!_credsFile) _credsFile = path.join(dir, "credentials.json");
  return _credsFile;
}

export function loadCredentials(): Record<string, string> {
  return readConfigFile<Record<string, string>>(getCredsFile(), {});
}

export function normalizeCredentialValue(value: CredentialInput): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

export function saveCredential(key: string, value: CredentialInput): void {
  const creds = loadCredentials();
  creds[key] = normalizeCredentialValue(value);
  writeConfigFile(getCredsFile(), creds);
}

export function getCredential(key: string): string | null {
  const envValue = normalizeCredentialValue(process.env[key]);
  if (envValue) return envValue;
  const creds = loadCredentials();
  const value = normalizeCredentialValue(creds[key]);
  return value || null;
}

/**
 * Canonical entry point for provider credential resolution.
 * Resolves from process.env or ~/.nemoclaw/credentials.json via getCredential(),
 * and populates process.env so downstream code reading process.env directly
 * sees the value.  Returns the resolved value or null.
 *
 * This replaces the dual-pattern of hydrateCredentialEnv() + process.env[key]
 * checks.  See #2306.
 */
export function resolveProviderCredential(envName: string): string | null {
  const value = getCredential(envName);
  if (value) {
    process.env[envName] = value;
  }
  return value || null;
}

export function deleteCredential(key: string): boolean {
  const file = getCredsFile();
  if (!fs.existsSync(file)) return false;
  const creds = loadCredentials();
  if (!Object.prototype.hasOwnProperty.call(creds, key)) return false;
  delete creds[key];
  writeConfigFile(file, creds);
  return true;
}

export function listCredentialKeys(): string[] {
  return Object.keys(loadCredentials()).sort();
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
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
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
    /* ignored */
  }

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)   │");
  console.log("  │                                                  │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)    │");
  console.log("  │  Option B: Paste a PAT with read:packages scope  │");
  console.log("  └──────────────────────────────────────────────────┘");
  console.log("");

  token = await prompt("  GitHub Token: ", { secret: true });

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
