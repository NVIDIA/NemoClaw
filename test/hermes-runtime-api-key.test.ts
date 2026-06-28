// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";
import { dockerRunCommandBetween } from "./helpers/hermes-dockerfile-run";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");
const HERMES_DOCKERFILE = path.join(import.meta.dirname, "..", "agents", "hermes", "Dockerfile");
const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);
const SECRET_BOUNDARY_VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
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

function slackBotAlias() {
  return {
    channelId: "slack",
    envKey: "SLACK_BOT_TOKEN",
    match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
    value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    message:
      "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
  };
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

function baseMessagingRuntimePlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sandboxName: "test-sandbox",
    agent: "hermes",
    channels: [{ channelId: "slack", active: true, disabled: false }],
    disabledChannels: [],
    credentialBindings: [{ channelId: "slack", providerEnvKey: "SLACK_BOT_TOKEN" }],
    runtimeSetup: { nodePreloads: [], envAliases: [slackBotAlias()], secretScans: [] },
    ...overrides,
  };
}

function runExtractedProviderPlaceholderRefresh(opts: {
  runtimePlanPathKind: "absent" | "regular" | "brokenSymlink";
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-start-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const runtimePlanPath = path.join(tmpDir, "messaging-runtime-plan.json");
  const missingRuntimePlanPath = path.join(tmpDir, "missing-runtime-plan.json");
  const logPath = path.join(tmpDir, "python-args.log");
  const fakePythonPath = path.join(tmpDir, "fake-python.sh");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(hermesHome, ".env"),
    "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN\n",
  );
  const writeRuntimePlanPath = {
    absent: () => undefined,
    regular: () => fs.writeFileSync(runtimePlanPath, JSON.stringify(baseMessagingRuntimePlan())),
    brokenSymlink: () => fs.symlinkSync(missingRuntimePlanPath, runtimePlanPath),
  } satisfies Record<typeof opts.runtimePlanPathKind, () => void | undefined>;
  writeRuntimePlanPath[opts.runtimePlanPathKind]();

  const functionSource = extractShellFunctionFromSource(
    fs.readFileSync(START_SCRIPT, "utf-8"),
    "refresh_hermes_provider_placeholders",
  ).replaceAll("/usr/local/share/nemoclaw/messaging-runtime-plan.json", runtimePlanPath);

  fs.writeFileSync(
    fakePythonPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$@" >${shellQuote(logPath)}`,
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "validate_hermes_env_secret_boundary() { :; }",
      functionSource,
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(path.join(tmpDir, "hermes.config-hash"))}`,
      `_HERMES_PYTHON=${shellQuote(fakePythonPath)}`,
      `_HERMES_RUNTIME_CONFIG_GUARD=${shellQuote(RUNTIME_CONFIG_GUARD)}`,
      `_HERMES_BOUNDARY_VALIDATOR=${shellQuote(SECRET_BOUNDARY_VALIDATOR)}`,
      "refresh_hermes_provider_placeholders strict",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      args: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").trim().split("\n") : [],
      runtimePlanPath,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDockerfileRuntimePlanGuard(runtimePlan: unknown) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-docker-plan-"));
  const runtimeDir = path.join(tmpDir, "usr", "local", "share", "nemoclaw");
  const runtimePlanPath = path.join(runtimeDir, "messaging-runtime-plan.json");
  const applierPath = path.join(tmpDir, "applier.mts");
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Bake reduced messaging runtime metadata",
    "# Apply messaging agent-install hooks",
  )
    .replace(
      "node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase runtime-setup",
      `node --experimental-strip-types ${shellQuote(applierPath)}`,
    )
    .replaceAll("/usr/local/share/nemoclaw/messaging-runtime-plan.json", runtimePlanPath)
    // Unit fixtures run as the invoking user, not Docker root; keep the
    // executable reduced-shape guard intact while bypassing only image-owner metadata.
    .replace("st.uid !== 0 || st.gid !== 0 || ", "");

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(runtimePlanPath, `${JSON.stringify(runtimePlan, null, 2)}\n`, { mode: 0o644 });
    fs.writeFileSync(applierPath, "// noop runtime-setup fixture\n", { mode: 0o644 });
    return spawnSync("bash", ["-c", command], {
      encoding: "utf-8",
      timeout: 5000,
      cwd: tmpDir,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesRuntimeProviderPlaceholderRefresh(opts: {
  envFile: string;
  envOverrides: Record<string, string>;
  runtimePlan?: unknown;
  runtimePlanPathKind?: "regular" | "symlink" | "hardlink" | "groupWritable" | "worldWritable";
  hashFileContent?: string;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-provider-placeholders-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const hashPath = path.join(tmpDir, "hermes.config-hash");
  const runtimePlanPath = path.join(tmpDir, "messaging-runtime-plan.json");
  const runtimePlanTargetPath = path.join(tmpDir, "messaging-runtime-plan-target.json");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(configPath, "model:\n  default: test-model\n");
  fs.writeFileSync(envPath, opts.envFile, { mode: 0o640 });
  opts.hashFileContent === undefined
    ? writeHermesHash(hashPath, configPath, envPath)
    : fs.writeFileSync(hashPath, opts.hashFileContent);
  const runtimePlanText = `${JSON.stringify(opts.runtimePlan, null, 2)}\n`;
  const writeRuntimePlanPath = {
    regular: () => fs.writeFileSync(runtimePlanPath, runtimePlanText),
    symlink: () => {
      fs.writeFileSync(runtimePlanTargetPath, runtimePlanText);
      fs.symlinkSync(runtimePlanTargetPath, runtimePlanPath);
    },
    hardlink: () => {
      fs.writeFileSync(runtimePlanTargetPath, runtimePlanText);
      fs.linkSync(runtimePlanTargetPath, runtimePlanPath);
    },
    groupWritable: () => {
      fs.writeFileSync(runtimePlanPath, runtimePlanText, { mode: 0o664 });
      fs.chmodSync(runtimePlanPath, 0o664);
    },
    worldWritable: () => {
      fs.writeFileSync(runtimePlanPath, runtimePlanText, { mode: 0o666 });
      fs.chmodSync(runtimePlanPath, 0o666);
    },
  } satisfies Record<NonNullable<typeof opts.runtimePlanPathKind>, () => void>;
  opts.runtimePlan === undefined || writeRuntimePlanPath[opts.runtimePlanPathKind ?? "regular"]();

  try {
    const runtimePlanArgs =
      opts.runtimePlan === undefined ? [] : ["--runtime-plan", runtimePlanPath];
    const args = [
      RUNTIME_CONFIG_GUARD,
      "provider-placeholders",
      "--hermes-dir",
      hermesHome,
      "--hash-file",
      hashPath,
      "--boundary-validator",
      SECRET_BOUNDARY_VALIDATOR,
      "--mode",
      "strict",
      ...runtimePlanArgs,
    ];
    const result = spawnSync("python3", args, {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...opts.envOverrides },
    });
    const envFileContent = fs.readFileSync(envPath, "utf-8");
    const strictHashCheck = spawnSync("sha256sum", ["-c", hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return {
      result,
      envFileContent,
      strictHashContent: fs.readFileSync(hashPath, "utf-8"),
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

  it("deduplicates an existing API_SERVER_KEY while preserving the first generated value", () => {
    const existingKey = "c".repeat(64);
    const duplicateKey = "d".repeat(64);
    const run = runHermesRuntimeApiServerKeyMint({
      envFile: [
        "API_SERVER_PORT=18642",
        `export API_SERVER_KEY=${existingKey}`,
        `API_SERVER_KEY=${duplicateKey}`,
        "API_SERVER_HOST=127.0.0.1",
        "",
      ].join("\n"),
      fakeRoot: true,
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.apiServerKey).toBe(existingKey);
    expect(run.envFileContent).toBe(
      [
        "API_SERVER_PORT=18642",
        `export API_SERVER_KEY=${existingKey}`,
        "API_SERVER_HOST=127.0.0.1",
        "",
      ].join("\n"),
    );
    expect(run.envFileContent).not.toContain(duplicateKey);
    expect(run.strictHashValid).toBe(true);
    expect(run.compatHashValid).toBe(true);
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

  it("does not append missing provider placeholders without a runtime plan", () => {
    const originalEnv = "API_SERVER_PORT=18642\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v222_SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "openshell:resolve:env:v222_SLACK_APP_TOKEN",
        DISCORD_BOT_TOKEN: "openshell:resolve:env:v222_DISCORD_BOT_TOKEN",
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it("does not append raw ambient Slack values without a runtime plan", () => {
    const originalEnv = "API_SERVER_PORT=18642\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "xoxb-raw-slack-token",
        SLACK_APP_TOKEN: "xapp-raw-slack-token",
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.envFileContent).not.toContain("xoxb-raw-slack-token");
    expect(run.envFileContent).not.toContain("xapp-raw-slack-token");
    expect(run.strictHashValid).toBe(true);
  });

  it("does not normalize new-channel ambient placeholders without a runtime plan", () => {
    const originalEnv = "WECOM_BOT_TOKEN=openshell:resolve:env:v1_WECOM_BOT_TOKEN\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        WECOM_BOT_TOKEN: "openshell:resolve:env:v2_WECOM_BOT_TOKEN",
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
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

  it("does not rewrite API_SERVER_KEY or unrelated .env keys from ambient runtime env", () => {
    const apiServerKey = "e".repeat(64);
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: [
        `API_SERVER_KEY=${apiServerKey}`,
        "UNRELATED_VALUE=stable-value",
        "DISCORD_BOT_TOKEN=openshell:resolve:env:v1_DISCORD_BOT_TOKEN",
        "",
      ].join("\n"),
      envOverrides: {
        API_SERVER_KEY: "openshell:resolve:env:API_SERVER_KEY",
        UNRELATED_VALUE: "openshell:resolve:env:UNRELATED_VALUE",
        DISCORD_BOT_TOKEN: "openshell:resolve:env:v222_DISCORD_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "discord", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "discord", providerEnvKey: "DISCORD_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toContain(`API_SERVER_KEY=${apiServerKey}\n`);
    expect(run.envFileContent).toContain("UNRELATED_VALUE=stable-value\n");
    expect(run.envFileContent).toContain(
      "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n",
    );
    expect(run.envFileContent).not.toContain("API_SERVER_KEY=openshell:resolve:env:API_SERVER_KEY");
    expect(run.envFileContent).not.toContain(
      "UNRELATED_VALUE=openshell:resolve:env:UNRELATED_VALUE",
    );
    expect(run.strictHashValid).toBe(true);
  });

  it("appends missing provider placeholders from runtime plan credential bindings", () => {
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1", ""].join("\n"),
      envOverrides: {
        DISCORD_BOT_TOKEN: "openshell:resolve:env:v101_DISCORD_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "discord", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "discord", providerEnvKey: "DISCORD_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(
      [
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
        "",
      ].join("\n"),
    );
    expect(run.envFileContent).not.toContain("openshell:resolve:env:v101_DISCORD_BOT_TOKEN");
    expect(run.strictHashValid).toBe(true);
  });

  it("upserts provider placeholders without duplicates and preserves export prefixes", () => {
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: [
        "export DISCORD_BOT_TOKEN=openshell:resolve:env:v1_DISCORD_BOT_TOKEN",
        "DISCORD_BOT_TOKEN=openshell:resolve:env:v2_DISCORD_BOT_TOKEN",
        "API_SERVER_PORT=18642",
        "",
      ].join("\n"),
      envOverrides: {
        DISCORD_BOT_TOKEN: "openshell:resolve:env:v222_DISCORD_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "discord", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "discord", providerEnvKey: "DISCORD_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(
      [
        "export DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
        "API_SERVER_PORT=18642",
        "",
      ].join("\n"),
    );
    expect(run.strictHashValid).toBe(true);
  });

  it("does not rewrite provider placeholders when .env is already canonical", () => {
    const hashFileContent = "sentinel\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n",
      envOverrides: {
        DISCORD_BOT_TOKEN: "openshell:resolve:env:v101_DISCORD_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "discord", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "discord", providerEnvKey: "DISCORD_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] },
      },
      hashFileContent,
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n");
    expect(run.strictHashContent).toBe(hashFileContent);
  });

  it("uses manifest runtime aliases for Hermes Slack provider placeholders", () => {
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: [
        "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN=openshell:resolve:env:v111_SLACK_APP_TOKEN",
        "",
      ].join("\n"),
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v222_SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "openshell:resolve:env:SLACK_APP_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "slack", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [],
        runtimeSetup: {
          nodePreloads: [],
          envAliases: [
            {
              channelId: "slack",
              envKey: "SLACK_BOT_TOKEN",
              match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
              value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              message:
                "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
            },
            {
              channelId: "slack",
              envKey: "SLACK_APP_TOKEN",
              match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
              value: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
              message:
                "[channels] Normalized SLACK_APP_TOKEN runtime placeholder to the Bolt-compatible alias",
            },
          ],
          secretScans: [],
        },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toContain(
      "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\n",
    );
    expect(run.envFileContent).toContain(
      "SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN\n",
    );
    expect(run.envFileContent).not.toContain("openshell:resolve:env");
    expect(run.result.stderr).toContain("Normalized SLACK_BOT_TOKEN");
    expect(run.result.stderr).toContain("Normalized SLACK_APP_TOKEN");
    expect(run.strictHashValid).toBe(true);
  });

  it("refresh_hermes_provider_placeholders passes --runtime-plan only for regular artifacts", () => {
    const present = runExtractedProviderPlaceholderRefresh({ runtimePlanPathKind: "regular" });
    const absent = runExtractedProviderPlaceholderRefresh({ runtimePlanPathKind: "absent" });
    const brokenSymlink = runExtractedProviderPlaceholderRefresh({
      runtimePlanPathKind: "brokenSymlink",
    });

    expect(present.result.status, present.result.stderr).toBe(0);
    expect(absent.result.status, absent.result.stderr).toBe(0);
    expect(brokenSymlink.result.status, brokenSymlink.result.stderr).toBe(0);
    expect(present.args).toContain("--runtime-plan");
    expect(present.args).toContain(present.runtimePlanPath);
    expect(absent.args).not.toContain("--runtime-plan");
    expect(absent.args).not.toContain(absent.runtimePlanPath);
    expect(brokenSymlink.args).not.toContain("--runtime-plan");
    expect(brokenSymlink.args).not.toContain(brokenSymlink.runtimePlanPath);
  });

  it.each([
    {
      name: "symlinked",
      runtimePlanPathKind: "symlink",
      error: "refusing unsafe Hermes runtime config path",
    },
    {
      name: "hardlinked",
      runtimePlanPathKind: "hardlink",
      error: "refusing hardlinked runtime config path",
    },
    {
      name: "group-writable",
      runtimePlanPathKind: "groupWritable",
      error: "refusing group/world-writable runtime config path",
    },
    {
      name: "world-writable",
      runtimePlanPathKind: "worldWritable",
      error: "refusing group/world-writable runtime config path",
    },
  ] as const)("refuses $name runtime plans before refreshing Hermes provider placeholders", ({
    runtimePlanPathKind,
    error,
  }) => {
    const originalEnv = "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:SLACK_BOT_TOKEN",
      },
      runtimePlanPathKind,
      runtimePlan: baseMessagingRuntimePlan(),
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain(error);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it("Hermes Dockerfile runtime-plan guard accepts reduced artifacts", () => {
    const accepted = runHermesDockerfileRuntimePlanGuard(baseMessagingRuntimePlan());

    expect(accepted.status, accepted.stderr).toBe(0);
  });

  it.each([
    "agentRender",
    "buildSteps",
    "stateUpdates",
    "healthChecks",
  ])("Hermes Dockerfile runtime-plan guard rejects unreduced %s artifacts", (key) => {
    const rejected = runHermesDockerfileRuntimePlanGuard(baseMessagingRuntimePlan({ [key]: [] }));

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(`runtime plan contains unreduced key ${key}`);
  });

  it.each([
    {
      name: "inactive",
      channels: [{ channelId: "slack", active: false, disabled: false }],
      disabledChannels: [],
    },
    {
      name: "disabled",
      channels: [{ channelId: "slack", active: true, disabled: true }],
      disabledChannels: [],
    },
    {
      name: "disabledChannels",
      channels: [{ channelId: "slack", active: true, disabled: false }],
      disabledChannels: ["slack"],
    },
  ])("ignores Slack runtime aliases when Slack is $name", ({ channels, disabledChannels }) => {
    const originalEnv = "SLACK_BOT_TOKEN=openshell:resolve:env:v1_SLACK_BOT_TOKEN\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v222_SLACK_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels,
        disabledChannels,
        credentialBindings: [{ channelId: "slack", providerEnvKey: "SLACK_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [slackBotAlias()], secretScans: [] },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it.each([
    {
      name: "malformed providerEnvKey with newline",
      runtimePlanPatch: {
        credentialBindings: [{ channelId: "slack", providerEnvKey: "BAD\nFORGED=1" }],
      },
      expectedError: "credentialBindings.providerEnvKey is invalid",
    },
    {
      name: "malformed alias envKey with whitespace",
      runtimePlanPatch: {
        runtimeSetup: { envAliases: [{ ...slackBotAlias(), envKey: "BAD KEY" }] },
      },
      expectedError: "runtimeSetup.envAliases.envKey is invalid",
    },
    {
      name: "malformed alias envKey with equals",
      runtimePlanPatch: {
        runtimeSetup: { envAliases: [{ ...slackBotAlias(), envKey: "BAD=KEY" }] },
      },
      expectedError: "runtimeSetup.envAliases.envKey is invalid",
    },
  ])("rejects runtime-plan $name before rewriting .env", ({ runtimePlanPatch, expectedError }) => {
    const originalEnv = "SLACK_BOT_TOKEN=openshell:resolve:env:v1_SLACK_BOT_TOKEN\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v222_SLACK_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "slack", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "slack", providerEnvKey: "SLACK_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases: [slackBotAlias()], secretScans: [] },
        ...runtimePlanPatch,
      },
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain(expectedError);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
  });

  it.each([
    {
      name: "raw secret values",
      envAliases: [{ ...slackBotAlias(), value: "xoxb-raw-secret-token" }],
      expectedError: "would violate the secret boundary",
    },
    {
      name: "control characters in values",
      envAliases: [
        { ...slackBotAlias(), value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\nFORGED=1" },
      ],
      expectedError: "contains unsafe characters",
    },
    {
      name: "control characters in messages",
      envAliases: [{ ...slackBotAlias(), message: "normalized\nFORGED=1" }],
      expectedError: "contains unsafe characters",
    },
    {
      name: "invalid regexes",
      envAliases: [{ ...slackBotAlias(), match: "(" }],
      expectedError: "regex is invalid",
    },
  ])("rejects runtime-plan alias $name before rewriting .env", ({ envAliases, expectedError }) => {
    const originalEnv = "SLACK_BOT_TOKEN=openshell:resolve:env:v1_SLACK_BOT_TOKEN\n";
    const run = runHermesRuntimeProviderPlaceholderRefresh({
      envFile: originalEnv,
      envOverrides: {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v222_SLACK_BOT_TOKEN",
      },
      runtimePlan: {
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "hermes",
        channels: [{ channelId: "slack", active: true, disabled: false }],
        disabledChannels: [],
        credentialBindings: [{ channelId: "slack", providerEnvKey: "SLACK_BOT_TOKEN" }],
        runtimeSetup: { nodePreloads: [], envAliases, secretScans: [] },
      },
    });

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain(expectedError);
    expect(run.envFileContent).toBe(originalEnv);
    expect(run.strictHashValid).toBe(true);
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
