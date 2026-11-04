// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeLocalProviderAttachment } from "../../../src/lib/inference/native-local/contract.ts";
import { resolveModelRouterLogPath } from "../../../src/lib/onboard/model-router.ts";
import { DEFAULT_GATEWAY_PORT, parsePort } from "../../../src/lib/core/ports.ts";
import { nativeLocalChatCommand } from "../fixtures/native-local-chat.ts";
import { sandboxAccessEnv, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { hostedCredentialScanCommand } from "./inference-routing-credential-scan.ts";
import { execTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requirePublicNvidiaInferenceKey } from "../fixtures/inference-adapter.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import {
  buildProviderRoutedEnv,
  registerRouterDiagnostics,
  routerSelectionsSince,
  ROUTER_LIGHTNING,
  ROUTER_SUPER_VL,
} from "./model-router-provider-routed-inference-helpers.ts";

// Live owner: real OpenClaw requests across its scoped native attachment.
// Deterministic selection and denial behavior belongs to the policy integration tests.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-model-router";
const ONBOARD_TIMEOUT_MS = execTimeout(25 * 60_000);

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

test(
  "Model Router routes native OpenClaw text, explicit selections, and images (#14066)",
  {
    meta: {
      e2ePhases: [
        "confirm routed-provider prerequisites",
        "clear the previous routed-provider sandbox",
        "onboard the routed provider",
        "request native routed agent completions",
        "record the routed inference contract result",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, runtimeProvider, secrets }) => {
    progress.phase("confirm routed-provider prerequisites");
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-model-router-provider-routed",
      scenarioLabel: "provider-routed Model Router onboarding",
    });

    const apiKey = requirePublicNvidiaInferenceKey(secrets.required("NVIDIA_API_KEY"));

    await artifacts.target.declare({
      id: "model-router-provider-routed-inference",
      boundary: "direct-cli-onboard-and-sandbox-exec",
      contract: [
        "the selected runtime is available before onboarding",
        "NVIDIA_API_KEY is present and nvapi-prefixed, then staged for the router's NVIDIA_INFERENCE_API_KEY credential",
        "nemoclaw onboard --fresh completes with NEMOCLAW_PROVIDER=routed",
        "native OpenClaw text reaches Lightning, explicit SuperVL reaches SuperVL, and images reach SuperVL",
        "the native endpoint preserves streaming and structured tool calls",
        "raw credentials remain outside sandbox observations and cleanup confirms sandbox absence",
      ],
    });

    progress.phase("clear the previous routed-provider sandbox");
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-model-router-provider-routed",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });

    cleanup.add("destroy routed sandbox and confirm absence", async () => {
      await host.cleanupSandbox(SANDBOX_NAME, {
        preserveGatewayRegistration: true,
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 120_000,
      });
      await sandbox.expectAbsent(SANDBOX_NAME, {
        env: sandboxAccessEnv(),
        timeoutMs: 30_000,
      });
    });

    const onboardEnv = buildProviderRoutedEnv(apiKey, SANDBOX_NAME);
    registerRouterDiagnostics(cleanup, artifacts, onboardEnv);

    progress.phase("onboard the routed provider");
    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "onboard-model-router-provider-routed",
        env: onboardEnv,
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    await host.recordSandboxContainerDiscoveryOnFailure(SANDBOX_NAME, onboard.exitCode, [apiKey]);
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    await sandbox.waitForInitialOpenClawPairing(SANDBOX_NAME, {
      env: sandboxAccessEnv(),
      redactionValues: [apiKey],
    });
    progress.phase("request native routed agent completions");
    const attachment = normalizeNativeLocalProviderAttachment(
      getSandbox(SANDBOX_NAME)?.nativeLocalProviderAttachment,
    );
    const logPath = resolveModelRouterLogPath(
      undefined,
      parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, onboardEnv),
    );
    // Synthetic 1x1 PNG; no user images enter the endpoint.
    const redImage =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=";
    {
      const offset = fs.statSync(logPath).size;
      const id = randomUUID();
      const turn = await sandbox.exec(
        SANDBOX_NAME,
        [
          "openclaw",
          "gateway",
          "call",
          "agent",
          "--json",
          "--expect-final",
          "--timeout",
          "180000",
          "--params",
          JSON.stringify({
            agentId: "main",
            sessionKey: `agent:main:router-${id}`,
            idempotencyKey: id,
            model: "nvidia-routed",
            provider: "inference",
            message: "Reply with a short greeting.",
            thinking: "off",
            cleanupBundleMcpOnRunEnd: true,
          }),
        ],
        {
          artifactName: "router-agent-text",
          env: sandboxAccessEnv(),
          redactionValues: [apiKey],
          timeoutMs: 210_000,
        },
      );
      expect(turn.exitCode, resultText(turn)).toBe(0);
      expect(
        parseOpenClawAgentText(turn.stdout).trim().length,
        "native agent must return an answer",
      ).toBeGreaterThan(0);
      const selections = routerSelectionsSince(logPath, offset);
      await artifacts.writeJson("router-agent-text-selection.json", selections);
      expect(selections.map((selection) => selection.model)).toContain(ROUTER_LIGHTNING);
    }
    const stopped = await host.command(
      "node",
      [
        "-e",
        String.raw`
    const { loadSession } = require("./dist/lib/state/onboard-session.js");
    const { stopModelRouterProcess } = require("./dist/lib/onboard/model-router-process.js");
    const session = loadSession();
    if (!session?.routerPid || !session?.routerPort) process.exit(2);
    stopModelRouterProcess(session.routerPid, session.routerPort).catch(() => process.exit(1));
    `,
      ],
      {
        artifactName: "router-manual-stop",
        env: onboardEnv,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(stopped.exitCode, resultText(stopped)).toBe(0);
    const resumed = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--resume",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "router-manual-restart-resume",
        env: onboardEnv,
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(resumed.exitCode, resultText(resumed)).toBe(0);
    {
      const offset = fs.statSync(logPath).size;
      const id = randomUUID();
      const turn = await sandbox.exec(
        SANDBOX_NAME,
        [
          "openclaw",
          "gateway",
          "call",
          "agent",
          "--json",
          "--expect-final",
          "--timeout",
          "180000",
          "--params",
          JSON.stringify({
            agentId: "main",
            sessionKey: `agent:main:router-${id}`,
            idempotencyKey: id,
            model: ROUTER_SUPER_VL,
            provider: "inference",
            message: "Reply with a short greeting.",
            thinking: "off",
            cleanupBundleMcpOnRunEnd: true,
          }),
        ],
        {
          artifactName: "router-agent-explicit",
          env: sandboxAccessEnv(),
          redactionValues: [apiKey],
          timeoutMs: 210_000,
        },
      );
      expect(turn.exitCode, resultText(turn)).toBe(0);
      expect(
        parseOpenClawAgentText(turn.stdout).trim().length,
        "native agent must return an answer",
      ).toBeGreaterThan(0);
      const selections = routerSelectionsSince(logPath, offset);
      await artifacts.writeJson("router-agent-explicit-selection.json", selections);
      expect(selections.map((selection) => selection.model)).toContain(ROUTER_SUPER_VL);
    }
    {
      const offset = fs.statSync(logPath).size;
      const id = randomUUID();
      const turn = await sandbox.exec(
        SANDBOX_NAME,
        [
          "openclaw",
          "gateway",
          "call",
          "agent",
          "--json",
          "--expect-final",
          "--timeout",
          "180000",
          "--params",
          JSON.stringify({
            agentId: "main",
            sessionKey: `agent:main:router-${id}`,
            idempotencyKey: id,
            model: "nvidia-routed",
            provider: "inference",
            message: "Describe the attached image in one sentence.",
            thinking: "off",
            cleanupBundleMcpOnRunEnd: true,
            attachments: [
              { type: "file", mimeType: "image/png", fileName: "pixel.png", content: redImage },
            ],
          }),
        ],
        {
          artifactName: "router-agent-image",
          env: sandboxAccessEnv(),
          redactionValues: [apiKey],
          timeoutMs: 210_000,
        },
      );
      expect(turn.exitCode, resultText(turn)).toBe(0);
      expect(
        parseOpenClawAgentText(turn.stdout).trim().length,
        "native agent must return an answer",
      ).toBeGreaterThan(0);
      const selections = routerSelectionsSince(logPath, offset);
      await artifacts.writeJson("router-agent-image-selection.json", selections);
      expect(selections.map((selection) => selection.model)).toContain(ROUTER_SUPER_VL);
    }

    const isolation = await sandbox.exec(SANDBOX_NAME, hostedCredentialScanCommand(apiKey), {
      artifactName: "router-credential-isolation",
      env: sandboxAccessEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    });
    expect(isolation.exitCode, resultText(isolation)).toBe(0);
    expect(JSON.parse(isolation.stdout)).toMatchObject({
      environmentClean: true,
      processesClean: true,
      sampledFilesClean: true,
    });

    // Protocol requests use the same native attachment and opaque OpenShell handle.
    // They do not execute a tool. The agent requests above own the runtime boundary.
    const request = JSON.stringify({
      model: "nvidia-routed",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Call compatibility_probe with value 7." }],
      tools: [
        {
          type: "function",
          function: {
            name: "compatibility_probe",
            parameters: {
              type: "object",
              properties: { value: { type: "integer" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "compatibility_probe" } },
      chat_template_kwargs: { enable_thinking: false },
    });
    const protocol = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(nativeLocalChatCommand(attachment!.endpointUrl, request, "-fsS")),
      {
        artifactName: "router-native-stream-tool",
        env: sandboxAccessEnv(),
        redactionValues: [apiKey],
        timeoutMs: 150_000,
      },
    );
    expect(protocol.exitCode, resultText(protocol)).toBe(0);
    const chunks = protocol.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const deltas = chunks.flatMap(
      (chunk) =>
        chunk.choices?.flatMap(
          (choice: {
            delta?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
          }) => choice.delta?.tool_calls ?? [],
        ) ?? [],
    );
    // JSON parsing proves complete arguments; synthetic payload values belong to support tests.
    JSON.parse(deltas.map((delta) => delta.function?.arguments ?? "").join(""));
    expect(deltas.map((delta) => delta.function?.name ?? "").join("")).toBe("compatibility_probe");
    expect(protocol.stdout).toContain("data: [DONE]");

    progress.phase("record the routed inference contract result");
    await artifacts.target.complete({
      id: "model-router-provider-routed-inference",
    });
  },
);
