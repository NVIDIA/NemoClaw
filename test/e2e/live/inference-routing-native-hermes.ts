// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeCustomProviderAttachment } from "../../../src/lib/inference/native-custom/index.ts";
import { ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { expect, type E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import type { FakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  inferenceSandboxName,
  onboardSandbox,
  redactedResultText,
  runNemoclawCli,
} from "./inference-routing-helpers.ts";

/** Ordinary native Hermes routing, sharing TC-INF-11's authenticated public fixture. */
export async function verifyFreshNativeHermesEndpoint(
  fixtures: E2ETargetFixtures,
  options: { endpoint: FakeOpenAiCompatibleServer; apiKey: string; model: string },
) {
  const { artifacts, cleanup, host, progress, sandbox } = fixtures;
  const { endpoint, apiKey, model } = options;
  const sandboxName = inferenceSandboxName("e2e-native-hermes");
  cleanup.add(`strict native Hermes cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: endpoint.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      COMPATIBLE_API_KEY: apiKey,
    },
    [apiKey],
    "tc-inf-11-onboard-native-hermes",
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  expectOnboardSuccess(onboard, "TC-INF-11 ordinary native Hermes onboard");
  const receipt = normalizeNativeCustomProviderAttachment(
    getSandbox(sandboxName)?.nativeCustomProviderAttachment,
    sandboxName,
  )!;
  expect(receipt).toMatchObject({ api: "openai-completions", endpointUrl: endpoint.baseUrl });
  const restartEnv = buildAvailabilityProbeEnv();
  delete restartEnv.COMPATIBLE_API_KEY;
  for (const [action, timeoutMs] of [
    ["stop", 120_000],
    ["start", 240_000],
  ] as const) {
    const restarted = await runNemoclawCli([sandboxName, action], {
      artifactName: `tc-inf-11-native-hermes-${action}`,
      artifacts,
      env: restartEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs,
    });
    expect(restarted.exitCode, redactedResultText(restarted)).toBe(0);
  }
  const config = await sandbox.exec(
    sandboxName,
    [
      "python3",
      "-c",
      "import json,yaml; c=yaml.safe_load(open('/sandbox/.hermes/config.yaml')); print(json.dumps({'model':c['model'],'custom_providers':c['custom_providers']}))",
    ],
    {
      artifactName: "tc-inf-11-native-hermes-config-after-restart",
      env: restartEnv,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(config.exitCode, resultText(config)).toBe(0);
  const saved = JSON.parse(config.stdout);
  expect(saved.model).toMatchObject({ default: model, base_url: endpoint.baseUrl });
  expect(saved.model.api_key).toMatch(
    /^sk-OPENSHELL-RESOLVE-ENV-(?:v[0-9]{1,20}|s[a-f0-9]{64})_COMPATIBLE_API_KEY$/u,
  );
  expect(config.stdout).not.toContain("inference.local");
  expect(config.stdout).not.toContain(apiKey);
  const offset = endpoint.requests().length;
  const payload = shellQuote(
    JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 32,
      stream: false,
    }),
  );
  const chat = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-lc",
      "set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; " +
        `if [ -n "\${API_SERVER_KEY:-}" ]; then curl -fsS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY}" -d ${payload}; ` +
        `else curl -fsS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d ${payload}; fi`,
    ],
    {
      artifactName: "tc-inf-11-native-hermes-fresh-agent-turn",
      env: restartEnv,
      redactionValues: [apiKey],
      timeoutMs: 180_000,
    },
  );
  expect(chat.exitCode, resultText(chat)).toBe(0);
  expect(JSON.parse(chat.stdout).choices?.[0]?.message?.content?.trim()).toBe("PONG");
  expect(
    endpoint
      .requests()
      .slice(offset)
      .some(
        (request) =>
          request.auth === "ok" &&
          request.method === "POST" &&
          request.path === "/v1/chat/completions" &&
          request.model === model,
      ),
  ).toBe(true);
  await cleanupSandbox(host, sandbox, sandboxName, { strict: true });
  const absent = await sandbox.openshell(["provider", "get", receipt.providerName], {
    artifactName: "tc-inf-11-native-hermes-provider-absent",
    env: restartEnv,
    timeoutMs: 30_000,
  });
  expect(absent.exitCode, resultText(absent)).not.toBe(0);
  expect(resultText(absent)).toMatch(/\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu);
  await artifacts.writeJson("tc-inf-11-native-hermes-receipt.json", receipt);
}
