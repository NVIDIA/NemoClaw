// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  expect(match, `Expected ${name} in agents/hermes/start.sh`).not.toBeNull();
  return `${name}() {${match![1]}\n}`;
}

function writeHermesHash(hashPath: string, configPath: string, envPath: string): void {
  const result = spawnSync("sha256sum", [configPath, envPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  fs.writeFileSync(hashPath, result.stdout, { mode: 0o644 });
}

function parseApiServerKey(envFileContent: string): string | null {
  const match = envFileContent.match(/^(?:export\s+)?API_SERVER_KEY=([0-9a-f]{64})$/m);
  return match?.[1] ?? null;
}

function runHermesRuntimeApiServerKeyMint(
  opts: {
    envFile?: string;
    mode?: "strict" | "compat";
    fakeRoot?: boolean;
    envPathKind?: "regular" | "symlink" | "hardlink";
    configPathKind?: "regular" | "symlink";
  } = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-key-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const configTarget = path.join(tmpDir, "config-target.yaml");
  const envTarget = path.join(tmpDir, "env-target");
  const hashPath = path.join(tmpDir, "hermes.config-hash");
  const compatHashPath = path.join(hermesHome, ".config-hash");
  const scriptPath = path.join(tmpDir, "run.sh");
  const initialEnvFile = opts.envFile ?? "API_SERVER_PORT=18642\nAPI_SERVER_HOST=127.0.0.1\n";

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(configTarget, "model:\n  default: test-model\n");
  const writeConfigPath = {
    regular: () => fs.copyFileSync(configTarget, configPath),
    symlink: () => fs.symlinkSync(configTarget, configPath),
  } satisfies Record<NonNullable<typeof opts.configPathKind>, () => void>;
  writeConfigPath[opts.configPathKind ?? "regular"]();

  const writeEnvPath = {
    regular: () => fs.writeFileSync(envPath, initialEnvFile, { mode: 0o640 }),
    symlink: () => {
      fs.writeFileSync(envTarget, initialEnvFile);
      fs.symlinkSync(envTarget, envPath);
    },
    hardlink: () => {
      fs.writeFileSync(envTarget, initialEnvFile);
      fs.linkSync(envTarget, envPath);
    },
  } satisfies Record<NonNullable<typeof opts.envPathKind>, () => void>;
  writeEnvPath[opts.envPathKind ?? "regular"]();
  writeHermesHash(hashPath, configPath, envPath);
  writeHermesHash(compatHashPath, configPath, envPath);

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      opts.fakeRoot
        ? 'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }'
        : "",
      extractShellFunctionFromSource(src, "refresh_hermes_runtime_config_hashes"),
      extractShellFunctionFromSource(src, "ensure_hermes_runtime_api_server_key"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(hashPath)}`,
      "_HERMES_PYTHON=python3",
      `_HERMES_RUNTIME_CONFIG_GUARD=${shellQuote(RUNTIME_CONFIG_GUARD)}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env NEMOCLAW_TEST_STEPPED_DOWN=1)",
      `ensure_hermes_runtime_api_server_key ${opts.mode ?? "strict"}`,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    const envFileContent = fs.readFileSync(envPath, "utf-8");
    const strictHashCheck = spawnSync("sha256sum", ["-c", hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const compatHashCheck = spawnSync("sha256sum", ["-c", compatHashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return {
      result,
      envFileContent,
      apiServerKey: parseApiServerKey(envFileContent),
      envFileMode: (fs.statSync(envPath).mode & 0o777).toString(8),
      envTargetContent: fs.existsSync(envTarget) ? fs.readFileSync(envTarget, "utf-8") : null,
      configTargetContent: fs.readFileSync(configTarget, "utf-8"),
      strictHashContent: fs.readFileSync(hashPath, "utf-8"),
      compatHashContent: fs.readFileSync(compatHashPath, "utf-8"),
      strictHashValid: strictHashCheck.status === 0,
      compatHashValid: compatHashCheck.status === 0,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesRuntimeProviderPlaceholderRefresh(opts: {
  envFile: string;
  envOverrides: Record<string, string>;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-placeholders-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const hashPath = path.join(tmpDir, "hermes.config-hash");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(configPath, "model:\n  default: test-model\n");
  fs.writeFileSync(envPath, opts.envFile, { mode: 0o640 });
  writeHermesHash(hashPath, configPath, envPath);

  try {
    const result = spawnSync(
      "python3",
      [
        RUNTIME_CONFIG_GUARD,
        "provider-placeholders",
        "--hermes-dir",
        hermesHome,
        "--hash-file",
        hashPath,
        "--mode",
        "strict",
      ],
      {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, ...opts.envOverrides },
      },
    );
    const envFileContent = fs.readFileSync(envPath, "utf-8");
    const strictHashCheck = spawnSync("sha256sum", ["-c", hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return {
      result,
      envFileContent,
      strictHashValid: strictHashCheck.status === 0,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh runtime API server key", () => {
  it("mints API_SERVER_KEY at startup and refreshes Hermes config hashes", () => {
    const run = runHermesRuntimeApiServerKeyMint({ fakeRoot: true });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.apiServerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(run.envFileMode).toBe("640");
    expect(run.strictHashValid).toBe(true);
    expect(run.compatHashValid).toBe(true);
    expect(run.strictHashContent).toContain("/.hermes/.env");
    expect(run.compatHashContent).toContain("/.hermes/.env");
    expect(run.result.stderr).toContain("Minted Hermes API_SERVER_KEY for this sandbox");
    expect(run.result.stderr).not.toContain(run.apiServerKey ?? "missing-key");
  });

  it("does not rotate an existing API_SERVER_KEY on restart", () => {
    const existingKey = "a".repeat(64);
    const run = runHermesRuntimeApiServerKeyMint({
      envFile: [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `API_SERVER_KEY=${existingKey}`,
        "",
      ].join("\n"),
      fakeRoot: true,
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.apiServerKey).toBe(existingKey);
    expect(run.result.stderr).not.toContain("Minted Hermes API_SERVER_KEY");
    expect(run.strictHashValid).toBe(true);
  });

  it("preserves export-prefixed API_SERVER_KEY lines", () => {
    const existingKey = "b".repeat(64);
    const run = runHermesRuntimeApiServerKeyMint({
      envFile: [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        `export API_SERVER_KEY=${existingKey}`,
        "",
      ].join("\n"),
      fakeRoot: true,
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.apiServerKey).toBe(existingKey);
    expect(run.envFileContent).toContain(`export API_SERVER_KEY=${existingKey}`);
    expect(run.result.stderr).not.toContain("Minted Hermes API_SERVER_KEY");
  });

  it("ensure_hermes_runtime_api_server_key rotates malformed existing API_SERVER_KEY values and refreshes hashes", () => {
    for (const { envLine, weakValue } of [
      { envLine: "API_SERVER_KEY=x", weakValue: "x" },
      { envLine: "API_SERVER_KEY=server-key", weakValue: "server-key" },
      { envLine: "export API_SERVER_KEY='server-key'", weakValue: "server-key" },
    ]) {
      const run = runHermesRuntimeApiServerKeyMint({
        envFile: ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1", envLine, ""].join("\n"),
        fakeRoot: true,
      });

      expect(run.result.status, `${envLine}: ${run.result.stderr}`).toBe(0);
      expect(run.apiServerKey, envLine).toMatch(/^[0-9a-f]{64}$/);
      expect(run.apiServerKey, envLine).not.toBe(weakValue);
      expect(run.envFileContent, envLine).not.toContain(envLine);
      expect(run.envFileContent, envLine).not.toContain(weakValue);
      expect(run.strictHashValid, envLine).toBe(true);
      expect(run.compatHashValid, envLine).toBe(true);
      expect(run.result.stderr, envLine).toContain("Minted Hermes API_SERVER_KEY");
    }
  });

  it("normalizes versioned provider placeholders from the runtime env before refreshing .env", () => {
    for (const envFile of [
      "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n",
      "DISCORD_BOT_TOKEN=openshell:resolve:env:v111_DISCORD_BOT_TOKEN\n",
    ]) {
      const run = runHermesRuntimeProviderPlaceholderRefresh({
        envFile,
        envOverrides: {
          DISCORD_BOT_TOKEN: "openshell:resolve:env:v222_DISCORD_BOT_TOKEN",
        },
      });

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.envFileContent).toContain(
        "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n",
      );
      expect(run.envFileContent).not.toContain("v222_DISCORD_BOT_TOKEN");
      expect(run.envFileContent).not.toContain("v111_DISCORD_BOT_TOKEN");
      expect(run.strictHashValid).toBe(true);
    }
  });

  it("generates distinct API_SERVER_KEY values for separate sandbox homes", () => {
    const first = runHermesRuntimeApiServerKeyMint({ fakeRoot: true });
    const second = runHermesRuntimeApiServerKeyMint({ fakeRoot: true });

    expect(first.result.status, first.result.stderr).toBe(0);
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(first.apiServerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(second.apiServerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.apiServerKey).not.toBe(second.apiServerKey);
  });

  it("refuses a symlinked .env without modifying the symlink target", () => {
    const originalEnv = "API_SERVER_PORT=18642\nAPI_SERVER_HOST=127.0.0.1\n";
    const run = runHermesRuntimeApiServerKeyMint({
      envFile: originalEnv,
      envPathKind: "symlink",
      fakeRoot: true,
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("refusing unsafe Hermes runtime config path");
    expect(run.envTargetContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it("refuses a hardlinked .env without modifying the shared inode", () => {
    const originalEnv = "API_SERVER_PORT=18642\nAPI_SERVER_HOST=127.0.0.1\n";
    const run = runHermesRuntimeApiServerKeyMint({
      envFile: originalEnv,
      envPathKind: "hardlink",
      fakeRoot: true,
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("refusing hardlinked runtime config path");
    expect(run.envTargetContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it("refuses a symlinked config path before refreshing trusted hashes", () => {
    const run = runHermesRuntimeApiServerKeyMint({
      configPathKind: "symlink",
      fakeRoot: true,
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain("refusing unsafe Hermes runtime config path");
    expect(run.configTargetContent).toBe("model:\n  default: test-model\n");
    expect(run.strictHashValid).toBe(false);
    expect(run.compatHashValid).toBe(false);
  });
});
