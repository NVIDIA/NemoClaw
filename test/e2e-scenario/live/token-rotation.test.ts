// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import { testTimeoutOptions } from "../../helpers/timeouts";

// Focused Vitest replacement coverage for test/e2e/test-token-rotation.sh.
// Keep this free-standing and direct: the legacy contract is the real CLI +
// OpenShell/provider boundary for messaging credential reuse/rotation, not the
// typed registry scenario steady-state probe path. The test drives the real
// `nemoclaw onboard` CLI with fake provider tokens, preserving the provider
// upsert, registry credential-hash, sandbox rebuild, and reuse assertions.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const REGISTRY_FILE = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "sandboxes.json");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-token-rotation-${process.pid}`;
validateSandboxName(SANDBOX_NAME);

const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const PHASE_TIMEOUT_MS = 40 * 60_000;

interface TokenSet {
  telegram: string;
  discord: string;
  slackBot: string;
  slackApp: string;
}

const TOKEN_A: TokenSet = {
  telegram: process.env.TELEGRAM_BOT_TOKEN_A ?? "test-fake-token-A-rotation-e2e",
  discord: process.env.DISCORD_BOT_TOKEN_A ?? "dc-a-rotation-e2e",
  slackBot: process.env.SLACK_BOT_TOKEN_A ?? "xoxb-fake-A-rotation-e2e",
  slackApp: process.env.SLACK_APP_TOKEN_A ?? "xapp-fake-A-rotation-e2e",
};

const TOKEN_B: TokenSet = {
  telegram: process.env.TELEGRAM_BOT_TOKEN_B ?? "test-fake-token-B-rotation-e2e",
  discord: process.env.DISCORD_BOT_TOKEN_B ?? "dc-b-rotation-e2e",
  slackBot: process.env.SLACK_BOT_TOKEN_B ?? "xoxb-fake-B-rotation-e2e",
  slackApp: process.env.SLACK_APP_TOKEN_B ?? "xapp-fake-B-rotation-e2e",
};

type RegistryCredentialBinding = {
  providerEnvKey?: unknown;
  credentialHash?: unknown;
};

type FakeOpenAIRequest = {
  method: string;
  path: string;
  bodyBytes: number;
};

type FakeOpenAIEndpoint = {
  baseUrl: string;
  requests: FakeOpenAIRequest[];
  close(): Promise<void>;
};

