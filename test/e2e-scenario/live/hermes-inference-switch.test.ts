// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-hermes-inference-switch.sh. */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  apiKeyShape,
  chatContent,
  cleanupHermesSwitch,
  ensureCompatibleAnthropicSwitchProvider,
  env,
  envHash,
  expectedApiMode,
  expectedBaseUrl,
  hashCheck,
  hermesApiCommand,
  hermesGatewayPid,
  inferenceLocalCommand,
  inferenceLocalMaxTokens,
  installHermes,
  maybeAssertEnvHashStable,
  maybeAssertPidStable,
  parseHermesModelBlock,
  registryState,
  runHermesInferenceSetWithRetry,
  runHermesPongWithRetry,
  SANDBOX_NAME,
  SWITCH_API,
  SWITCH_MODEL,
  SWITCH_PROVIDER,
  strictHashPerms,
} from "./hermes-inference-switch-helpers.ts";

const TIMEOUT_MS = 45 * 60_000;

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Hermes inference set updates route/config and preserves live runtime",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    await artifacts.writeJson("scenario.json", {
      id: "hermes-inference-switch",
      legacySource: "test/e2e/test-hermes-inference-switch.sh",
      boundary: "install.sh + Hermes sandbox + inference set + in-sandbox health/chat probes",
      sandboxName: SANDBOX_NAME,
      switchProvider: SWITCH_PROVIDER,
      switchModel: SWITCH_MODEL,
      switchApi: SWITCH_API,
    });

    cleanup.add("destroy Hermes inference switch sandbox", () =>
      cleanupHermesSwitch(host, sandbox),
    );
    await cleanupHermesSwitch(host, sandbox);

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const install = await installHermes(host, apiKey);
    expect(install.exitCode, resultText(install)).toBe(0);
    const switchEndpointUrl = await ensureCompatibleAnthropicSwitchProvider(host, cleanup);

    const pidBefore = await hermesGatewayPid(sandbox, "pid-before");
    const envHashBefore = await envHash(sandbox, "env-hash-before");

    const compatibleMetadataArgs = switchEndpointUrl
      ? [
          "--endpoint-url",
          switchEndpointUrl,
          "--credential-env",
          "COMPATIBLE_ANTHROPIC_API_KEY",
          "--inference-api",
          SWITCH_API,
        ]
      : [];
    const switched = await runHermesInferenceSetWithRetry(host, apiKey, compatibleMetadataArgs);
    expect(switched.exitCode, resultText(switched)).toBe(0);

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
    expect(resultText(route)).toContain(SWITCH_PROVIDER);
    expect(resultText(route)).toContain(SWITCH_MODEL);

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/config.yaml"], {
      artifactName: "hermes-config-yaml",
      env: env(),
      redactionValues: [apiKey],
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

    const inferenceLocalPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: inferenceLocalMaxTokens(),
    });
    const inferenceLocal = await runHermesPongWithRetry({
      run: (attempt) =>
        sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(inferenceLocalCommand(inferenceLocalPayload)),
          {
            artifactName: `hermes-inference-local-chat-after-switch-${attempt}`,
            env: env(),
            redactionValues: [apiKey],
            timeoutMs: 120_000,
          },
        ),
    });
    expect(inferenceLocal.exitCode, resultText(inferenceLocal)).toBe(0);
    expect(chatContent(inferenceLocal.stdout)).toMatch(/PONG/i);

    const hermesApiPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const chat = await runHermesPongWithRetry({
      run: (attempt) =>
        sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(hermesApiCommand(hermesApiPayload)),
          {
            artifactName: `hermes-api-chat-after-switch-${attempt}`,
            env: env(),
            redactionValues: [apiKey],
            timeoutMs: 150_000,
          },
        ),
    });
    expect(chat.exitCode, resultText(chat)).toBe(0);
    expect(chatContent(chat.stdout)).toMatch(/PONG/i);
  },
);
