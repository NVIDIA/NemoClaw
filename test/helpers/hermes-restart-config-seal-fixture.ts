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
  return spawnSync(
    "python3",
    [
      RUNTIME_CONFIG_GUARD,
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
    { encoding: "utf-8", input: content, timeout: 5000 },
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
    timeout: 5000,
  });
}

export function runShieldsTransition(fixture: RestartFixture, shieldsMode: "locked" | "mutable") {
  const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
    mode: shieldsMode,
  });
  switch (begun.status) {
    case 0:
      break;
    default:
      return begun;
  }
  const token = shieldsTransactionToken(begun.stdout);
  switch (token) {
    case undefined:
      throw new Error("Expected begin-shields-transition to emit a token");
    default:
      break;
  }
  switch (shieldsMode) {
    case "locked":
      // The production host restores 0755 only after the recursive state guard's
      // independent verification pass. This focused top-guard fixture has no
      // recursive state, so model that successful handoff explicitly.
      fs.chmodSync(fixture.hermesDir, 0o755);
      break;
    case "mutable":
      break;
  }
  const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
    token,
  });
  switch (applied.status) {
    case 0:
      break;
    default:
      return applied;
  }
  return runShieldsTransactionAction(fixture, "finish-shields-transition", {
    token,
  });
}

export function runShieldsTransactionAction(
  fixture: RestartFixture,
  action:
    | "begin-shields-transition"
    | "apply-shields-transition"
    | "finish-shields-transition"
    | "prepare-shields-abort"
    | "abort-shields-transition"
    | "inspect-mutation-owner",
  options: {
    mode?: "locked" | "mutable";
    rollbackMode?: "locked" | "mutable";
    token?: string;
  } = {},
) {
  const args = [
    RUNTIME_CONFIG_GUARD,
    action,
    "--hermes-dir",
    fixture.hermesDir,
    "--state-file",
    fixture.statePath,
  ];
  args.push(
    ...(action === "begin-shields-transition" || action === "finish-shields-transition"
      ? ["--hash-file", fixture.hashPath]
      : []),
    ...(options.mode ? ["--shields-mode", options.mode] : []),
    ...(options.rollbackMode ? ["--rollback-shields-mode", options.rollbackMode] : []),
    ...(options.token ? ["--lock-token", options.token] : []),
  );
  return spawnSync("python3", args, { encoding: "utf-8", timeout: 5000 });
}

export function strictHashIsValid(fixture: RestartFixture): boolean {
  return (
    spawnSync("sha256sum", ["-c", fixture.hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    }).status === 0
  );
}

export function shieldsTransactionToken(output: string): string | undefined {
  return /^lock_token=([0-9a-f]{64}) original_locked=[01]\s*$/.exec(output)?.[1];
}

export function overwriteThroughOldFd(fd: number, originalSize: number, byte: string): void {
  const attackerBytes = Buffer.alloc(originalSize, byte);
  fs.writeSync(fd, attackerBytes, 0, attackerBytes.length, 0);
  fs.fsyncSync(fd);
}
