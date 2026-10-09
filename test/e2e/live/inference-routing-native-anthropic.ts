// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeCustomProviderAttachment } from "../../../src/lib/inference/native-custom/index.ts";
import { ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, type E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { startFakeAnthropicCompatibleServer } from "../fixtures/fake-anthropic-compatible.ts";
import { hostedInferenceCredentialReferencePattern } from "../fixtures/hosted-inference.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { approveOpenClawAdminScope } from "./openclaw-admin-scope.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  onboardSandbox,
} from "./inference-routing-helpers.ts";

/** TC-INF-11's native Anthropic boundary, sharing its owned public address. */
export async function verifyFreshNativeAnthropicEndpoint(
  fixtures: E2ETargetFixtures,
  options: { sandboxName: string; apiKey: string; publicHttpAddress: string },
) {
  const { artifacts, cleanup, host, progress, sandbox } = fixtures;
  const { sandboxName, apiKey, publicHttpAddress } = options;
  const anthropicModel = "native-anthropic-model";
  const anthropic = await startFakeAnthropicCompatibleServer({
    apiKey,
    model: anthropicModel,
    publicHost: publicHttpAddress,
  });
  cleanup.add("close native Anthropic endpoint", async () => {
    try {
      await artifacts.writeJson("tc-inf-11-native-anthropic-requests.json", anthropic.requests());
    } finally {
      await anthropic.close();
    }
  });
  const anthropicOnboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_ANTHROPIC_API_KEY: apiKey,
      NEMOCLAW_ENDPOINT_URL: anthropic.endpointUrl,
      NEMOCLAW_MODEL: anthropicModel,
      NEMOCLAW_PREFERRED_API: "anthropic-messages",
      NEMOCLAW_PROVIDER: "anthropicCompatible",
    },
    [apiKey],
    "tc-inf-11-onboard-native-anthropic",
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  expectOnboardSuccess(anthropicOnboard, "TC-INF-11 fresh native Anthropic onboard");
  const anthropicReceipt = normalizeNativeCustomProviderAttachment(
    getSandbox(sandboxName)?.nativeCustomProviderAttachment,
    sandboxName,
  )!;
  expect(anthropicReceipt).toMatchObject({
    api: "anthropic-messages",
    endpointUrl: anthropic.endpointUrl,
  });
  expect(anthropicReceipt.transport).toBeUndefined();
  const anthropicConfig = await sandbox.exec(
    sandboxName,
    ["cat", "/sandbox/.openclaw/openclaw.json"],
    {
      artifactName: "tc-inf-11-native-anthropic-config",
      timeoutMs: 30_000,
      redactionValues: [apiKey],
    },
  );
  expect(anthropicConfig.exitCode, resultText(anthropicConfig)).toBe(0);
  const nativeAnthropicProvider = JSON.parse(anthropicConfig.stdout).models.providers.inference;
  expect(nativeAnthropicProvider).toMatchObject({
    api: "anthropic-messages",
    baseUrl: anthropic.endpointUrl,
  });
  expect(nativeAnthropicProvider.apiKey).toMatch(
    hostedInferenceCredentialReferencePattern("COMPATIBLE_ANTHROPIC_API_KEY"),
  );
  expect(anthropicConfig.stdout).not.toContain("inference.local");
  expect(anthropicConfig.stdout).not.toContain(apiKey);
  await approveOpenClawAdminScope(
    host,
    sandbox,
    sandboxName,
    buildAvailabilityProbeEnv(),
    [apiKey],
    false,
  );
  const anthropicRequestOffset = anthropic.requests().length;
  const anthropicTurn = await sandbox.exec(
    sandboxName,
    [
      "nemoclaw-start",
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      `native-anthropic-${Date.now()}`,
      "-m",
      "Reply with only: PONG",
    ],
    {
      artifactName: "tc-inf-11-native-anthropic-agent-turn",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 240_000,
    },
  );
  expect(anthropicTurn.exitCode, resultText(anthropicTurn)).toBe(0);
  expect(parseOpenClawAgentText(anthropicTurn.stdout).trim()).toBe("PONG");
  expect(
    anthropic
      .requests()
      .slice(anthropicRequestOffset)
      .some(
        (request) =>
          request.authenticated &&
          request.path === "/v1/messages" &&
          request.model === anthropicModel,
      ),
  ).toBe(true);
  await cleanupSandbox(host, sandbox, sandboxName, { strict: true });
  const anthropicProviderAfterDestroy = await sandbox.openshell(
    ["provider", "get", anthropicReceipt.providerName],
    {
      artifactName: "tc-inf-11-anthropic-provider-absent-after-destroy",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(
    anthropicProviderAfterDestroy.exitCode,
    resultText(anthropicProviderAfterDestroy),
  ).not.toBe(0);
  expect(resultText(anthropicProviderAfterDestroy)).toMatch(
    /\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu,
  );
  await artifacts.writeJson("tc-inf-11-native-anthropic-receipt.json", anthropicReceipt);
}
