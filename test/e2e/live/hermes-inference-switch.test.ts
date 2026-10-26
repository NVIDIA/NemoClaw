// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
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
  CLI,
  compatibleAnthropicMetadataArgs,
  env,
  envHash,
  expectAuthenticatedBaselineInventoryRequest,
  expectNativeLocalHermesTurn,
  expectAuthenticatedProxyResolutionRequests,
  expectOpenAiProvider,
  hasAuthenticatedProxyResolutionRequest,
  hashCheck,
  hermesApiCommand,
  hermesGatewayPid,
  hostedInstallModel,
  sandboxInferenceCommand,
  inferenceLocalMaxTokens,
  installHermes,
  maybeAssertEnvHashStable,
  parseHermesGatewayPid,
  PROXY_FORBIDDEN_MARKERS,
  PROXY_RESOLUTION_PROVIDER,
  parseInferenceRoute,
  prepareCompatibleAnthropicSwitchBinding,
  prepareProxyResolutionRoute,
  RUNTIME_SWITCH_API,
  registryState,
  runHermesCliPongWithRetry,
  runHermesNvidiaDiscordRebuild,
  runHermesInferenceSetWithRetry,
  runHermesPongWithRetry,
  SANDBOX_NAME,
  SWITCH_API,
  SWITCH_MODEL,
  SWITCH_PROVIDER,
  strictHashPerms,
  useLocalHermesInferenceBaseline,
} from "./hermes-inference-switch-helpers.ts";
import {
  acceptedSwitchResponseModels,
  PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  readPublicNvidiaSwitchAttachmentEvidence,
  requirePublicNvidiaSwitchKey,
} from "./public-nvidia-switch-provider.ts";

const TIMEOUT_MS = testTimeout(45 * 60_000);
const MOCK_BASELINE_API_KEY = "hermes-inference-switch-baseline-credential";
const MOCK_BASELINE_MODEL = "hermes-inference-switch-baseline-model";
const HERMES_DASHBOARD_INTERNAL_PORT =
  process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ?? "19119";

function canonicalEndpoint(value: unknown): string | null {
  return typeof value === "string" ? new URL(value).toString() : null;
}

