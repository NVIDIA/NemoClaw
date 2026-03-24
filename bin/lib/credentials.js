// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

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
          answer = answer.slice(0, -1);
          continue;
        }

        if (ch === "\u001b") {
          // Ignore terminal escape/control sequences such as Delete, arrows,
          // Home/End, etc. while leaving the buffered secret untouched.
          const rest = text.slice(i);
          const match = rest.match(/^\u001b(?:\[[0-9;?]*[~A-Za-z]|\][^\u0007]*\u0007|.)/);
          if (match) {
            i += match[0].length - 1;
          }
          continue;
        }

        if (ch >= " ") {
          answer += ch;
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

  key = await prompt("  NVIDIA API Key: ", { secret: true });

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    process.exit(1);
  }

  saveCredential("NVIDIA_API_KEY", key);
  process.env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
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
};
