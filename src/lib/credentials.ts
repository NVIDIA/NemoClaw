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

import { rejectSymlinksOnPath } from "./config-io";
import { isErrnoException } from "./errno";

const UNSAFE_HOME_PATHS = new Set(["/tmp", "/var/tmp", "/dev/shm", "/"]);

type CredentialInput = string | null | undefined;

// Credential env keys NemoClaw knows how to round-trip. listCredentialKeys()
// projects the in-process env through this set; entries not in the set are
// invisible to `nemoclaw credentials list` even if exported.
// Exported so tests can import the same source-of-truth list and stay in
// sync without a second hand-maintained copy.
export const KNOWN_CREDENTIAL_ENV_KEYS: readonly string[] = [
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_CHAT_IDS",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
];

// Hard upper bound on the legacy credentials.json size we are willing to
// read into memory. The largest realistic credential set NemoClaw has ever
// shipped is well under 1 KiB; the cap exists purely so an attacker who
// can write to ~/.nemoclaw/ cannot OOM the next onboard by planting a
// huge file. 1 MiB leaves plenty of headroom over any plausible mutation.
const LEGACY_CREDS_FILE_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Resolve the user's home directory and reject obviously unsafe choices
 * (e.g. `/tmp`, `/`) so we never use a world-readable path for state.
 * Throws if `HOME` cannot be determined or resolves to an unsafe location.
 */
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

/** Return `~/.nemoclaw`, resolving and validating `HOME` once per process. */
export function getCredsDir(): string {
  const home = resolveHomeDir();
  if (_cachedHome !== home) {
    _cachedHome = home;
    _credsDir = path.join(home, ".nemoclaw");
    _legacyCredsFile = null;
  }
  return _credsDir || path.join(home, ".nemoclaw");
}

/**
 * Path of the pre-migration plaintext credentials file. Retained only so
 * stageLegacyCredentialsToEnv() / removeLegacyCredentialsFile() can find it.
 * New code must NOT write to this path; the gateway is the system of record.
 */
export function getCredsFile(): string {
  const dir = getCredsDir();
  if (!_legacyCredsFile) _legacyCredsFile = path.join(dir, "credentials.json");
  return _legacyCredsFile;
}

/** Trim whitespace and strip CR characters that shells often append on paste. */
export function normalizeCredentialValue(value: CredentialInput): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

/**
 * Stage a credential for the current process. The OpenShell upsert that
 * follows in onboarding (`openshell provider create/update --credential KEY`)
 * reads the value from this env entry. Nothing is persisted to disk.
 * An empty/whitespace value clears the env entry instead of staging blanks.
 *
 * NOTE for tests: this mutates `process.env` directly (not via vitest's
 * `vi.stubEnv`), so callers that pollute the env in a unit test must
 * clean up themselves — see `test/credentials.test.ts` for the
 * `clearTrackedEnv` pattern.
 */
export function saveCredential(key: string, value: CredentialInput): void {
  const normalized = normalizeCredentialValue(value);
  if (normalized) {
    process.env[key] = normalized;
  } else {
    delete process.env[key];
  }
}

/** Return the staged value for `key` from the current process env, or null. */
export function getCredential(key: string): string | null {
  const raw = process.env[key];
  if (!raw) return null;
  const normalized = normalizeCredentialValue(raw);
  return normalized || null;
}

/**
 * Canonical entry point for provider credential resolution (PR #2306).
 * Resolves the credential for `envName` from `process.env`, falling back
 * to a one-time on-demand stage of any pre-fix `~/.nemoclaw/credentials.json`,
 * and writes the resolved value back into `process.env` so downstream
 * code that reads `process.env[envName]` directly sees it.
 *
 * Returns the resolved value, or `null` if neither env nor the legacy
 * file produced one.
 *
 * Note: this used to read the credentials file directly via
 * `loadCredentials()` after #2306 landed on main, but that path is
 * incompatible with the env-only contract introduced for the
 * credentials-gateway-only security fix. The legacy file is now
 * accessed only through `stageLegacyCredentialsToEnv()`, which
 * allowlists keys, refuses ancestor symlinks, fstats by descriptor,
 * caps file size, and is gated by the per-key fill-only-if-missing
 * guard inside the staging helper itself.
 */
