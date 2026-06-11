// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { expect, test } from "../fixtures/e2e-test.ts";

// Migrated from test/e2e/test-runtime-overrides.sh. This keeps the real
// Docker-image/entrypoint boundary: build the NemoClaw sandbox image, start
// short-lived containers through the real ENTRYPOINT, then read the patched
// /sandbox/.openclaw/openclaw.json and .config-hash from inside the container.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TEST_TIMEOUT_MS = 45 * 60 * 1000;
const DOCKER_BUFFER_BYTES = 20 * 1024 * 1024;
const DOCKER_REQUIRED_MESSAGE = "Docker is required for runtime override coverage";

const runtimeOverridesTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type ModelConfig = {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  [key: string]: unknown;
};

type ProviderConfig = {
  api?: string;
  models: ModelConfig[];
  [key: string]: unknown;
};

type OpenClawConfig = {
  agents: { defaults: { model: { primary: string } } };
  models: { providers: Record<string, ProviderConfig> };
  gateway: { controlUi: { allowedOrigins: string[] } };
  [key: string]: unknown;
};

function commandResult(result: ReturnType<typeof spawnSync>): CommandResult {
  return {
    status: result.status,
    stdout:
      typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString("utf8") ?? ""),
    stderr:
      typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString("utf8") ?? ""),
    error: result.error,
  };
}

function run(command: string, args: string[]): CommandResult {
  return commandResult(
    spawnSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: DOCKER_BUFFER_BYTES,
    }),
  );
}

