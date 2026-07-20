// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { DEFAULT_HOSTED_INFERENCE_BASE_URL } from "../fixtures/hosted-inference.ts";
import { inferenceResponseModel } from "../fixtures/inference-switch-retry.ts";
import {
  apiKeyShape,
  chatContent,
  cleanupHermesSwitch,
  compatibleAnthropicMetadataArgs,
  ensureCompatibleAnthropicSwitchProvider,
  env,
  envHash,
  expectAuthenticatedBaselineInventoryRequest,
  expectedApiMode,
  expectedBaseUrl,
  hashCheck,
  hermesApiCommand,
  hermesGatewayPid,
  hostedInstallModel,
  inferenceLocalCommand,
  inferenceLocalMaxTokens,
  installHermes,
  maybeAssertEnvHashStable,
  maybeAssertPidStable,
  mockAnthropicSwitchEnabled,
  parseHermesModelBlock,
  parseInferenceRoute,
  RUNTIME_SWITCH_API,
  registryState,
  runHermesCliPongWithRetry,
  runHermesInferenceSetWithRetry,
  runHermesPongWithRetry,
  SANDBOX_NAME,
  SWITCH_API,
  SWITCH_MODEL,
  SWITCH_PROVIDER,
  strictHashPerms,
} from "./hermes-inference-switch-helpers.ts";
import { stripAnsi } from "./json-envelope.ts";
import {
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  registerPublicNvidiaSwitchProvider,
  requirePublicNvidiaSwitchKey,
} from "./public-nvidia-switch-provider.ts";

const TIMEOUT_MS = 45 * 60_000;
const MOCK_BASELINE_API_KEY = "hermes-inference-switch-baseline-credential";
const MOCK_BASELINE_MODEL = "hermes-inference-switch-baseline-model";
const HERMES_DASHBOARD_INTERNAL_PORT =
  process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ?? "19119";

function canonicalEndpoint(value: unknown): string | null {
  return typeof value === "string" ? new URL(value).toString() : null;
}

async function expectCompatibleAnthropicOpenAiProvider(
  host: Parameters<typeof ensureCompatibleAnthropicSwitchProvider>[0],
): Promise<void> {
  const provider = await host.command(
    "openshell",
    ["provider", "get", "-g", "nemoclaw", "compatible-anthropic-endpoint"],
    {
      artifactName: "compatible-anthropic-openai-provider-metadata",
      env: env(),
      timeoutMs: 30_000,
    },
  );
  const output = resultText(provider);
  expect(provider.exitCode, output).toBe(0);
  const plain = stripAnsi(output);
  expect(plain).toMatch(/^\s*Type:\s*openai\s*$/imu);
  expect(plain).toContain("COMPATIBLE_ANTHROPIC_API_KEY");
  expect(plain).toContain("OPENAI_BASE_URL");
}

