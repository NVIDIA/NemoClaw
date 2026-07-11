// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { generateHermesConfig } from "../agents/hermes/config/generate.ts";
import { discoverModelSpecificSetups } from "../agents/hermes/config/model-specific-setup.ts";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../src/lib/hermes-proxy-api-key";
import {
  applyCompatibleEndpointContextWindow,
  resetCompatibleEndpointContextWindowAutoState,
} from "../src/lib/inference/compatible-endpoint-context";
import {
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { testTimeout } from "./helpers/timeouts";
import {
  withLegacyMessagingPlanEnv,
  withLegacyMessagingPlanEnvDirect,
} from "./messaging-plan-test-helper";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "agents", "hermes", "generate-config.ts");
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const CONFIG_MODULE_DIR = path.join(import.meta.dirname, "..", "agents", "hermes", "config");

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
  NEMOCLAW_WEB_SEARCH_ENABLED: "0",
  NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
  NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([]),
  NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({}),
  NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({}),
  NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({}),
  NEMOCLAW_WECHAT_CONFIG_B64: encodeJson({}),
};

const HERMES_STRUCTURED_TOOL_SEARCH = {
  enabled: "on",
  search_default_limit: 5,
  max_search_limit: 20,
};

const REMOTE_PLATFORM_TOOLSETS = [
  "web",
  "browser",
  "terminal",
  "file",
  "code_execution",
  "vision",
  "image_gen",
  "skills",
  "todo",
  "memory",
  "session_search",
  "delegation",
  "cronjob",
  "nemoclaw",
  "audio",
];

let tmpDir: string;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function buildHermesTestEnv(envOverrides: Record<string, string> = {}): Record<string, string> {
  return withLegacyMessagingPlanEnv(buildHermesTestEnvBase(envOverrides), "hermes");
}

function buildHermesTestEnvBase(envOverrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    ...BASE_ENV,
    ...envOverrides,
    HOME: tmpDir,
  };
}