export function resolveProviderCredential(envName: string): string | null {
  let value = getCredential(envName);
  if (!value) {
    stageLegacyCredentialsToEnv();
    value = getCredential(envName);
  }
  if (value) {
    process.env[envName] = value;
  }
  return value || null;
}

/** Clear the staged credential from the current process env. */
export function deleteCredential(key: string): boolean {
  if (!(key in process.env)) return false;
  delete process.env[key];
  return true;
}

/**
 * Snapshot of credentials currently staged in `process.env`, projected
 * through `KNOWN_CREDENTIAL_ENV_KEYS`. Unrelated env entries are not exposed.
 */
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

/** Sorted list of credential env-var names currently staged in this process. */
export function listCredentialKeys(): string[] {
  return Object.keys(loadCredentials()).sort();
}

/**
 * Best-effort secure unlink: zero the file's bytes, fsync, then unlink.
 * Refuses to follow symlinks (lstat + O_NOFOLLOW) so a planted symlink
 * cannot redirect the zero-fill onto an unrelated file. Does not defeat
 * copy-on-write filesystems or prior backup snapshots, but removes the
 * cleartext from the typical ext4/HFS+/APFS-without-snapshot path that
 * backup tools and same-user processes tend to read.
 */
function secureUnlink(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      // The credentials path was a symlink; remove the link itself without
      // touching whatever it pointed at.
      fs.unlinkSync(filePath);
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > 0) {
      const fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
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

/**
 * Stage credential values from a pre-fix plaintext credentials.json into
 * `process.env` (non-destructive). Restricted to `KNOWN_CREDENTIAL_ENV_KEYS`
 * so a stale or tampered file cannot inject unrelated variables (`PATH`,
 * `NODE_OPTIONS`, `OPENSHELL_GATEWAY`, etc.) into later child processes.
 *
 * The file is intentionally NOT removed here. The unlink runs only after
 * onboarding successfully registers the credentials with the OpenShell
 * gateway — see {@link removeLegacyCredentialsFile}.
 *
 * @returns Sorted list of credential keys that were staged, or `[]`.
 */
export function stageLegacyCredentialsToEnv(): string[] {
  const legacyFile = getCredsFile();

  // O_NOFOLLOW only protects the *final* path component. Walk every
  // ancestor between HOME and ~/.nemoclaw and refuse if any of them is
  // a symlink — otherwise a planted directory symlink at ~/.nemoclaw/
  // would redirect the read into an attacker-controlled location even
  // though the credentials.json open itself looks safe. config-io's
  // rejectSymlinksOnPath throws when a planted link is found; treat
  // that the same as "no migratable file" and bail.
  try {
    rejectSymlinksOnPath(path.dirname(legacyFile));
  } catch (error) {
    console.error(
      `  Refusing to migrate legacy credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }

  // Pin the file by descriptor before doing any checks. O_NOFOLLOW makes
  // the open() itself fail when the final path component is a symlink,
  // and fstat/read both target the same inode, so an attacker cannot
  // swap the file between checks (TOCTOU) or redirect us through a
  // symlink planted at the credentials path.
  let fd: number;
  try {
    fd = fs.openSync(legacyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return [];
  }

  let raw: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    if (stat.size > LEGACY_CREDS_FILE_MAX_BYTES) {
      console.error(
        `  Refusing to migrate ${legacyFile}: file is ${String(stat.size)} bytes, ` +
          `exceeding the ${String(LEGACY_CREDS_FILE_MAX_BYTES)}-byte sanity cap. ` +
          `Inspect the file manually and remove it if it does not contain credentials.`,
      );
      return [];
    }
    raw = fs.readFileSync(fd, "utf-8");
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already closed; ignore */
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const allowed = new Set<string>(KNOWN_CREDENTIAL_ENV_KEYS);
  const staged: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== "string") continue;
    const normalized = normalizeCredentialValue(value);
    if (!normalized) continue;
    // Defer to env values that were already set (e.g. by the user) so the
    // file cannot silently override an explicit override. Use getCredential
    // for the existence check so a blank or whitespace-only env entry —
    // which `getCredential` normalizes to null — counts as unset and the
    // legacy value is staged. Track only the keys we actually imported
    // from the file — `staged.length > 0` is the signal callers use to
    // decide it is safe to delete the legacy file.
    if (!getCredential(key)) {
      process.env[key] = normalized;
      staged.push(key);
    }
  }
  return staged.sort();
}

/**
 * Securely remove the legacy plaintext credentials.json. Call this only
 * after the gateway has accepted the migrated values, so an interrupted or
 * failed onboard cannot leave the user with no copy of their credentials.
 *
 * `secureUnlink` is itself missing-file-tolerant and uses `lstatSync`, so
 * we deliberately do NOT pre-check with `existsSync` — that would follow a
 * planted symlink and skip cleanup of a dangling link. Walk the ancestor
 * directories between HOME and ~/.nemoclaw first so a planted directory
 * symlink can't redirect the zero-fill into an unrelated tree.
 */
export function removeLegacyCredentialsFile(): void {
  const legacyFile = getCredsFile();
  try {
    rejectSymlinksOnPath(path.dirname(legacyFile));
  } catch (error) {
    console.error(
      `  Refusing to remove legacy credentials: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  secureUnlink(legacyFile);
}

/**
 * Read a secret value from a TTY without echoing typed characters
 * (asterisks are written instead). Resolves to the trimmed answer or
 * rejects with `code: "SIGINT"` on Ctrl-C.
 */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    // Re-attach stdin to the event loop. cleanup() below unrefs after the
    // read completes (so a wizard ending here exits naturally), and unref()
    // is sticky — without this the next direct promptSecret() call would
    // listen on a detached handle. Idempotent when prompt() already ref'd.
    if (typeof input.ref === "function") {
      input.ref();
    }
    let answer = "";
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      // pause+unref so a wizard ending on a secret prompt exits naturally.
      // The matching ref() in prompt() (and any direct caller) restores the
      // event-loop ref before the next read.
      if (typeof input.pause === "function") {
        input.pause();
      }
      if (typeof input.unref === "function") {
        input.unref();
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

/**
 * Prompt the user on stderr and resolve to their trimmed answer. Pass
 * `{ secret: true }` to mask input on a TTY (falls back to plain readline
 * when stdin/stderr is non-interactive, e.g. in CI).
 */
export function prompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Re-attach stdin to the event loop before any prompt path. unref() in
    // cleanup (below, and in the secret path) is sticky — neither
    // readline.createInterface() nor the secret reader re-ref stdin on
    // their own, so a follow-up prompt of either kind would otherwise see
    // a detached handle and the process could exit before the user answers.
    if (typeof process.stdin.ref === "function") {
      process.stdin.ref();
    }
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
      // pause+unref so the process exits naturally after the last prompt
      // resolves. The matching ref() above keeps subsequent prompts working;
      // unref()-ing a TTY ReadStream only releases the event-loop reference,
      // cooked/raw mode and any subsequent reads remain unaffected.
      if (typeof process.stdin.pause === "function") {
        process.stdin.pause();
      }
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
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

/**
 * Ensure `NVIDIA_API_KEY` is staged for this process. Returns immediately
 * if it is already in env, otherwise prompts interactively (validating
 * the `nvapi-` prefix) and stages the result. Onboarding registers the
 * value with the OpenShell gateway later in the flow.
 */
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

/**
 * Return true if `<owner>/<name>` is a private GitHub repository, using
 * `gh api`. Returns false on any failure (no `gh`, not authenticated,
 * network error) — callers must treat the result as a hint, not a proof.
 */
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

/**
 * Ensure `GITHUB_TOKEN` is staged for this process when a private repo
 * needs it. Tries `gh auth token` first (which returns whatever the
 * GitHub CLI has stored — system keychain when reachable, otherwise a
 * gh-managed file); falls back to a session-only PAT prompt if `gh` is
 * unavailable or not logged in. The token is never persisted to host
 * disk by NemoClaw itself.
 */
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
  console.log("  │  Recommended: run 'gh auth login'. NemoClaw picks up whatever  │");
  console.log("  │  the GitHub CLI stores (system keychain when reachable; a      │");
  console.log("  │  gh-managed file otherwise).                                   │");
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
  console.log("  Token loaded for this session only. Run 'gh auth login' to let");
  console.log("  the GitHub CLI persist it (system keychain when reachable;");
  console.log("  gh-managed file otherwise) so future runs do not prompt.");
  console.log("");
}
