// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Load API keys from ~/.nemoclaw/secrets.env (never from the git repo).
// Values are staged into process.env for the current run only; the OpenShell
// gateway remains the long-lived store after onboard.

import fs from "node:fs";
import path from "node:path";

import { rejectSymlinksOnPath } from "../state/config-io";
import {
  getCredsDir,
  getCredential,
  KNOWN_CREDENTIAL_ENV_KEYS,
  normalizeCredentialValue,
} from "./store";

export const SECRETS_ENV_FILE_NAME = "secrets.env";

const SECRETS_ENV_TEMPLATE = `# NemoClaw local secrets (NOT checked into git)
# Path: ~/.nemoclaw/secrets.env  (chmod 600 — created by: nemoclaw credentials init-secrets)
#
# KEY=value lines work; leading "export " is optional. Lines already set in your shell
# are left unchanged. Restart onboard/rebuild after editing this file.
#
# NVIDIA API key (nvapi-*) — models on https://integrate.api.nvidia.com/v1
NVIDIA_API_KEY=
#
# Inference Hub API key (sk-*) — models on https://inference-api.nvidia.com/v1
#   (chat completions: .../v1/chat/completions)
NVIDIA_INFERENCE_HUB_API_KEY=
#
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=
# TAVILY_API_KEY=
# TELEGRAM_BOT_TOKEN=
`;

let secretsEnvStaged = false;
let lastStagedSecrets: string[] = [];

/** @internal Reset module cache between unit tests. */
export function resetSecretsEnvStagingForTests(): void {
  secretsEnvStaged = false;
  lastStagedSecrets = [];
}

/** Absolute path to the user's local secrets file (~/.nemoclaw/secrets.env). */
export function getSecretsEnvFilePath(): string {
  return path.join(getCredsDir(), SECRETS_ENV_FILE_NAME);
}

/** Parse a single dotenv-style assignment line. */
export function parseSecretsEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  let key = trimmed.slice(0, eq).trim();
  if (key.startsWith("export ")) {
    key = key.slice("export ".length).trim();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/** Parse dotenv file contents into allowlisted credential keys only. */
export function parseSecretsEnvContents(raw: string): Record<string, string> {
  const allowed = new Set<string>(KNOWN_CREDENTIAL_ENV_KEYS);
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseSecretsEnvLine(line);
    if (!parsed || !allowed.has(parsed.key)) continue;
    const normalized = normalizeCredentialValue(parsed.value);
    if (normalized) result[parsed.key] = normalized;
  }
  return result;
}

function assertSecretsEnvPathSafe(secretsFile: string): boolean {
  try {
    rejectSymlinksOnPath(path.dirname(secretsFile));
  } catch (error) {
    console.error(
      `  Refusing to load ${secretsFile}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  return true;
}

/**
 * Stage credential values from ~/.nemoclaw/secrets.env into process.env.
 * Does not override variables already set in the environment.
 *
 * @returns Sorted list of keys staged from the file.
 */
export function stageSecretsEnvFile(): string[] {
  if (secretsEnvStaged) return lastStagedSecrets;
  secretsEnvStaged = true;
  lastStagedSecrets = [];

  const secretsFile = getSecretsEnvFilePath();
  if (!assertSecretsEnvPathSafe(secretsFile)) return lastStagedSecrets;

  let fd: number;
  try {
    fd = fs.openSync(secretsFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return lastStagedSecrets;
  }

  let raw: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return lastStagedSecrets;
    if (stat.size > 256 * 1024) {
      console.error(
        `  Refusing to load ${secretsFile}: file exceeds 256 KiB. Split secrets or trim the file.`,
      );
      return lastStagedSecrets;
    }
    raw = fs.readFileSync(fd, "utf-8");
  } catch {
    return lastStagedSecrets;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  const parsed = parseSecretsEnvContents(raw);
  const staged: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (getCredential(key)) continue;
    process.env[key] = value;
    staged.push(key);
  }
  lastStagedSecrets = staged.sort();
  return lastStagedSecrets;
}

export type InitSecretsEnvFileResult =
  | { ok: true; created: boolean; path: string }
  | { ok: false; message: string };

/**
 * Create ~/.nemoclaw/secrets.env from the template if it does not exist yet.
 */
export function initSecretsEnvFile(): InitSecretsEnvFileResult {
  const dir = getCredsDir();
  const secretsFile = getSecretsEnvFilePath();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!assertSecretsEnvPathSafe(secretsFile)) {
    return { ok: false, message: `Unsafe path for secrets file: ${secretsFile}` };
  }

  try {
    if (fs.existsSync(secretsFile)) {
      return { ok: true, created: false, path: secretsFile };
    }
    fs.writeFileSync(secretsFile, SECRETS_ENV_TEMPLATE, { encoding: "utf-8", mode: 0o600 });
    return { ok: true, created: true, path: secretsFile };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