type RegistrySandboxEntry = {
  messaging?: {
    plan?: {
      credentialBindings?: RegistryCredentialBinding[];
    };
  };
};

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function startFakeOpenAIEndpoint(): Promise<FakeOpenAIEndpoint> {
  const requests: FakeOpenAIRequest[] = [];
  const server = http.createServer((req, res) => {
    let bodyBytes = 0;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
    });
    req.on("end", () => {
      const requestPath = new URL(req.url ?? "/", "http://fake.local").pathname;
      requests.push({
        method: req.method ?? "GET",
        path: requestPath,
        bodyBytes,
      });
      if (req.method === "GET" && ["/v1/models", "/models"].includes(requestPath)) {
        jsonResponse(res, 200, {
          data: [{ id: "test-model", object: "model" }],
        });
        return;
      }
      if (
        req.method === "POST" &&
        ["/v1/chat/completions", "/chat/completions"].includes(requestPath)
      ) {
        jsonResponse(res, 200, {
          id: "chatcmpl-token-rotation-e2e",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && ["/v1/responses", "/responses"].includes(requestPath)) {
        jsonResponse(res, 200, {
          id: "resp-token-rotation-e2e",
          object: "response",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        });
        return;
      }
      jsonResponse(res, 404, { error: { message: "not found" } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake OpenAI-compatible endpoint did not bind to a TCP port");
  }
  const port = (address as AddressInfo).port;
  return {
    baseUrl: `http://host.openshell.internal:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function onboardEnv(endpointUrl: string, tokens: TokenSet): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: "token-rotation-compatible-e2e",
    TELEGRAM_BOT_TOKEN: tokens.telegram,
    DISCORD_BOT_TOKEN: tokens.discord,
    SLACK_BOT_TOKEN: tokens.slackBot,
    SLACK_APP_TOKEN: tokens.slackApp,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_YES: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1",
    NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
}

function readSandboxRegistryEntry(): RegistrySandboxEntry {
  expect(fs.existsSync(REGISTRY_FILE), `${REGISTRY_FILE} missing`).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, RegistrySandboxEntry>;
  };
  const entry = registry.sandboxes?.[SANDBOX_NAME];
  expect(entry, `registry entry ${SANDBOX_NAME} missing`).toBeTruthy();
  if (!entry) throw new Error(`registry entry ${SANDBOX_NAME} missing`);
  return entry;
}

function credentialBindings(): RegistryCredentialBinding[] {
  const bindings = readSandboxRegistryEntry().messaging?.plan?.credentialBindings;
  expect(Array.isArray(bindings), "messaging.plan.credentialBindings missing").toBe(true);
  return Array.isArray(bindings) ? bindings : [];
}

function expectCredentialHash(envKey: string): void {
  const binding = credentialBindings().find((entry) => entry.providerEnvKey === envKey);
  expect(binding, `${envKey} credential binding missing`).toBeTruthy();
  expect(typeof binding?.credentialHash, `${envKey} credential hash missing`).toBe("string");
  expect(
    String(binding?.credentialHash ?? "").length,
    `${envKey} credential hash empty`,
  ).toBeGreaterThan(0);
}

function expectRotationOutput(
  output: string,
  expectedProviders: readonly string[],
  forbiddenProviders: readonly string[],
): void {
  const rotationLine = output
    .split(/\r?\n/)
    .find((line) => line.includes("Messaging credential(s) rotated:"));
  expect(rotationLine, output).toBeTruthy();
  for (const provider of expectedProviders) {
    expect(rotationLine, `rotation line should name ${provider}: ${rotationLine}`).toContain(
      provider,
    );
  }
  for (const provider of forbiddenProviders) {
    expect(
      rotationLine,
      `rotation line should not name ${provider}: ${rotationLine}`,
    ).not.toContain(provider);
  }
  expect(output).toContain("Rebuilding sandbox to propagate new credentials");
}

function assertTokenPairsDiffer(): void {
  for (const [label, a, b] of [
    ["TELEGRAM_BOT_TOKEN", TOKEN_A.telegram, TOKEN_B.telegram],
    ["DISCORD_BOT_TOKEN", TOKEN_A.discord, TOKEN_B.discord],
    ["SLACK_BOT_TOKEN", TOKEN_A.slackBot, TOKEN_B.slackBot],
    ["SLACK_APP_TOKEN", TOKEN_A.slackApp, TOKEN_B.slackApp],
  ] as const) {
    expect(a, `${label}_A and ${label}_B must be different`).not.toBe(b);
  }
}

function redactionValues(): string[] {
  return [
    "token-rotation-compatible-e2e",
    process.env.NVIDIA_API_KEY,
    process.env.GITHUB_TOKEN,
    ...Object.values(TOKEN_A),
    ...Object.values(TOKEN_B),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function runInstall(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  endpointUrl: string,
  tokens: TokenSet,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName: "phase-0-install-token-a",
    cwd: REPO_ROOT,
    env: {
      ...onboardEnv(endpointUrl, tokens),
      ...extraEnv,
    },
    redactionValues: redactionValues(),
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
}

async function runOnboard(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  endpointUrl: string,
  tokens: TokenSet,
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
    artifactName,
    env: {
      ...onboardEnv(endpointUrl, tokens),
      ...extraEnv,
    },
    redactionValues: redactionValues(),
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
}

async function assertSandboxRunning(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  artifactName: string,
): Promise<void> {
  const sandboxList = await host.command(
    "bash",
    ["-lc", 'openshell sandbox list 2>/dev/null | grep -F -- "$1"', "_", SANDBOX_NAME],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const output = resultText(sandboxList);
  const plainStdout = stripAnsi(sandboxList.stdout);
  expect(sandboxList.exitCode, output).toBe(0);
  expect(plainStdout, output).toContain(SANDBOX_NAME);
  expect(plainStdout, output).toMatch(/\b(?:Ready|Running)\b/i);
}

async function deleteSandboxIfOpenshellExists(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  artifactName: string,
): Promise<void> {
  await host.command(
    "bash",
    [
      "-lc",
      'if command -v openshell >/dev/null 2>&1; then openshell sandbox delete "$1"; fi',
      "_",
      SANDBOX_NAME,
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
}

async function destroyGatewayIfOpenshellExists(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  artifactName: string,
): Promise<void> {
  await host.command(
    "bash",
    [
      "-lc",
      "if command -v openshell >/dev/null 2>&1; then openshell gateway destroy -g nemoclaw; fi",
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
}

const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

liveTest(
  "messaging token rotation rebuilds only the changed provider and reuses unchanged credentials",
  testTimeoutOptions(PHASE_TIMEOUT_MS),
  async ({ artifacts, cleanup, host, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    assertTokenPairsDiffer();

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-token-rotation",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for token rotation live E2E: ${resultText(docker)}`);
      }
      skip("Docker is required for token rotation live E2E");
    }

    const fakeOpenAI = await startFakeOpenAIEndpoint();
    cleanup.add("stop fake OpenAI-compatible endpoint for token rotation", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fakeOpenAI.requests);
      await fakeOpenAI.close();
    });

    await artifacts.writeJson("scenario.json", {
      id: "token-rotation",
      runner: "vitest",
      boundary: "direct-cli-onboard-openshell",
      legacySource: "test/e2e/test-token-rotation.sh",
      originalRunner: {
        workflow: "nightly-e2e.yaml",
        job: "token-rotation-e2e",
        runsOn: "ubuntu-latest",
        resources: [
          "Docker",
          "install.sh/OpenShell",
          "NVIDIA_API_KEY or fake OpenAI-compatible endpoint",
          "fake messaging tokens",
        ],
      },
      replacementRunner: {
        workflow: "e2e-vitest-scenarios.yaml",
        job: "token-rotation-vitest",
        runsOn: "ubuntu-latest",
        resources: [
          "Docker",
          "install.sh/OpenShell",
          "hermetic fake OpenAI-compatible endpoint",
          "fake messaging tokens",
        ],
      },
      documentedException:
        "The replacement uses the legacy-supported fake OpenAI-compatible endpoint path so the messaging credential-rotation guard is not blocked by unrelated NVIDIA endpoint 429 rate limits.",
      contract: [
        "first onboard stores messaging credential hashes and creates provider attachments",
        "rotating Telegram rebuilds and names only telegram-bridge",
        "unchanged tokens reuse the sandbox",
        "rotating Discord rebuilds and names only discord-bridge",
        "rotating Slack bot/app credentials rebuilds and names slack-bridge and slack-app only",
      ],
    });

    const cleanupEnv = buildAvailabilityProbeEnv();
    cleanup.add(`destroy token-rotation sandbox ${SANDBOX_NAME}`, async () => {
      await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "cleanup-nemoclaw-destroy-token-rotation",
        env: cleanupEnv,
        timeoutMs: 120_000,
      });
      await deleteSandboxIfOpenshellExists(host, "cleanup-openshell-sandbox-delete-token-rotation");
      await destroyGatewayIfOpenshellExists(
        host,
        "cleanup-openshell-gateway-destroy-token-rotation",
      );
    });

    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-token-rotation",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    await deleteSandboxIfOpenshellExists(
      host,
      "pre-cleanup-openshell-sandbox-delete-token-rotation",
    );
    await destroyGatewayIfOpenshellExists(
      host,
      "pre-cleanup-openshell-gateway-destroy-token-rotation",
    );

    const first = await runInstall(host, fakeOpenAI.baseUrl, TOKEN_A, {
      NEMOCLAW_RECREATE_SANDBOX: "1",
    });
    expect(first.exitCode, resultText(first)).toBe(0);

    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "phase-0-openshell-version-token-rotation",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(openshellVersion.exitCode, resultText(openshellVersion)).toBe(0);

    for (const providerName of [
      `${SANDBOX_NAME}-telegram-bridge`,
      `${SANDBOX_NAME}-discord-bridge`,
      `${SANDBOX_NAME}-slack-bridge`,
      `${SANDBOX_NAME}-slack-app`,
    ]) {
      const provider = await host.command("openshell", ["provider", "get", providerName], {
        artifactName: `phase-1-provider-get-${providerName}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      });
      expect(provider.exitCode, resultText(provider)).toBe(0);
    }

    for (const envKey of [
      "TELEGRAM_BOT_TOKEN",
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]) {
      expectCredentialHash(envKey);
    }
    await assertSandboxRunning(host, "phase-1-sandbox-running-after-install");

    const telegram = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram },
      "phase-2-rotate-telegram",
    );
    const telegramText = resultText(telegram);
    expect(telegram.exitCode, telegramText).toBe(0);
    expectRotationOutput(
      telegramText,
      [`${SANDBOX_NAME}-telegram-bridge`],
      [
        `${SANDBOX_NAME}-discord-bridge`,
        `${SANDBOX_NAME}-slack-bridge`,
        `${SANDBOX_NAME}-slack-app`,
      ],
    );
    await assertSandboxRunning(host, "phase-2-sandbox-running-after-telegram-rotation");

    const afterTelegramSame = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram },
      "phase-3-same-after-telegram",
    );
    const afterTelegramSameText = resultText(afterTelegramSame);
    expect(afterTelegramSame.exitCode, afterTelegramSameText).toBe(0);
    expect(afterTelegramSameText).toContain(`Sandbox '${SANDBOX_NAME}' exists and is ready`);
    expect(afterTelegramSameText).toContain("reusing it");

    const discord = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram, discord: TOKEN_B.discord },
      "phase-4-rotate-discord",
    );
    const discordText = resultText(discord);
    expect(discord.exitCode, discordText).toBe(0);
    expectRotationOutput(
      discordText,
      [`${SANDBOX_NAME}-discord-bridge`],
      [
        `${SANDBOX_NAME}-telegram-bridge`,
        `${SANDBOX_NAME}-slack-bridge`,
        `${SANDBOX_NAME}-slack-app`,
      ],
    );
    await assertSandboxRunning(host, "phase-4-sandbox-running-after-discord-rotation");

    const afterDiscordSame = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram, discord: TOKEN_B.discord },
      "phase-5-same-after-discord",
    );
    const afterDiscordSameText = resultText(afterDiscordSame);
    expect(afterDiscordSame.exitCode, afterDiscordSameText).toBe(0);
    expect(afterDiscordSameText).toContain(`Sandbox '${SANDBOX_NAME}' exists and is ready`);
    expect(afterDiscordSameText).toContain("reusing it");

    const slack = await runOnboard(host, fakeOpenAI.baseUrl, TOKEN_B, "phase-6-rotate-slack");
    const slackText = resultText(slack);
    expect(slack.exitCode, slackText).toBe(0);
    expectRotationOutput(
      slackText,
      [`${SANDBOX_NAME}-slack-bridge`, `${SANDBOX_NAME}-slack-app`],
      [`${SANDBOX_NAME}-telegram-bridge`, `${SANDBOX_NAME}-discord-bridge`],
    );
    await assertSandboxRunning(host, "phase-6-sandbox-running-after-slack-rotation");

    const afterSlackSame = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      TOKEN_B,
      "phase-7-same-after-slack",
    );
    const afterSlackSameText = resultText(afterSlackSame);
    expect(afterSlackSame.exitCode, afterSlackSameText).toBe(0);
    expect(afterSlackSameText).toContain(`Sandbox '${SANDBOX_NAME}' exists and is ready`);
    expect(afterSlackSameText).toContain("reusing it");

    await artifacts.writeJson("scenario-result.json", {
      id: "token-rotation",
      sandboxName: SANDBOX_NAME,
      assertions: {
        providersCreated: true,
        credentialHashesStored: true,
        telegramRotationIsolated: true,
        discordRotationIsolated: true,
        slackRotationIsolated: true,
        unchangedTokensReuseSandbox: true,
      },
    });
  },
);
