// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CURL_AUTH_CONFIG_PREFIX = "nemoclaw-curl-auth";
const CURL_AUTH_CONFIG_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;

function resolveCurlAuthConfigPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return CURL_AUTH_CONFIG_PREFIX;
  if (!CURL_AUTH_CONFIG_NAME_PATTERN.test(prefix)) {
    throw new Error(`invalid curl auth config prefix: ${prefix}`);
  }
  return prefix;
}

export type CurlAuthConfigEntry =
  | { kind: "header"; value: string }
  | { kind: "url-query"; name: string; value: string };

export interface CurlAuthConfig {
  args: readonly string[];
  trustedConfigFiles: readonly string[];
  cleanup(): void;
}

const EMPTY_CURL_AUTH_CONFIG: CurlAuthConfig = {
  args: [],
  trustedConfigFiles: [],
  cleanup() {
    /* no-op */
  },
};

function quoteCurlConfigValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

function formatCurlConfigEntry(entry: CurlAuthConfigEntry): string {
  if (entry.kind === "header") {
    return `header = "${quoteCurlConfigValue(entry.value)}"`;
  }
  return `url-query = "${quoteCurlConfigValue(`${entry.name}=${entry.value}`)}"`;
}

function isInsideOwnTempDir(configPath: string, prefix: string): boolean {
  const dir = path.dirname(configPath);
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(dir);
  const relativeParent = path.relative(tempRoot, parentDir);
  const inside =
    relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent);
  return inside && path.basename(parentDir).startsWith(`${prefix}-`);
}

export interface CreateCurlAuthConfigOptions {
  /**
   * Filename prefix for the per-call tmpfile directory. Defaults to
   * `nemoclaw-curl-auth`. Callers that want their tmpfile to be
   * recognizable in `ps`/`/proc` (e.g. the Kimi health probe) can supply a
   * narrower prefix; the cleanup contract still enforces it.
   */
  prefix?: string;
}

export function createCurlAuthConfig(
  entries: readonly CurlAuthConfigEntry[],
  options: CreateCurlAuthConfigOptions = {},
): CurlAuthConfig {
  if (entries.length === 0) return EMPTY_CURL_AUTH_CONFIG;
  const prefix = resolveCurlAuthConfigPrefix(options.prefix);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  let succeeded = false;
  try {
    fs.chmodSync(dir, 0o700);
    const configPath = path.join(dir, "auth.conf");
    const body = `${entries.map(formatCurlConfigEntry).join("\n")}\n`;
    fs.writeFileSync(configPath, body, { mode: 0o600, encoding: "utf8" });
    const config: CurlAuthConfig = {
      args: ["--config", configPath],
      trustedConfigFiles: [configPath],
      cleanup() {
        if (isInsideOwnTempDir(configPath, prefix)) {
          fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
        }
      },
    };
    succeeded = true;
    return config;
  } finally {
    if (!succeeded) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function createBearerAuthConfig(
  token: string,
  options: CreateCurlAuthConfigOptions = {},
): CurlAuthConfig {
  if (!token) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig(
    [{ kind: "header", value: `Authorization: Bearer ${token}` }],
    options,
  );
}

export function createXApiKeyAuthConfig(
  token: string,
  options: CreateCurlAuthConfigOptions = {},
): CurlAuthConfig {
  if (!token) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig([{ kind: "header", value: `x-api-key: ${token}` }], options);
}

export function createQueryParamAuthConfig(
  name: string,
  value: string,
  options: CreateCurlAuthConfigOptions = {},
): CurlAuthConfig {
  if (!value) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig([{ kind: "url-query", name, value }], options);
}

export type OpenAiLikeAuthMode = "bearer" | "query-param";

export function createOpenAiLikeAuthConfig(
  apiKey: string,
  authMode?: OpenAiLikeAuthMode,
  options: CreateCurlAuthConfigOptions = {},
): CurlAuthConfig {
  if (!apiKey) return EMPTY_CURL_AUTH_CONFIG;
  if (authMode === "query-param") {
    return createQueryParamAuthConfig("key", apiKey, options);
  }
  return createBearerAuthConfig(apiKey, options);
}
