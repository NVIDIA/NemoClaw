// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, type SpawnSyncReturns, spawnSync } from "node:child_process";
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

const DEEPAGENTS_CODE_EXEC = 'exec /opt/venv/bin/python3 -I -m deepagents_code "$@"';

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

export async function runWrapperAsync(
  wrapperPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn("bash", [wrapperPath, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

export function writeMinimalWheel(directory: string): string {
  const wheelPath = path.join(directory, "nemoclaw_hash_contract-1.0-py3-none-any.whl");
  execFileSync(
    "python3",
    [
      "-c",
      `
import sys
import zipfile

wheel_path = sys.argv[1]
dist_info = "nemoclaw_hash_contract-1.0.dist-info"
with zipfile.ZipFile(wheel_path, "w") as wheel:
    wheel.writestr("nemoclaw_hash_contract/__init__.py", "")
    wheel.writestr(
        f"{dist_info}/METADATA",
        "Metadata-Version: 2.1\\nName: nemoclaw-hash-contract\\nVersion: 1.0\\n",
    )
    wheel.writestr(
        f"{dist_info}/WHEEL",
        "Wheel-Version: 1.0\\nGenerator: nemoclaw-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
    )
    wheel.writestr(f"{dist_info}/RECORD", f"{dist_info}/RECORD,,\\n")
`,
      wheelPath,
    ],
    { stdio: "pipe" },
  );
  return wheelPath;
}

export function baseImagePipInstallArgs(dockerfile: string, requirementsPath: string): string[] {
  const logicalDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");
  const copiedLock = logicalDockerfile.match(
    /COPY\s+agents\/langchain-deepagents-code\/requirements\.lock\s+(\S+)/,
  );
  expect(copiedLock, "base image must copy the reviewed lockfile").not.toBeNull();
  const invocation = logicalDockerfile.match(/"\$VIRTUAL_ENV\/bin\/pip3" install\s+([^\n]+?)\s+&&/);
  expect(
    invocation,
    "base image must install the reviewed lockfile with the managed venv",
  ).not.toBeNull();
  const args = (invocation?.[1] ?? "").trim().split(/\s+/);
  const requirementsFlag = args.indexOf("-r");
  expect(
    requirementsFlag,
    "base image pip install must consume a requirements file",
  ).toBeGreaterThanOrEqual(0);
  expect(args[requirementsFlag + 1]).toBe(copiedLock?.[1]);
  return [...args.slice(0, requirementsFlag), "-r", requirementsPath];
}

export function assertEveryRequirementIsHashLocked(requirementsLock: string): void {
  const lines = requirementsLock.split(/\r?\n/);
  const requirementStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.length > 0 && !/^\s|#/.test(line));
  expect(requirementStarts.length).toBeGreaterThan(0);

  for (const [position, requirement] of requirementStarts.entries()) {
    expect(
      requirement.line,
      `lock entry on line ${requirement.index + 1} must be exactly pinned`,
    ).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]]+\])?==[^\s\\]+\s+\\$/);
    const nextIndex = requirementStarts[position + 1]?.index ?? lines.length;
    const block = lines.slice(requirement.index, nextIndex).join("\n");
    const hashTokens = block.match(/--hash=[^\s\\]+/g) ?? [];
    expect(hashTokens.length, requirement.line).toBeGreaterThan(0);
    expect(hashTokens.every((token) => /^--hash=sha256:[a-f0-9]{64}$/.test(token))).toBe(true);
  }
}