test("Hermes inference set updates route/config and preserves live runtime", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "prepare clean Hermes inference sandbox",
      "install baseline Hermes runtime",
      "switch Hermes inference provider",
      "validate switched route and locked config",
      "exercise inference.local and Hermes API",
      "run Hermes CLI against switched provider",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets }) => {
  await artifacts.target.declare({
    id: "hermes-inference-switch",
    boundary:
      "install.sh + Hermes sandbox + inference set + in-sandbox health/chat + hermes -z probes",
    sandboxName: SANDBOX_NAME,
    switchProvider: SWITCH_PROVIDER,
    switchModel: SWITCH_MODEL,
    switchApi: SWITCH_API,
    runtimeSwitchApi: RUNTIME_SWITCH_API,
  });

  const cleanupEnv = env();
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway",
    env: cleanupEnv,
    timeoutMs: 60_000,
  });
  cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-delete",
      env: cleanupEnv,
      timeoutMs: 60_000,
    }),
  );
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy",
    env: cleanupEnv,
    timeoutMs: 120_000,
  });
  await cleanupHermesSwitch(host, sandbox);

  const docker = await host.command("docker", ["info"], {
    artifactName: "docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, resultText(docker)).toBe(0);

  // OpenShell reaches this fixture from its gateway network namespace, where
  // the runner's loopback address is not routable.
  const mockBaseline = mockAnthropicSwitchEnabled()
    ? await startFakeOpenAiCompatibleServer({
        apiKey: MOCK_BASELINE_API_KEY,
        host: "0.0.0.0",
        model: MOCK_BASELINE_MODEL,
        publicHost: "host.openshell.internal",
        requireAuth: true,
      })
    : undefined;
  cleanup.trackDisposable("close Hermes inference switch baseline fixture", async () => {
    await artifacts.writeJson(
      "baseline-openai-compatible-requests.json",
      mockBaseline?.requests() ?? [],
    );
    await mockBaseline?.close();
  });
  const apiKey = mockBaseline
    ? MOCK_BASELINE_API_KEY
    : secrets.required("NVIDIA_INFERENCE_API_KEY");
  const publicApiKey =
    SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
      ? requirePublicNvidiaSwitchKey(secrets.required("NVIDIA_API_KEY"))
      : null;
  const redactionValues = [apiKey, publicApiKey].filter(
    (value): value is string => typeof value === "string",
  );
  const installEnv: NodeJS.ProcessEnv = {
    NEMOCLAW_HERMES_DASHBOARD: "1",
    NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: HERMES_DASHBOARD_INTERNAL_PORT,
    ...(mockBaseline
      ? {
          COMPATIBLE_API_KEY: apiKey,
          NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
          NEMOCLAW_ENDPOINT_URL: mockBaseline.baseUrl,
          NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
          NEMOCLAW_PREFERRED_API: "openai-completions",
          NEMOCLAW_PROVIDER: "custom",
        }
      : {}),
  };

  progress.phase("install baseline Hermes runtime");
  const install = await installHermes(host, apiKey, installEnv);
  expect(install.exitCode, resultText(install)).toBe(0);
  expectAuthenticatedBaselineInventoryRequest(mockBaseline);
  const baselineRoute = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
    artifactName: "openshell-inference-route-before-switch",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(baselineRoute.exitCode, resultText(baselineRoute)).toBe(0);
  expect(parseInferenceRoute(resultText(baselineRoute))).toEqual({
    provider: "compatible-endpoint",
    model: hostedInstallModel(installEnv),
  });
  const publicProvider = publicApiKey
    ? await registerPublicNvidiaSwitchProvider(host, publicApiKey, env())
    : null;
  publicProvider && expect(publicProvider.exitCode, resultText(publicProvider)).toBe(0);
  const switchEndpointUrl = await ensureCompatibleAnthropicSwitchProvider(host, cleanup);
  switchEndpointUrl && (await expectCompatibleAnthropicOpenAiProvider(host));

  const pidBefore = await hermesGatewayPid(sandbox, "pid-before");
  const envHashBefore = await envHash(sandbox, "env-hash-before");

  progress.phase("switch Hermes inference provider");
  const compatibleMetadataArgs = compatibleAnthropicMetadataArgs(switchEndpointUrl);
  const switched = await runHermesInferenceSetWithRetry(
    host,
    redactionValues,
    compatibleMetadataArgs,
  );
  expect(switched.exitCode, resultText(switched)).toBe(0);
  expect(resultText(switched)).not.toContain("writing the in-sandbox config failed");
  expect(resultText(switched)).toContain(`Inference route synced for '${SANDBOX_NAME}'`);

  progress.phase("validate switched route and locked config");
  const pidAfter = await hermesGatewayPid(sandbox, "pid-after");
  maybeAssertPidStable(pidBefore, pidAfter, (actual, expected) => expect(actual).toBe(expected));

  const health = await sandbox.exec(
    SANDBOX_NAME,
    ["curl", "-sf", "--max-time", "10", "http://localhost:8642/health"],
    { artifactName: "hermes-health-after-switch", env: env(), timeoutMs: 30_000 },
  );
  expect(health.exitCode, resultText(health)).toBe(0);
  expect(resultText(health)).toMatch(/ok/i);

  const route = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
    artifactName: "openshell-inference-route",
    env: env(),
    timeoutMs: 30_000,
  });
  expect(route.exitCode, resultText(route)).toBe(0);
  expect(parseInferenceRoute(resultText(route))).toEqual({
    provider: SWITCH_PROVIDER,
    model: SWITCH_MODEL,
  });

  const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/config.yaml"], {
    artifactName: "hermes-config-yaml",
    env: env(),
    redactionValues,
    timeoutMs: 30_000,
  });
  expect(config.exitCode, resultText(config)).toBe(0);
  const model = parseHermesModelBlock(config.stdout);
  expect(model.default).toBe(SWITCH_MODEL);
  expect(model.provider).toBe("custom");
  expect(model.base_url).toBe(expectedBaseUrl());
  expect(model.api_mode).toBe(expectedApiMode());
  expect((await apiKeyShape(sandbox)).exitCode).toBe(0);
  expect(config.stdout).not.toMatch(/^models:\s*$/mu);

  const dashboardConfig = await sandbox.exec(
    SANDBOX_NAME,
    ["cat", "/sandbox/.hermes/dashboard-home/config.yaml"],
    {
      artifactName: "hermes-dashboard-config-yaml-after-switch",
      env: env(),
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  expect(dashboardConfig.exitCode, resultText(dashboardConfig)).toBe(0);
  const dashboardModel = parseHermesModelBlock(dashboardConfig.stdout);
  expect(dashboardModel.default).toBe(SWITCH_MODEL);
  expect(dashboardModel.provider).toBe(SWITCH_PROVIDER);
  expect(dashboardModel.base_url).toBe(expectedBaseUrl());
  expect(dashboardModel.api_mode).toBe(expectedApiMode());

  const dashboardModelInfo = await sandbox.exec(
    SANDBOX_NAME,
    [
      "curl",
      "-sf",
      "--max-time",
      "10",
      `http://127.0.0.1:${HERMES_DASHBOARD_INTERNAL_PORT}/api/model/info`,
    ],
    {
      artifactName: "hermes-dashboard-model-info-after-switch",
      env: env(),
      timeoutMs: 30_000,
    },
  );
  expect(dashboardModelInfo.exitCode, resultText(dashboardModelInfo)).toBe(0);
  expect(JSON.parse(dashboardModelInfo.stdout)).toMatchObject({ model: SWITCH_MODEL });

  const strictHash = await hashCheck(sandbox, "/etc/nemoclaw/hermes.config-hash", "strict");
  expect(strictHash.exitCode, resultText(strictHash)).toBe(0);
  expect(strictHash.stdout).toContain("OK");
  const compatHash = await hashCheck(sandbox, "/sandbox/.hermes/.config-hash", "compat");
  expect(compatHash.exitCode, resultText(compatHash)).toBe(0);
  expect(compatHash.stdout).toContain("OK");
  const strictPerms = await strictHashPerms(sandbox);
  expect(strictPerms.stdout.trim()).toMatch(/^0\s+[0-7]+$/u);
  expect(Number.parseInt(strictPerms.stdout.trim().split(/\s+/u)[1], 8) & 0o222).toBe(0);

  maybeAssertEnvHashStable(
    envHashBefore,
    await envHash(sandbox, "env-hash-after"),
    (actual, expected) => expect(actual).toBe(expected),
  );

  const state = registryState();
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.agent).toBe("hermes");
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.provider).toBe(SWITCH_PROVIDER);
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.model).toBe(SWITCH_MODEL);
  expect(state.session.sandboxName).toBe(SANDBOX_NAME);
  expect(state.session.agent).toBe("hermes");
  expect(state.session.provider).toBe(SWITCH_PROVIDER);
  expect(state.session.model).toBe(SWITCH_MODEL);
  const publicSwitch = SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER;
  const durableEndpointUrl = publicSwitch
    ? null
    : (switchEndpointUrl ?? process.env.NEMOCLAW_ENDPOINT_URL ?? DEFAULT_HOSTED_INFERENCE_BASE_URL);
  const durableCredentialEnv = publicSwitch
    ? null
    : switchEndpointUrl
      ? "COMPATIBLE_ANTHROPIC_API_KEY"
      : "COMPATIBLE_API_KEY";
  expect(canonicalEndpoint(state.registry.sandboxes?.[SANDBOX_NAME]?.endpointUrl)).toBe(
    canonicalEndpoint(durableEndpointUrl),
  );
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.credentialEnv).toBe(durableCredentialEnv);
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.preferredInferenceApi).toBe(
    publicSwitch ? null : RUNTIME_SWITCH_API,
  );
  expect(state.registry.sandboxes?.[SANDBOX_NAME]?.nimContainer).toBeNull();
  expect(canonicalEndpoint(state.session.endpointUrl)).toBe(
    canonicalEndpoint(publicSwitch ? "https://inference.local/v1" : durableEndpointUrl),
  );
  expect(state.session.credentialEnv).toBe(publicSwitch ? "OPENAI_API_KEY" : durableCredentialEnv);
  expect(state.session.preferredInferenceApi).toBe(RUNTIME_SWITCH_API);
  expect(state.session.nimContainer).toBeNull();

  progress.phase("exercise inference.local and Hermes API");
  const inferenceLocalPayload = JSON.stringify({
    model: SWITCH_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: inferenceLocalMaxTokens(),
  });
  const inferenceLocal = await runHermesPongWithRetry({
    expectedModel: SWITCH_MODEL,
    run: (attempt) =>
      sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(inferenceLocalCommand(inferenceLocalPayload)),
        {
          artifactName: `hermes-inference-local-chat-after-switch-${attempt}`,
          env: env(),
          redactionValues,
          timeoutMs: 120_000,
        },
      ),
  });
  expect(inferenceLocal.exitCode, resultText(inferenceLocal)).toBe(0);
  expect(chatContent(inferenceLocal.stdout)).toMatch(/PONG/i);
  expect(inferenceResponseModel(inferenceLocal.stdout)).toBe(SWITCH_MODEL);

  const hermesApiPayload = JSON.stringify({
    model: SWITCH_MODEL,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 100,
  });
  const chat = await runHermesPongWithRetry({
    expectedModel: SWITCH_MODEL,
    run: (attempt) =>
      sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(hermesApiCommand(hermesApiPayload)),
        {
          artifactName: `hermes-api-chat-after-switch-${attempt}`,
          env: env(),
          redactionValues,
          timeoutMs: 150_000,
        },
      ),
  });
  expect(chat.exitCode, resultText(chat)).toBe(0);
  expect(chatContent(chat.stdout)).toMatch(/PONG/i);
  expect(inferenceResponseModel(chat.stdout)).toBe(SWITCH_MODEL);

  progress.phase("run Hermes CLI against switched provider");
  const hermesCli = await runHermesCliPongWithRetry({
    run: (attempt) =>
      sandbox.exec(SANDBOX_NAME, ["hermes", "-z", "Reply with exactly one word: PONG"], {
        artifactName: `hermes-cli-z-after-switch-${attempt}`,
        env: env(),
        redactionValues,
        timeoutMs: 150_000,
      }),
  });
  expect(hermesCli.exitCode, resultText(hermesCli)).toBe(0);
  expect(hermesCli.stdout).toMatch(/\bPONG\b/iu);
});
