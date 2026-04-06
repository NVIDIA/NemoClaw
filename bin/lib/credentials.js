// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { execFileSync } = require("child_process");

const UNSAFE_HOME_PATHS = new Set(["/tmp", "/var/tmp", "/dev/shm", "/"]);

function resolveHomeDir() {
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
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
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

let _credsDir = null;
let _credsFile = null;

function getCredsDir() {
  if (!_credsDir) _credsDir = path.join(resolveHomeDir(), ".nemoclaw");
  return _credsDir;
}

function getCredsFile() {
  if (!_credsFile) _credsFile = path.join(getCredsDir(), "credentials.json");
  return _credsFile;
}

function loadCredentials() {
  try {
    const file = getCredsFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    /* ignored */
  }
  return {};
}

function normalizeCredentialValue(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

function saveCredential(key, value) {
  const dir = getCredsDir();
  const file = getCredsFile();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const creds = loadCredentials();
  creds[key] = normalizeCredentialValue(value);
  fs.writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function getCredential(key) {
  if (process.env[key]) return normalizeCredentialValue(process.env[key]);
  const creds = loadCredentials();
  const value = normalizeCredentialValue(creds[key]);
  return value || null;
}

function promptSecret(question) {
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

    function finish(fn, value) {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      fn(value);
    }

    function onData(chunk) {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (ch === "\u0003") {
          finish(reject, Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          return;
        }

        if (ch === "\r" || ch === "\n") {
          finish(resolve, answer.trim());
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
          // Ignore terminal escape/control sequences such as Delete, arrows,
          // Home/End, etc. while leaving the buffered secret untouched.
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

function prompt(question, opts = {}) {
  return new Promise((resolve, reject) => {
    const silent = opts.secret === true && process.stdin.isTTY && process.stderr.isTTY;
    if (silent) {
      promptSecret(question)
        .then(resolve)
        .catch((err) => {
          if (err && err.code === "SIGINT") {
            reject(err);
            process.kill(process.pid, "SIGINT");
            return;
          }
          reject(err);
        });
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let finished = false;
    function finish(fn, value) {
      if (finished) return;
      finished = true;
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") {
          process.stdin.pause();
        }
        if (typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
      }
      fn(value);
    }
    rl.on("SIGINT", () => {
      const err = Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
      finish(reject, err);
      process.kill(process.pid, "SIGINT");
    });
    rl.question(question, (answer) => {
      finish(resolve, answer.trim());
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

  while (true) {
    key = normalizeCredentialValue(await prompt("  NVIDIA API Key: ", { secret: true }));

    if (!key) {
      console.error("  NVIDIA API Key is required.");
      continue;
    }

    if (!key.startsWith("nvapi-")) {
      console.error("  Invalid key. Must start with nvapi-");
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

function isRepoPrivate(repo) {
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

async function ensureGithubToken() {
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

const exports_ = {
  loadCredentials,
  normalizeCredentialValue,
  saveCredential,
  getCredential,
  prompt,
  ensureApiKey,
  ensureGithubToken,
  isRepoPrivate,
};

Object.defineProperty(exports_, "CREDS_DIR", { get: getCredsDir, enumerable: true });
Object.defineProperty(exports_, "CREDS_FILE", { get: getCredsFile, enumerable: true });

module.exports = exports_;
