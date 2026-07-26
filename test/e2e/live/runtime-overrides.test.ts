// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Docker-image/entrypoint boundary: build the NemoClaw sandbox image, start
// short-lived containers through the real ENTRYPOINT, then read the patched
// /sandbox/.openclaw/openclaw.json and .config-hash from inside the container.

const TEST_TIMEOUT_MS = 45 * 60 * 1000;
const DOCKER_BUFFER_BYTES = 20 * 1024 * 1024;
const DOCKER_REQUIRED_MESSAGE = "Docker is required for runtime override coverage";
const DOCKER_COMMAND_TIMEOUT_MS = 5 * 60_000;
const DOCKER_BUILD_TIMEOUT_MS = 30 * 60_000;

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

const MANAGED_INFERENCE_SAFEGUARD_COMPACTION = {
  mode: "safeguard",
  timeoutSeconds: 120,
  maxHistoryShare: 0.35,
  recentTurnsPreserve: 1,
  qualityGuard: { enabled: true, maxRetries: 0 },
  notifyUser: true,
  truncateAfterCompaction: true,
};

type ObservableCommandRunner = (
  command: string,
  args: string[],
  artifactName: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

function commandResult(result: ShellProbeResult): CommandResult {
  return {
    status: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runObserved(
  host: HostCliClient,
  command: string,
  args: string[],
  artifactName: string,
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  try {
    return commandResult(
      await host.command(command, args, {
        artifactName: `runtime-overrides-${artifactName}`,
        captureLimitBytes: DOCKER_BUFFER_BYTES,
        env: buildAvailabilityProbeEnv(),
        timeoutMs,
        cwd: REPO_ROOT,
      }),
    );
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function spawnResultText(result: CommandResult): string {
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
  return [`## ${label}`, spawnResultText(result)].join("\n");
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

async function runContainer(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string>,
  script: string,
): Promise<CommandResult> {
  const result = await run("docker", dockerRunArgs(image, env, script), label);
  dockerLog.push(formatLog(label, result));
  return result;
}

async function captureConfig(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string> = {},
): Promise<OpenClawConfig> {
  let lastResult: CommandResult | undefined;
  let lastError: Error | undefined;
  // Preserve the former shell test's Docker/ENTRYPOINT stdout tolerance: very short
  // one-shot containers can race the entrypoint's tee process substitution even
  // though the JSON is written to fd3. Keep this local retry until the startup
  // capture path no longer uses tee for container stdout/stderr fanout.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runContainer(
      run,
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
    `${label} config capture failed after 3 attempts\n${lastError?.message ?? ""}\n${lastResult ? spawnResultText(lastResult) : ""}`,
  );
}

async function runConfigHashCheck(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string> = {},
): Promise<string> {
  // Keep the one-shot container alive long enough for its tiny fd3 marker to
  // drain through Docker attach; the JSON capture above is naturally larger.
  const result = await runContainer(
    run,
    dockerLog,
    image,
    `${label} config hash check`,
    env,
    'cd /sandbox/.openclaw && if sha256sum -c .config-hash --status; then printf "OK\\n" >&3; else printf "FAIL\\n" >&3; fi; sleep 0.1',
  );
  expect(result.status, spawnResultText(result)).toBe(0);
  return result.stdout.trim();
}

async function assertManagedInferenceCompactionRuntime(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
): Promise<void> {
  const result = await runContainer(
    run,
    dockerLog,
    image,
    "managed inference compaction runtime validation",
    {},
    String.raw`set -eu
validation="$(openclaw config validate --json)"
compaction="$(openclaw config get agents.defaults.compaction --json)"
printf '{"validation":%s,"compaction":%s}\n' "$validation" "$compaction" >&3
sleep 0.1`,
  );
  expect(result.status, spawnResultText(result)).toBe(0);

  let proof: { validation?: { valid?: boolean }; compaction?: unknown };
  try {
    proof = JSON.parse(result.stdout.trim()) as typeof proof;
  } catch (error) {
    throw new Error(
      `managed inference compaction proof did not emit valid JSON: ${(error as Error).message}\n${result.stdout}`,
    );
  }
  expect(proof.validation?.valid).toBe(true);
  expect(proof.compaction).toEqual(MANAGED_INFERENCE_SAFEGUARD_COMPACTION);
}

async function runOverrideStderr(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
  label: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await runContainer(run, dockerLog, image, label, env, "true");
  return result.stderr;
}

function dockerAvailable(run: ObservableCommandRunner): Promise<CommandResult> {
  return run("docker", ["info"], "docker-info", 30_000);
}

async function buildImage(
  run: ObservableCommandRunner,
  dockerLog: string[],
  image: string,
): Promise<void> {
  const inspect = await run("docker", ["image", "inspect", image], `inspect-${image}`, 30_000);
  dockerLog.push(formatLog(`inspect ${image}`, inspect));
  if (inspect.status === 0) return;

  const build = await run(
    "docker",
    [
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
    ],
    `build-${image}`,
    DOCKER_BUILD_TIMEOUT_MS,
  );
  dockerLog.push(formatLog(`build ${image}`, build));
  expect(build.status, spawnResultText(build)).toBe(0);
}

// biome-ignore format: preserve legacy live-test body formatting so phase-only changes stay reviewable.
test(
  "runtime config overrides patch OpenClaw config through the Docker entrypoint",
  {
    ...testTimeoutOptions(TEST_TIMEOUT_MS),
    meta: {
      e2ePhases: [
        "confirm Docker and build the runtime image",
        "capture the baseline OpenClaw config",
        "apply valid runtime overrides",
        "exercise the combined override transaction",
        "reject invalid override values",
        "confirm rejected overrides preserve the baseline",
        "record runtime override evidence",
      ],
    },
  },
  async ({ artifacts, host, progress, secrets, skip }) => {
    const dockerLog: string[] = [];
    const image = process.env.NEMOCLAW_TEST_IMAGE ?? `nemoclaw-runtime-overrides-${process.pid}`;
    const cleanupImage = process.env.NEMOCLAW_TEST_IMAGE === undefined;
    const run: ObservableCommandRunner = (command, args, artifactName, timeoutMs) =>
      runObserved(host, command, args, artifactName, timeoutMs);

    try {
      await artifacts.target.declare({
        id: "runtime-overrides",
        boundary: "docker-image-entrypoint",
        image,
        contract: [
          "baseline config hash validates",
          "pinned OpenClaw accepts and loads managed inference safeguard compaction",
          "model/API/context/max-token/reasoning overrides patch openclaw.json",
          "CORS origin override extends gateway.controlUi.allowedOrigins",
          "combined overrides apply atomically",
          "invalid override values are rejected without mutating config",
        ],
      });

      const docker = await dockerAvailable(run);
      dockerLog.push(formatLog("docker info", docker));
      if (docker.status !== 0) {
        await artifacts.target.complete({
          id: "runtime-overrides",
          status: "skipped",
          reason: DOCKER_REQUIRED_MESSAGE,
        });
        if (process.env.GITHUB_ACTIONS === "true") {
          throw new Error(`${DOCKER_REQUIRED_MESSAGE}\n${spawnResultText(docker)}`);
        }
        skip(DOCKER_REQUIRED_MESSAGE);
      }

      await buildImage(run, dockerLog, image);

      progress.phase("capture the baseline OpenClaw config");
      const baseline = await captureConfig(run, dockerLog, image, "baseline");
      const baselineModel = primaryModel(baseline);
      const baselineFirstModel = firstProviderModel(baseline);
      const baselineContextWindow = baselineFirstModel.contextWindow;
      const baselineOriginCount = allowedOrigins(baseline).length;

      await assertManagedInferenceCompactionRuntime(run, dockerLog, image);
      expect(await runConfigHashCheck(run, dockerLog, image, "baseline")).toBe("OK");

      progress.phase("apply valid runtime overrides");
      const overrideModel = "anthropic/claude-sonnet-4-6";
      const modelOverride = await captureConfig(run, dockerLog, image, "model override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
      });
      expect(primaryModel(modelOverride)).toBe(overrideModel);
      expect(
        await runConfigHashCheck(run, dockerLog, image, "model override", {
          NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        }),
      ).toBe("OK");

      const apiOverride = await captureConfig(run, dockerLog, image, "inference API override", {
        NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      });
      expect(firstProvider(apiOverride).api).toBe("anthropic-messages");
      expect(
        await runConfigHashCheck(run, dockerLog, image, "inference API override", {
          NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
        }),
      ).toBe("OK");

      const contextOverride = await captureConfig(run, dockerLog, image, "context window override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_CONTEXT_WINDOW: "32768",
      });
      expect(firstProviderModel(contextOverride).contextWindow).toBe(32768);

      const maxTokensOverride = await captureConfig(run, dockerLog, image, "max tokens override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_MAX_TOKENS: "16384",
      });
      expect(firstProviderModel(maxTokensOverride).maxTokens).toBe(16384);

      const reasoningOverride = await captureConfig(run, dockerLog, image, "reasoning override", {
        NEMOCLAW_MODEL_OVERRIDE: overrideModel,
        NEMOCLAW_REASONING: "true",
      });
      expect(firstProviderModel(reasoningOverride).reasoning).toBe(true);

      const corsOrigin = "https://custom.example.com:9999";
      const corsOverride = await captureConfig(run, dockerLog, image, "CORS origin override", {
        NEMOCLAW_CORS_ORIGIN: corsOrigin,
      });
      expect(allowedOrigins(corsOverride)).toContain(corsOrigin);
      expect(allowedOrigins(corsOverride).length).toBeGreaterThan(baselineOriginCount);

      progress.phase("exercise the combined override transaction");
      const combined = await captureConfig(run, dockerLog, image, "combined overrides", {
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

      progress.phase("reject invalid override values");
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid model override", {
          NEMOCLAW_MODEL_OVERRIDE: "bad\u0001model",
        }),
      ).toContain("control characters");
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid context window", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_CONTEXT_WINDOW: "notanumber",
        }),
      ).toContain("must be a positive integer");
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid max tokens", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_MAX_TOKENS: "abc",
        }),
      ).toContain("must be a positive integer");
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid reasoning", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_REASONING: "maybe",
        }),
      ).toContain('must be "true" or "false"');
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid CORS origin", {
          NEMOCLAW_CORS_ORIGIN: "ftp://evil.com",
        }),
      ).toContain("must start with http");
      expect(
        await runOverrideStderr(run, dockerLog, image, "invalid inference API", {
          NEMOCLAW_MODEL_OVERRIDE: "test",
          NEMOCLAW_INFERENCE_API_OVERRIDE: "graphql",
        }),
      ).toContain("openai-completions");

      progress.phase("confirm rejected overrides preserve the baseline");
      const rejected = await captureConfig(run, dockerLog, image, "rejected override", {
        NEMOCLAW_MODEL_OVERRIDE: "test",
        NEMOCLAW_CONTEXT_WINDOW: "notanumber",
      });
      expect(primaryModel(rejected)).toBe(baselineModel);
      expect(firstProviderModel(rejected).contextWindow).toBe(baselineContextWindow);

      progress.phase("record runtime override evidence");
      await artifacts.target.complete({
        id: "runtime-overrides",
        status: "passed",
        image,
      });
    } finally {
      if (cleanupImage) {
        const cleanup = await run(
          "docker",
          ["image", "rm", "-f", image],
          `cleanup-${image}`,
        );
        dockerLog.push(formatLog(`cleanup ${image}`, cleanup));
      }
      await artifacts.writeText("docker.log", `${secrets.redact(dockerLog.join("\n\n"))}\n`);
    }
  },
);
