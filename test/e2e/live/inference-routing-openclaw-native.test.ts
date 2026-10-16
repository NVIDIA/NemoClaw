// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  OPENCLAW_NATIVE_LOCAL_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { sandboxAccessEnv } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  onboardNativeOpenClaw,
  requestNativeOpenClaw,
} from "../fixtures/inference-routing-openclaw-native.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { assertAgentExecutionSucceeded } from "./gpu-e2e-helpers.ts";
import { hostedCredentialScanCommand } from "./inference-routing-credential-scan.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  inferenceSandboxName,
  onboardSandbox,
} from "./inference-routing-helpers.ts";

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

test(
  "TC-INF-17 OpenClaw uses authenticated native local inference after rebuild and restart (#12975)",
  {
    timeout: OPENCLAW_NATIVE_LOCAL_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "onboard native OpenClaw owner",
        "rebuild native OpenClaw owner",
        "restart native OpenClaw owner",
        "onboard shared-route sibling",
        "record shared route before model switch",
        "switch native OpenClaw model",
        "verify shared route unchanged",
        "request inference through OpenClaw",
        "check credential isolation",
        "verify owner reachability",
        "verify sibling denial",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("onboard native OpenClaw owner");
    const selected = await onboardNativeOpenClaw(true, {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
    });
    const { owner, model, switchedModel, apiKey, fake, onboard, attachment } = selected;
    expectOnboardSuccess(onboard, `${owner} onboard`);
    expect(attachment).toMatchObject({
      agent: "openclaw",
      provider: "llama-cpp-local",
      authMode: "authenticated",
    });
    progress.phase("rebuild native OpenClaw owner");
    const rebuild = await host.nemoclaw([owner, "rebuild", "--yes", "--verbose"], {
      artifactName: `${owner}-rebuild`,
      env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey },
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    });
    expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
    progress.phase("restart native OpenClaw owner");
    const stop = await host.nemoclaw([owner, "stop"], {
      artifactName: `${owner}-stop`,
      env: sandboxAccessEnv(),
      timeoutMs: 120_000,
    });
    expect(stop.exitCode, resultText(stop)).toBe(0);
    const start = await host.nemoclaw([owner, "start"], {
      artifactName: `${owner}-start`,
      env: sandboxAccessEnv(),
      timeoutMs: 120_000,
    });
    expect(start.exitCode, resultText(start)).toBe(0);
    progress.phase("onboard shared-route sibling");
    const sibling = inferenceSandboxName("e2e-oc-peer");
    const peerEndpoint = await startFakeOpenAiCompatibleServer({
      apiKey,
      model,
      host: "0.0.0.0",
      publicHost: "host.openshell.internal",
      requireAuth: true,
      progress,
    });
    cleanup.add(`close ${sibling} endpoint`, () => peerEndpoint.close());
    cleanup.add(`remove ${sibling}`, () =>
      cleanupSandbox(host, sandbox, sibling, { strict: true }),
    );
    await cleanupSandbox(host, sandbox, sibling);
    const peer = await onboardSandbox(
      artifacts,
      sibling,
      {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_MODEL: model,
        NEMOCLAW_ENDPOINT_URL: peerEndpoint.baseUrl,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        COMPATIBLE_API_KEY: apiKey,
      },
      [apiKey],
      `${sibling}-onboard`,
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    expectOnboardSuccess(peer, `${sibling} onboard`);
    progress.phase("record shared route before model switch");
    const sharedBefore = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: `${owner}-shared-route-before-switch`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(sharedBefore.exitCode, resultText(sharedBefore)).toBe(0);
    progress.phase("switch native OpenClaw model");
    const switched = await host.nemoclaw(
      ["inference", "set", "--provider", "llama-cpp", "--model", switchedModel, "--sandbox", owner],
      {
        artifactName: `${owner}-model-switch`,
        env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey },
        redactionValues: [apiKey],
        timeoutMs: 5 * 60_000,
      },
    );
    expect(switched.exitCode, resultText(switched)).toBe(0);
    progress.phase("verify shared route unchanged");
    const sharedAfter = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: `${owner}-shared-route-after-switch`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(sharedAfter.exitCode).toBe(sharedBefore.exitCode);
    expect(sharedAfter.stdout).toBe(sharedBefore.stdout);
    progress.phase("request inference through OpenClaw");
    const { turn, requests } = await requestNativeOpenClaw(
      owner,
      apiKey,
      fake,
      host,
      switchedModel,
    );
    expect(turn.exitCode, resultText(turn)).toBe(0);
    assertAgentExecutionSucceeded(turn.stdout, "inference", switchedModel);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.some((request) => request.path === "/v1/chat/completions" && request.auth === "ok"),
    ).toBe(true);
    expect(requests.some((request) => request.authorizationSent)).toBe(true);
    progress.phase("check credential isolation");
    const scan = await sandbox.exec(owner, hostedCredentialScanCommand(apiKey), {
      artifactName: `${owner}-credential-scan`,
      env: sandboxAccessEnv(),
      timeoutMs: 60_000,
      redactionValues: [apiKey],
    });
    expect(scan.exitCode, resultText(scan)).toBe(0);
    expect(JSON.parse(scan.stdout)).toMatchObject({
      environmentClean: true,
      processesClean: true,
      sampledFilesClean: true,
      canaryDetected: true,
    });
    progress.phase("verify owner reachability");
    const beforeOwnerProbe = fake.requests().length;
    const ownerProbe = await sandbox.exec(
      owner,
      [
        "curl",
        "--fail",
        "--max-time",
        "15",
        "--header",
        `Authorization: Bearer ${apiKey}`,
        `${attachment!.endpointUrl}/models`,
      ],
      {
        artifactName: `${owner}-owner-reachability`,
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
        redactionValues: [apiKey],
      },
    );
    expect(ownerProbe.exitCode, resultText(ownerProbe)).toBe(0);
    expect(
      fake
        .requests()
        .slice(beforeOwnerProbe)
        .some((request) => request.path.endsWith("/models") && request.auth === "ok"),
    ).toBe(true);
    progress.phase("verify sibling denial");
    const beforeDenied = fake.requests().length;
    const denied = await sandbox.exec(
      sibling,
      [
        "curl",
        "--fail",
        "--max-time",
        "15",
        "--header",
        `Authorization: Bearer ${apiKey}`,
        `${attachment!.endpointUrl}/models`,
      ],
      {
        artifactName: `${sibling}-owner-denial`,
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
        redactionValues: [apiKey],
      },
    );
    expect(denied.exitCode).not.toBe(0);
    expect(fake.requests()).toHaveLength(beforeDenied);
  },
);

test(
  "TC-INF-18 OpenClaw uses a credentialless native local vLLM endpoint (#12975)",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "onboard native OpenClaw owner",
        "request inference through OpenClaw",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("onboard native OpenClaw owner");
    const { owner, apiKey, fake, onboard, attachment } = await onboardNativeOpenClaw(false, {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
    });
    expectOnboardSuccess(onboard, `${owner} onboard`);
    expect(attachment).toMatchObject({
      agent: "openclaw",
      provider: "vllm-local",
      authMode: "sentinel",
    });
    progress.phase("request inference through OpenClaw");
    const { turn, requests } = await requestNativeOpenClaw(owner, apiKey, fake, host);
    expect(turn.exitCode, resultText(turn)).toBe(0);
    assertAgentExecutionSucceeded(turn.stdout, "inference", "nemoclaw-openclaw-native-local");
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.some(
        (request) =>
          request.path === "/v1/chat/completions" &&
          request.auth === "ok" &&
          request.authorizationSent === true,
      ),
    ).toBe(true);
    expect(requests.every((request) => request.auth === "ok")).toBe(true);
  },
);
