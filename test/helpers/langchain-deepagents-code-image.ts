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

const DEEPAGENTS_CODE_EXEC = "exec /opt/venv/bin/python3 -I -m deepagents_code";

function stubManagedMcpValidator(source: string): string {
  expect(source).not.toContain(MANAGED_MCP_VALIDATOR_INVOCATION);
  return source;
}

function mustReplaceOnce(
  source: string,
  replacements: readonly (readonly [search: string, replacement: string])[],
): string {
  return replacements.reduce((current, [search, replacement]) => {
    if (current.split(search).length !== 2) {
      throw new Error(`fixture drift: expected exactly one ${JSON.stringify(search)}`);
    }
    return current.replace(search, replacement);
  }, source);
}

function materializeWrapperFixture(
  tempDir: string,
  envFile: string,
  transform: (source: string) => string,
): string {
  const wrapperPath = path.join(tempDir, "dcode-wrapper.sh");
  const source = mustReplaceOnce(stubManagedMcpValidator(readAgentFile("dcode-wrapper.sh")), [
    [
      'readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"',
      `readonly DEEPAGENTS_ENV_FILE="${envFile}"`,
    ],
  ]);
  fs.writeFileSync(envFile, "", "utf8");
  fs.writeFileSync(wrapperPath, transform(source), "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
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
  const ranMarker = path.join(tempDir, "dcode-ran");
  const envFile = envFileOverride ?? path.join(tempDir, ".env");
  const authFile = path.join(tempDir, "auth.json");
  const codexAuthFile = path.join(tempDir, "chatgpt-auth.json");
  const wrapperPath = materializeWrapperFixture(tempDir, envFile, (source) =>
    mustReplaceOnce(source, [
      [
        'readonly DEEPAGENTS_AUTH_FILE="/sandbox/.deepagents/.state/auth.json"',
        `readonly DEEPAGENTS_AUTH_FILE="${authFile}"`,
      ],
      [
        'readonly DEEPAGENTS_CODEX_AUTH_FILE="/sandbox/.deepagents/.state/chatgpt-auth.json"',
        `readonly DEEPAGENTS_CODEX_AUTH_FILE="${codexAuthFile}"`,
      ],
      ['/opt/venv/bin/python3 -I - "$auth_file"', 'python3 -I - "$auth_file"'],
      [
        DEEPAGENTS_CODE_EXEC,
        `touch "${ranMarker}"; echo dcode-stub-ran; exit 0; : ${DEEPAGENTS_CODE_EXEC}`,
      ],
    ]),
  );
  return { wrapperPath, ranMarker, envFile, authFile, codexAuthFile };
}

export function makeNetworkSimulatingFixture(tempDir: string): {
  wrapperPath: string;
  networkLog: string;
  envFile: string;
} {
  const networkLog = path.join(tempDir, "network.log");
  const envFile = path.join(tempDir, ".env");
  const wrapperPath = materializeWrapperFixture(tempDir, envFile, (source) =>
    mustReplaceOnce(source, [
      [
        DEEPAGENTS_CODE_EXEC,
        `printf 'NET:OPEN inference.local/v1/chat\\nNET:OPEN pypi.org/simple\\nNET:OPEN api.openai.com/v1\\n' > "${networkLog}"; exit 0; : ${DEEPAGENTS_CODE_EXEC}`,
      ],
    ]),
  );
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
