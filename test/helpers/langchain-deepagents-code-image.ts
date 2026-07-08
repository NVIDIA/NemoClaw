// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");

export function readAgentFile(name: string): string {
  return fs.readFileSync(path.join(agentDir, name), "utf8");
}

const MANAGED_MCP_VALIDATOR_INVOCATION = [
  'managed_mcp_config="$(',
  "  /opt/venv/bin/python3 -I -c \\",
  "    'from deepagents_code._nemoclaw_managed import managed_mcp_config_path; print(managed_mcp_config_path() or \"\")'",
  ')"',
].join("\n");

function stubManagedMcpValidator(source: string): string {
  expect(source).not.toContain(MANAGED_MCP_VALIDATOR_INVOCATION);
  return source;
}

export function makeWrapperFixture(
  tempDir: string,
  envFileOverride?: string,
): {
  wrapperPath: string;
  ranMarker: string;
  envFile: string;
  authFile: string;
  codexAuthFile: string;
} {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const ranMarker = path.join(tempDir, "dcode-ran");
  const envFile = envFileOverride ?? path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const fixture = stubManagedMcpValidator(readAgentFile("dcode-wrapper.sh"))
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_AUTH_FILE="/sandbox/.deepagents/.state/auth.json"',
      `readonly DEEPAGENTS_AUTH_FILE="${authFile}"`,
    )
    .replace(
      'readonly DEEPAGENTS_CODEX_AUTH_FILE="/sandbox/.deepagents/.state/chatgpt-auth.json"',
      `readonly DEEPAGENTS_CODEX_AUTH_FILE="${codexAuthFile}"`,
    )
    .replace('/opt/venv/bin/python3 -I - "$auth_file"', 'python3 -I - "$auth_file"')
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `touch "${ranMarker}"; echo dcode-stub-ran; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, ranMarker, envFile, authFile, codexAuthFile };
}

export function makeNetworkSimulatingFixture(tempDir: string): {
  wrapperPath: string;
  networkLog: string;
  envFile: string;
} {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const networkLog = path.join(tempDir, "network.log");
  const envFile = path.join(tempDir, ".env");
  const fixture = stubManagedMcpValidator(readAgentFile("dcode-wrapper.sh"))
    .replace(
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    )
    .replace(
      "exec /opt/venv/bin/python3 -I -m deepagents_code",
      `printf 'NET:OPEN inference.local/v1/chat\\nNET:OPEN pypi.org/simple\\nNET:OPEN api.openai.com/v1\\n' > "${networkLog}"; exit 0; : /opt/venv/bin/python3 -I -m deepagents_code`,
    );
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, fixture, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath, networkLog, envFile };
}

export function runWrapper(
  wrapperPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [wrapperPath, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
}