function resultText(result: CommandResult): string {
  return [
    `status=${result.status}`,
    result.error ? `error=${result.error.message}` : "",
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatLog(label: string, result: CommandResult): string {
  return [`## ${label}`, resultText(result)].join("\n");
}

function firstProvider(config: OpenClawConfig): ProviderConfig {
  const provider = Object.values(config.models.providers)[0];
  if (!provider) throw new Error("config must contain at least one provider");
  return provider;
}

function firstProviderModel(config: OpenClawConfig): ModelConfig {
  const model = firstProvider(config).models?.[0];
  if (!model) throw new Error("config must contain at least one provider model");
  return model;
}

function parseConfig(stdout: string, label: string): OpenClawConfig {
  let config: OpenClawConfig;
  try {
    config = JSON.parse(stdout.trim()) as OpenClawConfig;
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${(error as Error).message}\n${stdout}`);
  }

  expect(typeof config.agents?.defaults?.model?.primary, `${label} primary model`).toBe("string");
  expect(config.agents.defaults.model.primary.length, `${label} primary model`).toBeGreaterThan(0);
  expect(typeof config.models?.providers, `${label} providers`).toBe("object");
  const model = firstProviderModel(config);
  expect(typeof model.contextWindow, `${label} contextWindow`).toBe("number");
  expect(typeof model.maxTokens, `${label} maxTokens`).toBe("number");
  expect(typeof model.reasoning, `${label} reasoning`).toBe("boolean");
  expect(Array.isArray(config.gateway?.controlUi?.allowedOrigins), `${label} allowedOrigins`).toBe(
    true,
  );
  return config;
}

function primaryModel(config: OpenClawConfig): string {
  return config.agents.defaults.model.primary;
}

function allowedOrigins(config: OpenClawConfig): string[] {
  return config.gateway.controlUi.allowedOrigins;
}

function dockerRunArgs(image: string, env: Record<string, string>, script: string): string[] {
  return [
    "run",
    "--rm",
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
    "bash",
    "-c",
    script,
  ];
}

function runContainer(
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string>,
  script: string,
): CommandResult {
  const result = run("docker", dockerRunArgs(image, env, script));
  dockerLog.push(formatLog(label, result));
  return result;
}

function captureConfig(
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string> = {},
): OpenClawConfig {
  let lastResult: CommandResult | undefined;
  let lastError: Error | undefined;
  // Preserve the legacy script's Docker/ENTRYPOINT stdout tolerance: very short
  // one-shot containers can race the entrypoint's tee process substitution even
  // though the JSON is written to fd3. Keep this local retry until the startup
  // capture path no longer uses tee for container stdout/stderr fanout.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = runContainer(
      dockerLog,
      image,
      `${label} config capture attempt ${attempt}`,
      env,
      'cat /sandbox/.openclaw/openclaw.json >&3; printf "\\n" >&3',
    );
    lastResult = result;
    if (result.status === 0) {
      try {
        return parseConfig(result.stdout, label);
      } catch (error) {
        lastError = error as Error;
      }
    }
  }

  throw new Error(
    `${label} config capture failed after 3 attempts\n${lastError?.message ?? ""}\n${lastResult ? resultText(lastResult) : ""}`,
  );
}

function runConfigHashCheck(
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string> = {},
): string {
  const result = runContainer(
    dockerLog,
    image,
    `${label} config hash check`,
    env,
    'cd /sandbox/.openclaw && if sha256sum -c .config-hash --status; then printf "OK\\n" >&3; else printf "FAIL\\n" >&3; fi',
  );
  expect(result.status, resultText(result)).toBe(0);
  return result.stdout.trim();
}

function runOverrideStderr(
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string>,
): string {
  const result = runContainer(dockerLog, image, label, env, "true");
  return result.stderr;
}

function dockerAvailable(): CommandResult {
  return run("docker", ["info"]);
}

function buildImage(dockerLog: string[], image: string): void {
  const inspect = run("docker", ["image", "inspect", image]);
  dockerLog.push(formatLog(`inspect ${image}`, inspect));
  if (inspect.status === 0) return;

  const build = run("docker", [
    "build",
    "-t",
    image,
    "-f",
    path.join(REPO_ROOT, "Dockerfile"),
    "--build-arg",
    "NEMOCLAW_DISABLE_DEVICE_AUTH=1",
    "--build-arg",
    `NEMOCLAW_BUILD_ID=${Date.now()}`,
    "--quiet",
    REPO_ROOT,
  ]);
  dockerLog.push(formatLog(`build ${image}`, build));
  expect(build.status, resultText(build)).toBe(0);
}

runtimeOverridesTest(
  "runtime config overrides patch OpenClaw config through the Docker entrypoint",
  testTimeoutOptions(TEST_TIMEOUT_MS),
  async ({ artifacts, secrets, skip }) => {
    const dockerLog: string[] = [];
    const image =
      process.env.NEMOCLAW_TEST_IMAGE ?? `nemoclaw-runtime-overrides-vitest-${process.pid}`;
    const cleanupImage = process.env.NEMOCLAW_TEST_IMAGE === undefined;

    try {
      await artifacts.writeJson("scenario.json", {
        id: "runtime-overrides",
        runner: "vitest",
        migratedFrom: "test/e2e/test-runtime-overrides.sh",
        boundary: "docker-image-entrypoint",
        image,
        contract: [
          "baseline config hash validates",
          "model/API/context/max-token/reasoning overrides patch openclaw.json",
          "CORS origin override extends gateway.controlUi.allowedOrigins",
          "combined overrides apply atomically",
          "invalid override values are rejected without mutating config",
        ],
      });

      const docker = dockerAvailable();
      dockerLog.push(formatLog("docker info", docker));
      if (docker.status !== 0) {
        await artifacts.writeJson("scenario-result.json", {
          id: "runtime-overrides",
          status: "skipped",
          reason: DOCKER_REQUIRED_MESSAGE,
        });
        if (process.env.GITHUB_ACTIONS === "true") {
          throw new Error(`${DOCKER_REQUIRED_MESSAGE}\n${resultText(docker)}`);
        }
        skip(DOCKER_REQUIRED_MESSAGE);
      }

      buildImage(dockerLog, image);

      const baseline = captureConfig(dockerLog, image, "baseline");
      const baselineModel = primaryModel(baseline);
      const baselineFirstModel = firstProviderModel(baseline);
      const baselineContextWindow = baselineFirstModel.contextWindow;
      const baselineOriginCount = allowedOrigins(baseline).length;

      expect(runConfigHashCheck(dockerLog, image, "baseline")).toBe("OK");

      const overrideModel = "anthropic/claude-sonnet-4-6";
      const modelOverride = captureConfig(dockerLog, image, "model override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
      });
      expect(primaryModel(modelOverride)).toBe(overrideModel);
      expect(
        runConfigHashCheck(dockerLog, image, "model override", {
          NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        }),
      ).toBe("OK");

      const apiOverride = captureConfig(dockerLog, image, "inference API override", {
        NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      });
      expect(firstProvider(apiOverride).api).toBe("anthropic-messages");
      expect(
        runConfigHashCheck(dockerLog, image, "inference API override", {
          NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
        }),
      ).toBe("OK");

      const contextOverride = captureConfig(dockerLog, image, "context window override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_CONTEXT_WINDOW: "32768",
      });
      expect(firstProviderModel(contextOverride).contextWindow).toBe(32768);

      const maxTokensOverride = captureConfig(dockerLog, image, "max tokens override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_MAX_TOKENS: "16384",
      });
      expect(firstProviderModel(maxTokensOverride).maxTokens).toBe(16384);

      const reasoningOverride = captureConfig(dockerLog, image, "reasoning override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_REASONING: "true",
      });
      expect(firstProviderModel(reasoningOverride).reasoning).toBe(true);

      const corsOrigin = "https://custom.example.com:9999";
      const corsOverride = captureConfig(dockerLog, image, "CORS origin override", {
        NEMOCLAW_CORS_ORIGIN: corsOrigin,
      });
      expect(allowedOrigins(corsOverride)).toContain(corsOrigin);
      expect(allowedOrigins(corsOverride).length).toBeGreaterThan(baselineOriginCount);

      const combined = captureConfig(dockerLog, image, "combined overrides", {
        NEMOCLAW_MODEL_OVERRIDE: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        NEMOCLAW_CONTEXT_WINDOW: "65536",
        NEMOCLAW_MAX_TOKENS: "8192",
        NEMOCLAW_REASONING: "true",
        NEMOCLAW_CORS_ORIGIN: "https://multi.example.com",
      });
      expect(primaryModel(combined)).toBe("nvidia/llama-3.3-nemotron-super-49b-v1.5");
      expect(firstProviderModel(combined)).toMatchObject({
        contextWindow: 65536,
        maxTokens: 8192,
        reasoning: true,
      });
      expect(allowedOrigins(combined)).toContain("https://multi.example.com");

      expect(
        runOverrideStderr(dockerLog, image, "invalid model override", {
          NEMOCLAW_MODEL_OVERRIDE: "bad\u0001model",
        }),
      ).toContain("control characters");
      expect(
        runOverrideStderr(dockerLog, image, "invalid context window", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_CONTEXT_WINDOW: "notanumber",
        }),
      ).toContain("must be a positive integer");
      expect(
        runOverrideStderr(dockerLog, image, "invalid max tokens", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_MAX_TOKENS: "abc",
        }),
      ).toContain("must be a positive integer");
      expect(
        runOverrideStderr(dockerLog, image, "invalid reasoning", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_REASONING: "maybe",
        }),
      ).toContain('must be "true" or "false"');
      expect(
        runOverrideStderr(dockerLog, image, "invalid CORS origin", {
          NEMOCLAW_CORS_ORIGIN: "ftp://evil.com",
        }),
      ).toContain("must start with http");
      expect(
        runOverrideStderr(dockerLog, image, "invalid inference API", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_INFERENCE_API_OVERRIDE: "graphql",
        }),
      ).toContain("openai-completions");

      const rejected = captureConfig(dockerLog, image, "rejected override", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_CONTEXT_WINDOW: "notanumber",
      });
      expect(primaryModel(rejected)).toBe(baselineModel);
      expect(firstProviderModel(rejected).contextWindow).toBe(baselineContextWindow);

      await artifacts.writeJson("scenario-result.json", {
        id: "runtime-overrides",
        status: "passed",
        image,
      });
    } finally {
      if (cleanupImage) {
        const cleanup = run("docker", ["image", "rm", "-f", image]);
        dockerLog.push(formatLog(`cleanup ${image}`, cleanup));
      }
      await artifacts.writeText("docker.log", `${secrets.redact(dockerLog.join("\n\n"))}\n`);
    }
  },
);