test(
  "Hermes inference set updates route/config and preserves live runtime",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean Hermes inference sandbox",
        "install baseline Hermes runtime",
        "prove native local Hermes startup and model switch",
        "switch Hermes inference provider",
        "validate switched route and mutable config",
        "exercise sandbox inference and Hermes API",
        "run Hermes CLI adapter forms against switched provider",
        "verify NVIDIA inference after Discord state rebuild",
        "prove split provider/model credential resolution",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    await artifacts.target.declare({
      id: "hermes-inference-switch",
      boundary:
        "install.sh + Hermes sandbox + inference set + in-sandbox health/chat + managed Hermes CLI probes",
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

    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info",
      scenarioLabel: "Hermes inference switch",
    });

    // OpenShell reaches this fixture from its gateway network namespace, where
    // the runner's loopback address is not routable.
    const mockBaseline = useLocalHermesInferenceBaseline()
      ? await startFakeOpenAiCompatibleServer({
          apiKey: MOCK_BASELINE_API_KEY,
          chatContent: "PONG",
          forbiddenMarkers: PROXY_FORBIDDEN_MARKERS,
          host: "0.0.0.0",
          model: MOCK_BASELINE_MODEL,
          port: 11434,
          publicHost: "host.openshell.internal",
          progress,
          requireAuth: true,
          requireAuthModels: true,
        })
      : undefined;
    cleanup.trackDisposable("close Hermes inference switch baseline fixture", async () => {
      await artifacts.writeJson(
        "baseline-openai-compatible-requests.json",
        mockBaseline?.requests() ?? [],
      );
      await mockBaseline?.close();
    });
    const publicApiKey =
      SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
        ? requirePublicNvidiaSwitchKey(secrets.required("NVIDIA_API_KEY"))
        : null;
    const apiKey = mockBaseline
      ? MOCK_BASELINE_API_KEY
      : (publicApiKey ?? secrets.required("NVIDIA_INFERENCE_API_KEY"));
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
    await host.recordSandboxContainerDiscoveryOnFailure(
      SANDBOX_NAME,
      install.exitCode,
      redactionValues,
    );
    expect(install.exitCode, resultText(install)).toBe(0);
    expectAuthenticatedBaselineInventoryRequest(mockBaseline);
    const baselineRoute = await host.command("node", [CLI, "inference", "get"], {
      artifactName: "nemoclaw-native-inference-route-before-switch",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(baselineRoute.exitCode, resultText(baselineRoute)).toBe(0);
    expect(parseInferenceRoute(resultText(baselineRoute))).toEqual({
      provider: mockBaseline ? "compatible-endpoint" : PUBLIC_NVIDIA_SWITCH_PROVIDER,
      model: hostedInstallModel(env(apiKey, installEnv)),
    });
    progress.phase("prove native local Hermes startup and model switch");
    mockBaseline &&
      (await expectNativeLocalHermesTurn({
        sandbox,
        endpoint: mockBaseline,
        model: MOCK_BASELINE_MODEL,
        artifactName: "hermes-native-local-startup",
        redactionValues,
        onEvidence: async (evidence) => {
          await artifacts.writeJson("retry/hermes-native-local-startup.json", evidence);
        },
      }));
    const localModel = `${MOCK_BASELINE_MODEL}-switched`;
    const localSwitch =
      mockBaseline &&
      (await host.command(
        "node",
        [
          CLI,
          "inference",
          "set",
          "--sandbox",
          SANDBOX_NAME,
          "--provider",
          "compatible-endpoint",
          "--model",
          localModel,
          "--no-verify",
        ],
        {
          artifactName: "hermes-native-local-model-switch",
          env: env(),
          redactionValues,
          timeoutMs: 180_000,
        },
      ));
    localSwitch && expect(localSwitch.exitCode, resultText(localSwitch)).toBe(0);
    mockBaseline &&
      (await expectNativeLocalHermesTurn({
        sandbox,
        endpoint: mockBaseline,
        model: localModel,
        artifactName: "hermes-native-local-after-model-switch",
        redactionValues,
        onEvidence: async (evidence) => {
          await artifacts.writeJson("retry/hermes-native-local-after-model-switch.json", evidence);
        },
      }));
    const baselineState = registryState();
    const baselineSession = structuredClone(baselineState.session);
    const switchBinding = await prepareCompatibleAnthropicSwitchBinding(host, cleanup);
    const switchEndpointUrl = switchBinding?.endpointUrl ?? null;
    switchBinding && redactionValues.push(switchBinding.credentialValue);

    const pidBefore = await hermesGatewayPid(sandbox, "pid-before");
    expect(parseHermesGatewayPid(pidBefore), resultText(pidBefore)).toBeDefined();
    const envHashBefore = await envHash(sandbox, "env-hash-before");

    progress.phase("switch Hermes inference provider");
    const compatibleMetadataArgs = compatibleAnthropicMetadataArgs(switchEndpointUrl);
    const switched = await runHermesInferenceSetWithRetry(
      host,
      redactionValues,
      compatibleMetadataArgs,
      {
        artifacts,
        compatibleBinding: switchBinding,
        publicNvidiaApiKey: publicApiKey,
      },
    );
    expect(switched.exitCode, resultText(switched)).toBe(0);
    switchBinding &&
      (await expectOpenAiProvider(
        host,
        "compatible-anthropic-endpoint",
        "COMPATIBLE_ANTHROPIC_API_KEY",
      ));

    progress.phase("validate switched route and mutable config");
    const pidAfter = await hermesGatewayPid(sandbox, "pid-after");
    expect(parseHermesGatewayPid(pidAfter), resultText(pidAfter)).toBeDefined();
    expect(pidAfter.stdout.trim() !== pidBefore.stdout.trim()).toBe(
      Boolean(mockBaseline) || SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER,
    );

    const health = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-sf", "--max-time", "10", "http://localhost:8642/health"],
      {
        artifactName: "hermes-health-after-switch",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(health.exitCode, resultText(health)).toBe(0);
    expect(resultText(health)).toMatch(/ok/i);

    const route = await host.command("node", [CLI, "inference", "get"], {
      artifactName: "nemoclaw-inference-route",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(route.exitCode, resultText(route)).toBe(0);
    expect(parseInferenceRoute(resultText(route))).toEqual({
      provider: SWITCH_PROVIDER,
      model: SWITCH_MODEL,
    });

    const config = await sandbox.exec(
      SANDBOX_NAME,
      ["sed", "/^[[:space:]]*api_key:/d", "/sandbox/.hermes/config.yaml"],
      {
        artifactName: "hermes-config-yaml",
        env: env(),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expect(config.exitCode, resultText(config)).toBe(0);
    // Field projection is covered by inference-set-patch-hermes and config generation
    // tests. Live dashboard, API, and CLI turns below verify the selected route.
    expect((await apiKeyShape(sandbox)).exitCode).toBe(0);

    const dashboardShadowConfig = await sandbox.exec(
      SANDBOX_NAME,
      ["test", "!", "-e", "/sandbox/.hermes/profiles/dashboard-home/config.yaml"],
      {
        artifactName: "hermes-dashboard-shadow-config-absent-after-switch",
        env: env(),
        timeoutMs: 30_000,
      },
    );
    expect(dashboardShadowConfig.exitCode, resultText(dashboardShadowConfig)).toBe(0);

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
    expect(JSON.parse(dashboardModelInfo.stdout)).toMatchObject({
      model: SWITCH_MODEL,
    });

    const strictHash = await hashCheck(sandbox, "/etc/nemoclaw/hermes.config-hash", "strict");
    expect(strictHash.exitCode, resultText(strictHash)).toBe(0);
    const compatHash = await hashCheck(sandbox, "/sandbox/.hermes/.config-hash", "compat");
    expect(compatHash.exitCode, resultText(compatHash)).toBe(0);
    const strictPerms = await strictHashPerms(sandbox);
    expect(strictPerms.stdout.trim()).toMatch(/^0\s+[0-7]+$/u);
    expect(Number.parseInt(strictPerms.stdout.trim().split(/\s+/u)[1], 8) & 0o222).toBe(0);

    maybeAssertEnvHashStable(
      envHashBefore,
      await envHash(sandbox, "env-hash-after"),
      (actual, expected) => expect(actual).toBe(expected),
    );

    const state = registryState();
    const attachmentEvidence = await readPublicNvidiaSwitchAttachmentEvidence({
      artifactName: "hermes-native-nvidia-provider-attachment",
      env: env(),
      logicalProvider: SWITCH_PROVIDER,
      receipt: state.registry.sandboxes?.[SANDBOX_NAME]?.nativeNvidiaProviderAttachment,
      sandbox,
      sandboxName: SANDBOX_NAME,
    });
    expect(
      [
        state.registry.sandboxes?.[SANDBOX_NAME]?.agent,
        attachmentEvidence,
        state.registry.sandboxes?.[SANDBOX_NAME]?.model,
        state.registry.sandboxes?.[SANDBOX_NAME]?.provider,
      ]
        .map(String)
        .join("\n"),
    ).toBe(
      [
        "hermes",
        SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
          ? PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE
          : null,
        SWITCH_MODEL,
        SWITCH_PROVIDER,
      ]
        .map(String)
        .join("\n"),
    );
    expect(state.session).toEqual(baselineSession);
    const publicSwitch = SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER;
    const durableEndpointUrl = publicSwitch
      ? null
      : (switchEndpointUrl ??
        process.env.NEMOCLAW_ENDPOINT_URL ??
        DEFAULT_HOSTED_INFERENCE_BASE_URL);
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
    progress.phase("exercise sandbox inference and Hermes API");
    const inferenceLocalPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: inferenceLocalMaxTokens(),
    });
    const inferenceLocal = await runHermesPongWithRetry({
      expectedModel: SWITCH_MODEL,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-sandbox-inference-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(sandboxInferenceCommand(inferenceLocalPayload)),
          {
            artifactName: `hermes-sandbox-inference-chat-after-switch-${attempt}`,
            env: env(),
            redactionValues,
            timeoutMs: 120_000,
          },
        ),
    });
    expect(inferenceLocal.exitCode, resultText(inferenceLocal)).toBe(0);
    expect(chatContent(inferenceLocal.stdout)).toMatch(/PONG/i);
    expect(acceptedSwitchResponseModels(SWITCH_MODEL)).toContain(
      inferenceResponseModel(inferenceLocal.stdout),
    );

    const hermesApiPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const chat = await runHermesPongWithRetry({
      expectedModel: SWITCH_MODEL,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-api-after-switch.json", evidence);
      },
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
    expect(acceptedSwitchResponseModels(SWITCH_MODEL)).toContain(
      inferenceResponseModel(chat.stdout),
    );

    progress.phase("run Hermes CLI adapter forms against switched provider");
    const hermesCli = await runHermesCliPongWithRetry({
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-cli-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.exec(
          SANDBOX_NAME,
          [
            "hermes",
            "-z",
            "Reply with exactly one word: PONG",
            "--provider",
            SWITCH_PROVIDER,
            "--model",
            SWITCH_MODEL,
          ],
          {
            artifactName: `hermes-cli-split-provider-model-after-switch-${attempt}`,
            env: env(),
            redactionValues,
            timeoutMs: 150_000,
          },
        ),
    });
    expect(hermesCli.exitCode, resultText(hermesCli)).toBe(0);
    expect(hermesCli.stdout).toMatch(/\bPONG\b/iu);

    await runHermesNvidiaDiscordRebuild({
      host,
      sandbox,
      progress,
      publicApiKey,
      redactionValues,
    });

    progress.phase("prove split provider/model credential resolution");
    const { model: proxyResolutionModel, requestOffset } = await prepareProxyResolutionRoute({
      apiKey,
      host,
      mockBaseline,
      redactionValues,
    });
    const persistedProxyRoute = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: "proxy-resolution-route-after-set",
      env: env(),
      redactionValues,
      timeoutMs: 30_000,
    });
    expect(persistedProxyRoute.exitCode, resultText(persistedProxyRoute)).toBe(0);
    expect(parseInferenceRoute(persistedProxyRoute.stdout)).toEqual({
      provider: PROXY_RESOLUTION_PROVIDER,
      model: proxyResolutionModel,
    });

    const proxyResolutionCli = await runHermesCliPongWithRetry({
      accept: () =>
        hasAuthenticatedProxyResolutionRequest(mockBaseline, requestOffset, proxyResolutionModel),
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-cli-proxy-resolution-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.exec(
          SANDBOX_NAME,
          [
            "hermes",
            "chat",
            "--query",
            "Reply with exactly one word: PONG",
            "--quiet",
            "--provider",
            PROXY_RESOLUTION_PROVIDER,
            "--model",
            proxyResolutionModel,
          ],
          {
            artifactName: `hermes-cli-chat-split-provider-namespaced-model-proxy-resolution-${attempt}`,
            env: env(),
            redactionValues,
            timeoutMs: 150_000,
          },
        ),
    });
    expect(proxyResolutionCli.exitCode, resultText(proxyResolutionCli)).toBe(0);
    expect(proxyResolutionCli.stdout).toMatch(/\bPONG\b/iu);

    expectAuthenticatedProxyResolutionRequests(mockBaseline, requestOffset, proxyResolutionModel);
  },
);
