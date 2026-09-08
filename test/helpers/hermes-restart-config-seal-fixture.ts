// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";

export const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

const HERMES_GUARD_TIMEOUT_MS = 90_000;

/**
 * Provides the narrow GatewayConfig surface that the host-side guard fixtures need.
 * The production guard imports Hermes' bundled gateway.config module from the image.
 */
function writeGatewayConfigStub(root: string): void {
  const pythonRoot = path.join(root, "python");
  const gatewayDir = path.join(pythonRoot, "gateway");
  fs.mkdirSync(gatewayDir, { recursive: true });
  fs.writeFileSync(path.join(gatewayDir, "__init__.py"), "", { mode: 0o600 });
  fs.writeFileSync(
    path.join(gatewayDir, "config.py"),
    [
      "class GatewayConfig:",
      "    @classmethod",
      "    def from_dict(cls, value):",
      "        if not isinstance(value, dict):",
      "            raise TypeError('Hermes configuration must be a mapping')",
      "        platforms = value.get('platforms')",
      "        if not isinstance(platforms, dict):",
      "            return cls()",
      "        teams = platforms.get('teams')",
      "        if not isinstance(teams, dict):",
      "            return cls()",
      "        home_channel = teams.get('home_channel')",
      "        if isinstance(home_channel, dict) and 'platform' not in home_channel:",
      "            raise KeyError('platform')",
      "        return cls()",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

export function gatewayConfigStubRoot(root: string): string {
  writeGatewayConfigStub(root);
  return path.join(root, "python");
}

export interface RestartFixture {
  root: string;
  sandboxDir: string;
  hermesDir: string;
  configPath: string;
  envPath: string;
  hashPath: string;
  compatHashPath: string;
  statePath: string;
  trustedConfig: string;
  trustedEnv: string;
}

export function mode(pathname: string): number {
  return fs.statSync(pathname).mode & 0o7777;
}

export function readFileSnapshot(pathname: string): Buffer {
  const fd = fs.openSync(pathname, "r");
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readTextFileSnapshot(pathname: string): string {
  return readFileSnapshot(pathname).toString("utf8");
}

export function hashInputs(configPath: string, envPath: string): string {
  const result = spawnSync("sha256sum", [configPath, envPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  const mcpDigest = createHash("sha256").update("{}").digest("hex");
  return `${result.stdout}# nemoclaw-hermes-mcp-state-v1 intended=${mcpDigest} applied=${mcpDigest}\n`;
}

export function createRestartFixture(): RestartFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-restart-seal-"));
  const sandboxDir = path.join(root, "sandbox");
  const hermesDir = path.join(sandboxDir, ".hermes");
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const hashPath = path.join(root, "hermes.config-hash");
  const compatHashPath = path.join(hermesDir, ".config-hash");
  const statePath = path.join(root, "hermes-restart-seal.json");
  const trustedConfig = "model:\n  default: trusted-model\n";
  const trustedEnv = "API_SERVER_PORT=18642\nSAFE_SETTING=trusted\n";

  fs.mkdirSync(hermesDir, { recursive: true });
  fs.chmodSync(sandboxDir, 0o770);
  fs.chmodSync(hermesDir, 0o3770);
  fs.writeFileSync(configPath, trustedConfig, { mode: 0o640 });
  fs.chmodSync(configPath, 0o640);
  fs.writeFileSync(envPath, trustedEnv, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  const hash = hashInputs(configPath, envPath);
  fs.writeFileSync(hashPath, hash, { mode: 0o600 });
  fs.writeFileSync(compatHashPath, hash, { mode: 0o600 });
  writeGatewayConfigStub(root);

  return {
    root,
    sandboxDir,
    hermesDir,
    configPath,
    envPath,
    hashPath,
    compatHashPath,
    statePath,
    trustedConfig,
    trustedEnv,
  };
}

export function allowRestartFixturePeerTraversal(fixture: RestartFixture): () => void {
  const testTempRoot = path.dirname(fixture.root);
  const testTempRootMode = mode(testTempRoot);
  fs.chmodSync(testTempRoot, testTempRootMode | 0o001);
  try {
    fs.chmodSync(fixture.root, mode(fixture.root) | 0o001);
  } catch (error) {
    fs.chmodSync(testTempRoot, testTempRootMode);
    throw error;
  }
  return () => fs.chmodSync(testTempRoot, testTempRootMode);
}

export function runWriteConfig(fixture: RestartFixture, expectedDigest: string, content: string) {
  const wrapper = String.raw`
import sys

source_path = sys.argv[1]
sys.path.insert(0, sys.argv[2])
sys.argv = [source_path, *sys.argv[3:]]
with open(source_path, "rb") as source:
    exec(compile(source.read(), source_path, "exec"), {"__name__": "__main__", "__file__": source_path})
`;
  return spawnSync(
    "python3",
    [
      "-c",
      wrapper,
      RUNTIME_CONFIG_GUARD,
      gatewayConfigStubRoot(fixture.root),
      "write-config",
      "--hermes-dir",
      fixture.hermesDir,
      "--hash-file",
      fixture.hashPath,
      "--state-file",
      fixture.statePath,
      "--expected-config-sha256",
      expectedDigest,
    ],
    {
      encoding: "utf-8",
      input: content,
      timeout: HERMES_GUARD_TIMEOUT_MS,
    },
  );
}

export function writeMutationLock(fixture: RestartFixture, token: string): string {
  const lockPath = path.join(fixture.root, "hermes-config-mutation.lock");
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      token,
      purpose: "seal-restart",
      pid: 999_999_999,
      pid_start_time: "1",
    })}\n`,
    { mode: 0o600 },
  );
  return lockPath;
}

export function runGuard(action: "seal-restart" | "unseal-restart", fixture: RestartFixture) {
  const args = [
    RUNTIME_CONFIG_GUARD,
    action,
    "--hermes-dir",
    fixture.hermesDir,
    "--state-file",
    fixture.statePath,
  ];
  args.push(...(action === "seal-restart" ? ["--hash-file", fixture.hashPath] : []));
  return spawnSync("python3", args, {
    encoding: "utf-8",
    timeout: HERMES_GUARD_TIMEOUT_MS,
  });
}

export function strictHashIsValid(fixture: RestartFixture): boolean {
  return (
    spawnSync("sha256sum", ["-c", fixture.hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    }).status === 0
  );
}

export function overwriteThroughOldFd(fd: number, originalSize: number, byte: string): void {
  const attackerBytes = Buffer.alloc(originalSize, byte);
  fs.writeSync(fd, attackerBytes, 0, attackerBytes.length, 0);
  fs.fsyncSync(fd);
}