function buildHermesTestEnvDirect(
  envOverrides: Record<string, string> = {},
): Promise<Record<string, string>> {
  return withLegacyMessagingPlanEnvDirect(buildHermesTestEnvBase(envOverrides), "hermes");
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

function readGeneratedConfig(): { config: Record<string, any>; envFile: string } {
  const hermesDir = path.join(tmpDir, ".hermes");
  return {
    config: YAML.parse(fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf-8")),
    envFile: fs.readFileSync(path.join(hermesDir, ".env"), "utf-8"),
  };
}

function generateBaseConfig(envOverrides: Record<string, string> = {}): {
  config: Record<string, any>;
  envFile: string;
} {
  fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
  const env = buildHermesTestEnv(envOverrides);
  withEnv(env, () =>
    generateHermesConfig({
      env,
      scriptDir: SCRIPT_DIR,
      homeDir: tmpDir,
      log: () => {},
    }),
  );
  return readGeneratedConfig();
}

function runConfigScript(envOverrides: Record<string, string> = {}): {
  config: Record<string, any>;
  envFile: string;
} {
  return generateConfigWithMessaging(buildHermesTestEnv(envOverrides));
}

async function runConfigScriptWithMessaging(
  envOverrides: Record<string, string> = {},
): Promise<{ config: Record<string, any>; envFile: string }> {
  return generateConfigWithMessaging(await buildHermesTestEnvDirect(envOverrides));
}

function generateConfigWithMessaging(env: Record<string, string>): {
  config: Record<string, any>;
  envFile: string;
} {
  fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
  withEnv(env, () => {
    generateHermesConfig({
      env,
      scriptDir: SCRIPT_DIR,
      homeDir: tmpDir,
      log: () => {},
    });
    applyMessagingBuildPhase(
      readMessagingBuildPlanFromEnv(env, "hermes"),
      "post-agent-install",
      env,
    );
  });
  return readGeneratedConfig();
}

function runConfigScriptRaw(
  envOverrides: Record<string, string> = {},
  opts: { cwd?: string; scriptPath?: string } = {},
) {
  fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
  const env = buildHermesTestEnv(envOverrides);
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", opts.scriptPath || SCRIPT_PATH],
    {
      encoding: "utf-8",
      cwd: opts.cwd,
      env,
      timeout: 10_000,
    },
  );
}

function expectGenerationError(
  envOverrides: Record<string, string>,
  message: string | RegExp,
): void {
  expect(() => generateBaseConfig(envOverrides)).toThrow(message);
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

function writeManagedToolGatewayMatrixFixture(
  filename: string,
  provider: string,
  envValue: string,
): string {
  const matrixPath = path.join(tmpDir, filename);
  fs.writeFileSync(
    matrixPath,
    JSON.stringify({
      "nous-audio": {
        service: provider,
        config: {
          tts: { provider, use_gateway: true },
          stt: { provider, use_gateway: true },
        },
        envKey: "FIXTURE_AUDIO_GATEWAY_URL",
        envValue,
      },
    }),
  );
  return matrixPath;
}

function copyConfigGeneratorFixture(fixtureRoot: string): string {
  const fixtureScriptPath = path.join(fixtureRoot, "agents", "hermes", "generate-config.ts");
  const fixtureConfigDir = path.join(fixtureRoot, "agents", "hermes", "config");
  fs.mkdirSync(path.dirname(fixtureScriptPath), { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, fixtureScriptPath);
  fs.cpSync(CONFIG_MODULE_DIR, fixtureConfigDir, { recursive: true });
  fs.cpSync(
    path.join(import.meta.dirname, "..", "src", "lib", "messaging"),
    path.join(fixtureRoot, "src", "lib", "messaging"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "src", "lib", "tool-disclosure.ts"),
    path.join(fixtureRoot, "src", "lib", "tool-disclosure.ts"),
  );
  return fixtureScriptPath;
}

function expectRemotePlatformToolsets(toolsets: unknown, extraToolsets: string[] = []): void {
  expect(Array.isArray(toolsets)).toBe(true);
  expect(toolsets).toEqual([...REMOTE_PLATFORM_TOOLSETS, ...extraToolsets]);
  expect(toolsets).not.toContain("no_mcp");
}

function findRawSecretEnvEntries(envFile: string): string[] {
  const secretKey = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API)(_|$)/;
  const slackAlias = /^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-[A-Z0-9_]+$/;
  const allowedNonsecretKeys = new Set(["API_SERVER_HOST", "API_SERVER_PORT"]);
  // Mirror ENV_FILE_ALLOWED_RAW_SECRET_KEYS in
  // agents/hermes/validate-hermes-env-secret-boundary.py. API_SERVER_KEY is the bearer
  // token Hermes' own api_server (v0.16.0+) requires; it is minted at sandbox
  // startup and never travels through the OpenShell proxy, so it has no resolver
  // placeholder and is allowed to be raw.
  const allowedRawSecretKeys = new Set(["API_SERVER_KEY"]);
  const allowedLiterals = new Set(["", "[STRIPPED_BY_MIGRATION]"]);
  const violations: string[] = [];

  for (const [index, rawLine] of envFile.split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const [rawKey, ...valueParts] = line.split("=");
    const key = rawKey.trim();
    if (allowedNonsecretKeys.has(key) || allowedRawSecretKeys.has(key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !secretKey.test(key)) continue;
    let value = valueParts.join("=").trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === "'" || value[0] === '"')
    ) {
      value = value.slice(1, -1);
    }
    if (
      allowedLiterals.has(value) ||
      value.startsWith("openshell:resolve:env:") ||
      slackAlias.test(value)
    ) {
      continue;
    }
    violations.push(`${key} line ${index + 1}`);
  }

  return violations;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-test-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents/hermes/generate-config.ts", () => {
  it(
    "matches direct generation as a strip-types executable with an explicit gateway matrix",
    async () => {
      const matrixPath = writeManagedToolGatewayMatrixFixture(
        "managed-tool-gateway-matrix.json",
        "fixture-audio",
        "https://matrix.example.test/audio",
      );
      const decoyMatrixPath = writeManagedToolGatewayMatrixFixture(
        "decoy-managed-tool-gateway-matrix.json",
        "decoy-audio",
        "https://decoy.example.test/audio",
      );
      vi.stubEnv("NEMOCLAW_HERMES_TOOL_GATEWAY_MATRIX_PATH", decoyMatrixPath);
      const env = await buildHermesTestEnvDirect({
        NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram"]),
      });
      const overrides = {
        NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram"]),
        NEMOCLAW_MESSAGING_PLAN_B64: env.NEMOCLAW_MESSAGING_PLAN_B64,
        NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
        NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson(["nous-audio"]),
        NEMOCLAW_HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
      };
      const directEnv = buildHermesTestEnv(overrides);
      fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
      generateHermesConfig({
        env: directEnv,
        scriptDir: SCRIPT_DIR,
        homeDir: tmpDir,
        log: () => {},
      });
      const direct = readGeneratedConfig();
      fs.rmSync(path.join(tmpDir, ".hermes"), { recursive: true, force: true });

      const result = runConfigScriptRaw(overrides);
      expect(result.status, result.stderr).toBe(0);
      const { config, envFile } = readGeneratedConfig();
      expect(config).toEqual(direct.config);
      expect(envFile).toBe(direct.envFile);
      expect(config.tts).toEqual({ provider: "fixture-audio", use_gateway: true });
      expect(envFile).toContain("FIXTURE_AUDIO_GATEWAY_URL=https://matrix.example.test/audio\n");
      expect(config.platforms.telegram).toBeUndefined();
      expect(envFile).not.toContain("TELEGRAM_BOT_TOKEN=");
    },
    testTimeout(15_000),
  );

  it("emits the pinned Hermes native structured Tool Search contract", () => {
    const { config } = runConfigScript();
    const configYaml = fs.readFileSync(path.join(tmpDir, ".hermes", "config.yaml"), "utf-8");

    expect(config.tools?.tool_search).toEqual(HERMES_STRUCTURED_TOOL_SEARCH);
    expect(config.tools?.toolSearch).toBeUndefined();
    expect(config.tools?.tool_search?.mode).toBeUndefined();
    expect(configYaml).toContain(
      [
        "tools:",
        "  tool_search:",
        "    enabled: on",
        "    search_default_limit: 5",
        "    max_search_limit: 20",
      ].join("\n"),
    );
    expect(configYaml).not.toContain("toolSearch:");
    expect(configYaml).not.toContain("mode: tools");
    expect(configYaml).not.toContain("searchDefaultLimit:");
    expect(configYaml).not.toContain("maxSearchLimit:");
  });

  it("restores direct tool exposure through the agent-neutral override", () => {
    const { config } = runConfigScript({ NEMOCLAW_TOOL_DISCLOSURE: "direct" });
    expect(config.tools?.tool_search).toEqual({
      ...HERMES_STRUCTURED_TOOL_SEARCH,
      enabled: "off",
    });
  });

  it("rejects unknown tool-disclosure modes", () => {
    expectGenerationError(
      { NEMOCLAW_TOOL_DISCLOSURE: "sometimes" },
      "NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct",
    );
  });

  it("generates API server config without messaging platform token blocks", () => {
    const { config, envFile } = runConfigScript();

    expect(config._config_version).toBe(32);
    expect(config.agent?.verify_on_stop).toBe(false);
    expect(config.display).toMatchObject({
      compact: false,
      tool_progress: "all",
      interim_assistant_messages: true,
    });
    expect(config.tools?.tool_search).toEqual(HERMES_STRUCTURED_TOOL_SEARCH);
    expect(config.curator).toMatchObject({
      enabled: true,
      interval_hours: 168,
      min_idle_hours: 2,
      stale_after_days: 30,
      archive_after_days: 90,
      consolidate: false,
      prune_builtins: true,
      backup: {
        enabled: true,
        keep: 5,
      },
    });
    expect(config.auxiliary?.curator).toEqual({
      provider: "auto",
      model: "",
      base_url: "",
      api_key: "",
      timeout: 600,
      extra_body: {},
    });
    expect(config.model).toMatchObject({
      default: "test-model",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
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
    expect(envFile).not.toContain("API_SERVER_KEY=");
  });

  it("configures Hermes' native Tavily backend with an egress-resolved credential", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
    });

    expect(config.web).toEqual({ backend: "tavily" });
    expect(envFile).toContain("TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY\n");
    expect(findRawSecretEnvEntries(envFile)).toEqual([]);
  });

  it("does not configure Tavily when web search is disabled", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_WEB_SEARCH_ENABLED: "0",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
    });

    expect(config.web).toBeUndefined();
    expect(envFile).not.toContain("TAVILY_API_KEY=");
  });

  it("fails fast for unsupported web-search provider values", () => {
    expectGenerationError(
      {
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "search.example.com",
      },
      'Hermes NEMOCLAW_WEB_SEARCH_PROVIDER must be "tavily"',
    );
  });

  it("fails closed when Brave is requested for Hermes", () => {
    expectGenerationError(
      {
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
      },
      'Hermes NEMOCLAW_WEB_SEARCH_PROVIDER must be "tavily"',
    );
  });

  it("records the upstream provider and model as a self-describing annotation", () => {
    const { config } = runConfigScript({
      NEMOCLAW_PROVIDER_KEY: "nvidia-prod",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
    });

    expect(config._nemoclaw_upstream).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it("exposes the managed endpoint to Hermes v16 providers and legacy custom_providers", () => {
    const { config } = runConfigScript({
      NEMOCLAW_PROVIDER_KEY: "nvidia-prod",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
    });

    // The inline `model:` block must stay on Hermes' custom provider while
    // the picker metadata preserves the upstream OpenShell route name.
    expect(config.model.provider).toBe("custom");
    expect(config.providers).toEqual({
      "nvidia-prod": {
        name: "nvidia-prod",
        api: "https://inference.local/v1",
        api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
        default_model: "nvidia/nemotron-3-super-120b-a12b",
        discover_models: true,
      },
    });
    expect(config.custom_providers).toEqual([
      {
        name: "nvidia-prod",
        base_url: "https://inference.local/v1",
        api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
        discover_models: true,
      },
    ]);
  });

  it("bakes NEMOCLAW_CONTEXT_WINDOW as model.context_length so Hermes cannot downgrade it (#6177)", () => {
    const { config } = runConfigScript({
      NEMOCLAW_MODEL: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
      NEMOCLAW_CONTEXT_WINDOW: "65536",
    });

    expect(config.model.context_length).toBe(65536);
    // context_window is silently ignored by Hermes; we must not emit it.
    expect(config.model.context_window).toBeUndefined();
  });

  it("chains the endpoint probe through to model.context_length in the generated config (#6177)", async () => {
    // Source-level regression across the boundary: the same probe onboarding
    // calls resolves a compatible endpoint's max_model_len into
    // NEMOCLAW_CONTEXT_WINDOW, and the real generator must bake it as
    // model.context_length (never context_window). Uses an injected fetcher so
    // no network is required.
    resetCompatibleEndpointContextWindowAutoState();
    const model = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4";
    fs.mkdirSync(path.join(tmpDir, ".hermes"), { recursive: true });
    const env = buildHermesTestEnv({ NEMOCLAW_MODEL: model });
    await applyCompatibleEndpointContextWindow("https://endpoint.example/v1", model, {
      env,
      fetchModels: () => ({ data: [{ id: model, max_model_len: 65_536 }] }),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    withEnv(env, () =>
      generateHermesConfig({ env, scriptDir: SCRIPT_DIR, homeDir: tmpDir, log: () => {} }),
    );
    const { config } = readGeneratedConfig();
    expect(config.model.context_length).toBe(65536);
    expect(config.model.context_window).toBeUndefined();
    resetCompatibleEndpointContextWindowAutoState();
  });

  it("omits context_length when no context window is configured so Hermes auto-detects (#6177)", () => {
    const { config } = runConfigScript();

    expect(config.model.context_length).toBeUndefined();
  });

  it("ignores a malformed NEMOCLAW_CONTEXT_WINDOW and lets Hermes auto-detect (#6177)", () => {
    const { config } = runConfigScript({ NEMOCLAW_CONTEXT_WINDOW: "not-a-number" });

    expect(config.model.context_length).toBeUndefined();
  });

  it("falls back to a stable picker provider name when no upstream is named", () => {
    const { config } = runConfigScript();

    // upstreamProvider defaults to "custom"; the picker entry stays well-formed.
    expect(config.custom_providers[0]).toMatchObject({
      base_url: "https://inference.local/v1",
      discover_models: true,
    });
    expect(typeof config.custom_providers[0].name).toBe("string");
    expect(config.custom_providers[0].name.length).toBeGreaterThan(0);
  });

  it("mirrors the inference api_mode onto the picker provider for non-default routing", () => {
    const { config } = runConfigScript({
      NEMOCLAW_INFERENCE_API: "anthropic-messages",
    });

    expect(config.custom_providers[0]).toMatchObject({
      api_mode: "anthropic_messages",
      discover_models: true,
    });
  });

  it("prepends a grep-friendly YAML comment header naming the upstream route", () => {
    runConfigScript({
      NEMOCLAW_PROVIDER_KEY: "nvidia-prod",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
    });
    const raw = fs.readFileSync(path.join(tmpDir, ".hermes", "config.yaml"), "utf-8");

    expect(raw.startsWith("# Managed by NemoClaw")).toBe(true);
    expect(raw).toContain("# Upstream provider: nvidia-prod\n");
    expect(raw).toContain("# Upstream model: nvidia/nemotron-3-super-120b-a12b\n");
    const filtered = raw
      .split("\n")
      .filter((line) => /provider|model|api_mode/.test(line))
      .join("\n");
    expect(filtered).toContain("nvidia-prod");
    expect(filtered).toContain("nvidia/nemotron-3-super-120b-a12b");
  });

  it("flags bare API-named .env secrets while allowing API server config", () => {
    const rawSecret = "SENTINEL_RAW_SECRET_VALUE";

    expect(
      findRawSecretEnvEntries(
        [
          "API_SERVER_PORT=18642",
          "API_SERVER_HOST=127.0.0.1",
          `INTERNAL_API=${rawSecret}`,
          "SERVICE_API=openshell:resolve:env:SERVICE_API",
          "",
        ].join("\n"),
      ),
    ).toEqual(["INTERNAL_API line 3"]);
  });

  it("configures Anthropic Messages routing for Hermes managed inference (#4230)", () => {
    const { config } = runConfigScript({
      NEMOCLAW_PROVIDER_KEY: "anthropic",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local",
      NEMOCLAW_INFERENCE_API: "anthropic-messages",
    });

    expect(config.model).toEqual({
      default: "test-model",
      provider: "custom",
      base_url: "https://inference.local",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      api_mode: "anthropic_messages",
    });
  });

  it("configures the managed OpenAI frontend for a custom Anthropic upstream (#6289)", () => {
    const { config } = runConfigScript({
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-super-v3",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-anthropic-endpoint",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });

    expect(config.model).toEqual({
      default: "nvidia/nvidia/nemotron-3-super-v3",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
    expect(config._nemoclaw_upstream).toEqual({
      provider: "compatible-anthropic-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
    });
    expect(config.custom_providers[0].api_mode).toBeUndefined();
  });

  it("maps OpenAI Responses routing to Hermes' codex_responses api mode", () => {
    const { config } = runConfigScript({
      NEMOCLAW_INFERENCE_API: "openai-responses",
    });

    expect(config.model).toMatchObject({
      api_mode: "codex_responses",
    });
  });

  it("fails fast for unsupported Hermes inference API values", () => {
    expectGenerationError(
      { NEMOCLAW_INFERENCE_API: "graphql" },
      "Unsupported Hermes inference API: graphql",
    );
  });

  it("emits a model.api_key placeholder that satisfies the LiteLLM sk- prefix gate", () => {
    const { config } = runConfigScript();

    expect(typeof config.model.api_key).toBe("string");
    expect(config.model.api_key.startsWith("sk-")).toBe(true);
    expect(config.model.api_key).not.toBe("no-key-required");
    expect(config.model.api_key).toBe(HERMES_PROXY_API_KEY_PLACEHOLDER);
  });

  it("keeps generated and inference-switch Hermes proxy placeholders in sync", () => {
    const { config } = runConfigScript();

    expect(config.model.api_key).toBe(HERMES_PROXY_API_KEY_PLACEHOLDER);
  });

  it("preserves Hermes remote platform toolsets while keeping CLI defaults unpinned", async () => {
    const { config } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([
        "discord",
        "slack",
        "telegram",
        "wechat",
        "whatsapp",
      ]),
      NEMOCLAW_WECHAT_CONFIG_B64: encodeJson({
        accountId: "test_account_42",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "operator_self_id",
      }),
    });

    for (const platform of ["api_server", "discord", "slack", "telegram", "weixin", "whatsapp"]) {
      expectRemotePlatformToolsets(config.platform_toolsets[platform]);
    }

    // The local Hermes CLI keeps upstream defaults.
    expect(config.platform_toolsets.cli).toBeUndefined();
  });

  it("generates managed-tool gateway config and env for selected Nous presets", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson([
        "nous-web",
        "nous-audio",
        "nous-browser",
        "nous-image",
        "nous-code",
      ]),
    });

    expect(config.web).toEqual({ backend: "firecrawl", use_gateway: true });
    expect(config.tts).toEqual({ provider: "openai", use_gateway: true });
    expect(config.stt).toEqual({ provider: "openai", use_gateway: true });
    expect(config.browser).toEqual({ cloud_provider: "browser-use", use_gateway: true });
    expect(config.image_gen).toEqual({ use_gateway: true });
    expect(config.terminal).toMatchObject({ backend: "modal", modal_mode: "managed" });
    expectRemotePlatformToolsets(config.platform_toolsets.api_server, ["tts"]);
    expect(envFile).toContain("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1\n");
    expect(envFile).not.toContain("TOOL_GATEWAY_USER_TOKEN=");
    expect(envFile).not.toContain("NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=");
    expect(envFile).toContain(
      "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl\n",
    );
    expect(envFile).toContain(
      "OPENAI_AUDIO_GATEWAY_URL=http://host.openshell.internal:11436/openai-audio\n",
    );
    expect(envFile).toContain(
      "BROWSER_USE_GATEWAY_URL=http://host.openshell.internal:11436/browser-use\n",
    );
    expect(envFile).toContain(
      "FAL_QUEUE_GATEWAY_URL=http://host.openshell.internal:11436/fal-queue\n",
    );
    expect(envFile).toContain("MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal\n");
  });

  it("prefers selected Tavily over nous-web while preserving other managed tools", () => {
    const { config, envFile } = runConfigScript({
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson(["nous-web", "nous-audio"]),
    });

    expect(config.web).toEqual({ backend: "tavily" });
    expect(config.tts).toEqual({ provider: "openai", use_gateway: true });
    expect(config.stt).toEqual({ provider: "openai", use_gateway: true });
    expect(envFile).toContain("TAVILY_API_KEY=openshell:resolve:env:TAVILY_API_KEY\n");
    expect(envFile).not.toContain("FIRECRAWL_GATEWAY_URL=");
    expect(envFile).toContain(
      "OPENAI_AUDIO_GATEWAY_URL=http://host.openshell.internal:11436/openai-audio\n",
    );
    expect(envFile).toContain("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1\n");
  });

  it("fails fast for unknown managed-tool gateway presets", () => {
    expectGenerationError(
      {
        NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
        NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson(["nous-web", "nous-typo"]),
      },
      "Unknown Hermes managed-tool gateway preset: nous-typo",
    );
  });

  it("emits only resolver placeholders for secret-shaped Hermes env keys", async () => {
    const { envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([
        "discord",
        "slack",
        "telegram",
        "wechat",
        "whatsapp",
      ]),
      NEMOCLAW_WECHAT_CONFIG_B64: encodeJson({
        accountId: "test_account_42",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "operator_self_id",
      }),
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeJson([
        "nous-web",
        "nous-audio",
        "nous-browser",
        "nous-image",
        "nous-code",
      ]),
    });

    expect(findRawSecretEnvEntries(envFile)).toEqual([]);
    expect(envFile).not.toContain("OPENAI_API_KEY=");
  });

  it("writes Discord settings in Hermes' top-level schema and keeps tokens in .env", async () => {
    const { config, envFile } = await runConfigScriptWithMessaging({
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
    expect(config.platforms.discord).toEqual({ enabled: true });
    expectRemotePlatformToolsets(config.platform_toolsets.discord);
    expect(JSON.stringify(config)).not.toContain("DISCORD_BOT_TOKEN");
    expect(envFile).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n");
    expect(envFile).not.toContain("DISCORD_PROXY=");
    expect(envFile).not.toContain("NEMOCLAW_DISCORD_FACADE_URL");
    expect(envFile).toContain("NEMOCLAW_DISCORD_GUILD_IDS=1491590992753590594\n");
    expect(envFile).toContain("DISCORD_ALLOWED_USERS=1005536447329222676\n");
  });

  it("derives Hermes env placeholders from minimal persisted credential bindings", () => {
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      workflow: "rebuild",
      channels: [{ channelId: "discord", active: true, disabled: false }],
      disabledChannels: [],
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:v1442987827285932589_DISCORD_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      agentRender: [],
      buildSteps: [],
    };

    const { envFile } = generateBaseConfig({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([]),
      NEMOCLAW_MESSAGING_PLAN_B64: encodeJson(plan),
    });

    expect(envFile).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN\n");
    expect(findRawSecretEnvEntries(envFile)).toEqual([]);
  });

  it("preserves the Discord all-messages reply mode from onboarding", async () => {
    const { config } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["discord"]),
      NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({
        "1491590992753590594": {
          requireMention: false,
        },
      }),
    });

    expect(config.discord.require_mention).toBe(false);
  });

  it("allows Discord server members when no explicit user allowlist is configured", async () => {
    const { envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["discord"]),
      NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({
        "1491590992753590594": {
          requireMention: false,
        },
      }),
    });

    expect(envFile).toContain("DISCORD_ALLOW_ALL_USERS=true\n");
    expect(envFile).not.toContain("DISCORD_ALLOWED_USERS=");
  });

  it("does not allow all Discord users for empty guild config keys", async () => {
    const { envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["discord"]),
      NEMOCLAW_DISCORD_GUILDS_B64: encodeJson({
        " ": {
          requireMention: false,
        },
      }),
    });

    expect(envFile).not.toContain("DISCORD_ALLOW_ALL_USERS=true\n");
    expect(envFile).not.toContain("DISCORD_ALLOWED_USERS=");
  });

  it("enables Slack under platforms and keeps Telegram top-level only when messaging tokens are configured", async () => {
    const { config, envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram", "slack"]),
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({
        telegram: ["123456789"],
        slack: ["U0123456789", "U09ABCDEFGH"],
      }),
      NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({
        requireMention: true,
        groupPolicy: "disabled",
      }),
      NEMOCLAW_SLACK_CONFIG_B64: encodeJson({
        allowedChannels: ["C012AB3CD", "C987ZY6XW"],
      }),
    });

    expect(config.telegram).toEqual({ require_mention: true });
    expect(config.platforms.telegram).toEqual({ enabled: true });
    expect(config.platforms.slack).toEqual({
      enabled: true,
      extra: { rich_blocks: true },
    });
    expectRemotePlatformToolsets(config.platform_toolsets.telegram);
    expectRemotePlatformToolsets(config.platform_toolsets.slack);
    expect(envFile).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n");
    expect(envFile).toContain("TELEGRAM_ALLOWED_USERS=123456789\n");
    expect(envFile).toContain("SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\n");
    expect(envFile).toContain("SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN\n");
    expect(envFile).not.toContain("SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN\n");
    expect(envFile).not.toContain("SLACK_APP_TOKEN=openshell:resolve:env:SLACK_APP_TOKEN\n");
    expect(envFile).toContain("SLACK_ALLOWED_USERS=U0123456789,U09ABCDEFGH\n");
    expect(envFile).toContain("SLACK_ALLOWED_CHANNELS=C012AB3CD,C987ZY6XW\n");
  });

  it("omits platforms.slack when Slack channel is not enabled", () => {
    const { config } = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson([]),
    });

    expect(config.platforms.slack).toBeUndefined();
    expect(Object.keys(config.platforms)).toEqual(["api_server"]);
  });

  it("enables Slack under platforms even when the slack token allowlist is empty", async () => {
    const { config } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["slack"]),
    });

    expect(config.platforms.slack).toEqual({
      enabled: true,
      extra: { rich_blocks: true },
    });
    expect(config.platforms.api_server.enabled).toBe(true);
  });

  it("bridges captured WeChat metadata to Hermes' WEIXIN_* env contract", async () => {
    // Hermes' adapter reads WEIXIN_TOKEN + WEIXIN_ACCOUNT_ID (plus optional
    // WEIXIN_BASE_URL, WEIXIN_ALLOWED_USERS) per
    // https://hermes-agent.nousresearch.com/docs/user-guide/messaging/weixin.
    // NemoClaw's host-side iLink QR login captures the secret under
    // WECHAT_BOT_TOKEN in the OpenShell credential store; the placeholder
    // must reference that name so L7 egress can resolve it without a
    // host-side credential rename.
    const { config, envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["wechat"]),
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({
        wechat: ["bot_other_friend"],
      }),
      NEMOCLAW_WECHAT_CONFIG_B64: encodeJson({
        accountId: "test_account_42",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "operator_self_id",
      }),
    });

    // Hermes has no top-level "wechat:" config block — the adapter reads
    // env vars and writes its own state under ~/.hermes/weixin/.
    expect(config.wechat).toBeUndefined();
    expect(config.platforms.wechat).toBeUndefined();
    expect(config.platforms.weixin).toEqual({ enabled: true });
    expectRemotePlatformToolsets(config.platform_toolsets.weixin);

    // The bot token placeholder references the OpenShell credential slot
    // (WECHAT_BOT_TOKEN), NOT a fresh WEIXIN_TOKEN slot — that's the L7
    // resolution contract shared with OpenClaw's bridge.
    expect(envFile).toContain("WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN\n");
    expect(envFile).not.toContain("WEIXIN_TOKEN=openshell:resolve:env:WEIXIN_TOKEN\n");

    expect(envFile).toContain("WEIXIN_ACCOUNT_ID=test_account_42\n");
    expect(envFile).toContain("WEIXIN_BASE_URL=https://ilinkai.wechat.com\n");
    // Operator's own WeChat user id from the QR login is prepended to the
    // allowlist so the bot can DM them back without an extra prompt.
    expect(envFile).toContain("WEIXIN_ALLOWED_USERS=operator_self_id,bot_other_friend\n");
  });

  it("enables Hermes WhatsApp without provider tokens", async () => {
    const { config, envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["whatsapp"]),
    });

    expect(config.whatsapp).toBeUndefined();
    expect(config.platforms.whatsapp).toEqual({ enabled: true });
    expectRemotePlatformToolsets(config.platform_toolsets.whatsapp);
    expect(envFile).toContain("WHATSAPP_ENABLED=true\n");
    expect(envFile).toContain("WHATSAPP_MODE=bot\n");
    expect(envFile).not.toContain("WHATSAPP_BOT_TOKEN=");
    expect(envFile).not.toContain("openshell:resolve:env:WHATSAPP");
  });

  it("emits Hermes WhatsApp allowed users when configured", async () => {
    const { envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["whatsapp"]),
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: encodeJson({
        whatsapp: ["15551234567", "15557654321"],
      }),
    });

    expect(envFile).toContain("WHATSAPP_ALLOWED_USERS=15551234567,15557654321\n");
  });

  it("omits WeChat env when captured account metadata is incomplete", async () => {
    const { config, envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["wechat"]),
      NEMOCLAW_WECHAT_CONFIG_B64: encodeJson({
        baseUrl: "https://ilinkai.wechat.com",
        userId: "operator_self_id",
      }),
    });

    expect(config.platform_toolsets.weixin).toBeUndefined();
    expect(envFile).not.toContain("WEIXIN_TOKEN=");
    expect(envFile).not.toContain("WEIXIN_ACCOUNT_ID=");
  });

  it("defaults Telegram behavior config when requireMention is non-canonical", async () => {
    const { config, envFile } = await runConfigScriptWithMessaging({
      NEMOCLAW_MESSAGING_CHANNELS_B64: encodeJson(["telegram"]),
      NEMOCLAW_TELEGRAM_CONFIG_B64: encodeJson({ requireMention: "true" }),
    });

    expect(config.telegram).toEqual({ require_mention: true });
    expect(config.platforms.telegram).toEqual({ enabled: true });
    expectRemotePlatformToolsets(config.platform_toolsets.telegram);
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
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
    expect(config.kimi).toBeUndefined();
    expect(config.openclawPlugins).toBeUndefined();
    expect(envFile).toContain("API_SERVER_PORT=18642\n");
  });

  it("discovers and validates Hermes manifests without changing runtime output", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "hermes/fixture.json", {
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
    });

    const { config } = runConfigScript({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
      NEMOCLAW_MODEL: "fixture/hermes-model",
      NEMOCLAW_PROVIDER_KEY: "custom",
    });

    expect(config.model.default).toBe("fixture/hermes-model");
    expect(config.hermesCompat).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("future");
  });

  it("matches bounded bare model-family prefixes for Hermes manifests", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "hermes/family.json", {
      id: "fixture-hermes-family",
      agent: "hermes",
      description: "Fixture Hermes model family",
      match: { modelIdPrefixes: ["gpt-5", "o3"] },
      effects: { hermesCompat: {} },
    });
    const env = buildHermesTestEnv({ NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir });

    for (const [model, expectedMatches] of [
      ["gpt-5.4-turbo", 1],
      ["azure/gpt-5.4", 1],
      ["openai/o3-mini", 1],
      ["gpt-50", 0],
      ["o30", 0],
    ] as const) {
      const matches = discoverModelSpecificSetups(
        "hermes",
        {
          model,
          providerKey: "custom",
          inferenceApi: "openai-completions",
          baseUrl: "https://inference.local/v1",
        },
        { env, scriptDir: SCRIPT_DIR },
      );
      expect(matches, model).toHaveLength(expectedMatches);
    }
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
    const registryDir = writeRegistryManifest(blueprintDir, "hermes/bad-effect.json", {
      id: "bad-hermes-effect",
      agent: "hermes",
      description: "Invalid Hermes effect",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawCompat: {},
      },
    });

    expectGenerationError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "unknown effects for agent 'hermes': openclawCompat",
    );
  });

  it("rejects empty match objects and invalid explicit registry overrides", () => {
    const missingRegistry = path.join(tmpDir, "missing-registry");
    expectGenerationError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingRegistry },
      "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory",
    );

    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "hermes/empty-match.json", {
      id: "empty-hermes-match",
      agent: "hermes",
      description: "Invalid Hermes match",
      match: {},
      effects: {
        hermesCompat: {},
      },
    });

    expectGenerationError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "field 'match' must be a non-empty object",
    );
  });
});
