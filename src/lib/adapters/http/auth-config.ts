// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CURL_AUTH_CONFIG_PREFIX = "nemoclaw-curl-auth";

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

function isInsideOwnTempDir(configPath: string): boolean {
  const dir = path.dirname(configPath);
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(dir);
  const relativeParent = path.relative(tempRoot, parentDir);
  const inside =
    relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent);
  return inside && path.basename(parentDir).startsWith(`${CURL_AUTH_CONFIG_PREFIX}-`);
}

export function createCurlAuthConfig(entries: readonly CurlAuthConfigEntry[]): CurlAuthConfig {
  if (entries.length === 0) return EMPTY_CURL_AUTH_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${CURL_AUTH_CONFIG_PREFIX}-`));
  try {
    fs.chmodSync(dir, 0o700);
    const configPath = path.join(dir, "auth.conf");
    const body = `${entries.map(formatCurlConfigEntry).join("\n")}\n`;
    fs.writeFileSync(configPath, body, { mode: 0o600, encoding: "utf8" });
    return {
      args: ["--config", configPath],
      trustedConfigFiles: [configPath],
      cleanup() {
        if (isInsideOwnTempDir(configPath)) {
          fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function createBearerAuthConfig(token: string): CurlAuthConfig {
  if (!token) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig([{ kind: "header", value: `Authorization: Bearer ${token}` }]);
}

export function createXApiKeyAuthConfig(token: string): CurlAuthConfig {
  if (!token) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig([{ kind: "header", value: `x-api-key: ${token}` }]);
}

export function createQueryParamAuthConfig(name: string, value: string): CurlAuthConfig {
  if (!value) return EMPTY_CURL_AUTH_CONFIG;
  return createCurlAuthConfig([{ kind: "url-query", name, value }]);
}
