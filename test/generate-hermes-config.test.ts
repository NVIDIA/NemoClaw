// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "agents", "hermes", "generate-config.ts");
const CONFIG_MODULE_DIR = path.join(import.meta.dirname, "..", "agents", "hermes", "config");

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
  NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([]),
  NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({}),
  NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({}),
  NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({}),
};

let tmpDir: string;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function runConfigScript(envOverrides: Record<string, string> = {}): {
  config: Record<string, any>;
  envFile: string;
} {
  fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
  const result = runConfigScriptRaw(envOverrides);

  if (result.status !== 0) {
    throw new Error(
      `Script failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const hermesDir = path.join(tmpDir, ".hermes");
  return {
    config: YAML.parse(fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf-8")),
    envFile: fs.readFileSync(path.join(hermesDir, ".env"), "utf-8"),
  };
}

function runConfigScriptRaw(
  envOverrides: Record<string, string> = {},
  opts: { cwd?: string; scriptPath?: string } = {},
) {
  fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", opts.scriptPath || SCRIPT_PATH],
    {
      encoding: "utf-8",
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        ...BASE_ENV,
        ...envOverrides,
        HOME: tmpDir,
      },
      timeout: 10_000,
    },
  );
}

function writeRegistryManifest(
  blueprintDir: string,
  relativeManifestPath: string,
  manifest: Record<string, unknown>,
): string {
  const manifestPath = path.join(blueprintDir, "model-specific-setup", relativeManifestPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return path.join(blueprintDir, "model-specific-setup");
}

function copyConfigGeneratorFixture(fixtureRoot: string): string {
  const fixtureScriptPath = path.join(fixtureRoot, "agents", "hermes", "generate-config.ts");
  const fixtureConfigDir = path.join(fixtureRoot, "agents", "hermes", "config");
  fs.mkdirSync(path.dirname(fixtureScriptPath), { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, fixtureScriptPath);
  fs.cpSync(CONFIG_MODULE_DIR, fixtureConfigDir, { recursive: true });
  return fixtureScriptPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents/hermes/generate-config.ts", () => {
  it("generates API server config without messaging platform token blocks", () => {
    const { config, envFile } = runConfigScript();

    expect(config.model).toMatchObject({
      default: "test-model",
      provider: "custom",
      base_url: "https://inference.local/v1",
    });
    expect(config.platforms).toEqual({
      api_server: {
        enabled: true,
        extra: {
          port: 18642,
          host: "127.0.0.1",
        },
      },
    });
    expect(envFile).toContain("API_SERVER_PORT=18642\n");
    expect(envFile).toContain("API_SERVER_HOST=127.0.0.1\n");
  });

  it("writes Discord settings in Hermes' top-level schema and keeps tokens in .env", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["discord"]),
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({
        discord: ["1005536447329222676"],
      }),
      NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({
        "1491590992753590594": {
          requireMention: true,
          users: ["1005536447329222676"],
        },
      }),
    });

    expect(config.discord).toEqual({
      require_mention: true,
      free_response_channels: "",
      allowed_channels: "",
      auto_thread: true,
      reactions: true,
      channel_prompts: {},
    });
    expect(config.platforms.discord).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("DISCORD_BOT_TOKEN");
    expect(envFile).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n");
    expect(envFile).toContain("DISCORD_ALLOWED_USERS=1005536447329222676\n");
  });

  it("preserves the Discord all-messages reply mode from onboarding", () => {
    const { config } = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["discord"]),
      NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({
        "1491590992753590594": {
          requireMention: false,
        },
      }),
    });

    expect(config.discord.require_mention).toBe(false);
  });

  it("does not emit generic platforms blocks for Telegram or Slack messaging tokens", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram", "slack"]),
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({
        telegram: ["123456789"],
      }),
      NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({ requireMention: true }),
    });

    expect(config.telegram).toEqual({ require_mention: true });
    expect(config.platforms.telegram).toBeUndefined();
    expect(config.platforms.slack).toBeUndefined();
    expect(envFile).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n");
    expect(envFile).toContain("TELEGRAM_ALLOWED_USERS=123456789\n");
    expect(envFile).toContain("SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN\n");
    expect(envFile).toContain("SLACK_APP_TOKEN=openshell:resolve:env:SLACK_APP_TOKEN\n");
  });

  it("omits Telegram behavior config when requireMention is not boolean", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram"]),
      NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({ requireMention: "true" }),
    });

    expect(config.telegram).toBeUndefined();
    expect(config.platforms.telegram).toBeUndefined();
    expect(envFile).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n");
  });

  it("ignores the OpenClaw Kimi model-specific setup for Hermes output", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });

    expect(config.model).toEqual({
      default: "moonshotai/kimi-k2.6",
      provider: "custom",
      base_url: "https://inference.local/v1",
    });
    expect(config.kimi).toBeUndefined();
    expect(config.openclawPlugins).toBeUndefined();
    expect(envFile).toContain("API_SERVER_PORT=18642\n");
  });

  it("discovers and validates Hermes manifests without changing runtime output", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "hermes/fixture.json",
      {
        id: "fixture-hermes",
        agent: "hermes",
        description: "Fixture Hermes setup",
        match: {
          modelIds: ["fixture/hermes-model"],
          providerKey: "custom",
          baseUrl: "https://inference.local/v1",
        },
        effects: {
          hermesCompat: {
            future: true,
          },
        },
      },
    );

    const { config } = runConfigScript({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
      NEMOCLAW_MODEL: "fixture/hermes-model",
      NEMOCLAW_PROVIDER_KEY: "custom",
    });

    expect(config.model.default).toBe("fixture/hermes-model");
    expect(config.hermesCompat).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("future");
  });

  it("discovers the bundled registry from the script path when cwd differs", () => {
    const sourceRegistryDir = path.join(
      import.meta.dirname,
      "..",
      "nemoclaw-blueprint",
      "model-specific-setup",
    );
    const fixtureRoot = path.join(tmpDir, "script-relative-fixture");
    const fixtureScriptPath = copyConfigGeneratorFixture(fixtureRoot);
    const registryDir = path.join(fixtureRoot, "nemoclaw-blueprint", "model-specific-setup");
    const manifestPath = path.join(
      registryDir,
      "hermes",
      `fixture-invalid-${String(process.pid)}-${String(Date.now())}.json`,
    );

    try {
      fs.cpSync(sourceRegistryDir, registryDir, { recursive: true });
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            id: "fixture-invalid-hermes",
            agent: "hermes",
            description: "Invalid Hermes setup",
            match: {
              modelIds: ["fixture/script-relative-hermes-model"],
            },
            effects: {
              openclawCompat: {},
            },
          },
          null,
          2,
        ),
      );

      const result = runConfigScriptRaw(
        {
          NEMOCLAW_MODEL: "fixture/script-relative-hermes-model",
          NEMOCLAW_PROVIDER_KEY: "custom",
        },
        { cwd: tmpDir, scriptPath: fixtureScriptPath },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown effects for agent 'hermes': openclawCompat");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown Hermes model-specific effect keys", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "hermes/bad-effect.json",
      {
        id: "bad-hermes-effect",
        agent: "hermes",
        description: "Invalid Hermes effect",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawCompat: {},
        },
      },
    );

    const result = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown effects for agent 'hermes': openclawCompat");
  });

  it("rejects empty match objects and invalid explicit registry overrides", () => {
    const missingRegistry = path.join(tmpDir, "missing-registry");
    const missingRegistryResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingRegistry,
    });

    expect(missingRegistryResult.status).not.toBe(0);
    expect(missingRegistryResult.stderr).toContain(
      "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory",
    );

    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "hermes/empty-match.json",
      {
        id: "empty-hermes-match",
        agent: "hermes",
        description: "Invalid Hermes match",
        match: {},
        effects: {
          hermesCompat: {},
        },
      },
    );

    const emptyMatchResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(emptyMatchResult.status).not.toBe(0);
    expect(emptyMatchResult.stderr).toContain("field 'match' must be a non-empty object");
  });
});
