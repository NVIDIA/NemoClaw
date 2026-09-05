// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parseOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";

// Keep this free-standing and direct: the contract is the real CLI +
// OpenShell/provider boundary for messaging credential reuse/rotation, not the
// typed registry target steady-state probe path. The test drives the real
// `nemoclaw onboard` CLI with fake provider tokens, preserving the provider
// upsert, registry credential-hash, sandbox rebuild, and reuse assertions.

const REGISTRY_FILE = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "sandboxes.json");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-tok-${process.pid}`;
validateSandboxName(SANDBOX_NAME);

const ONBOARD_TIMEOUT_MS = execTimeout(25 * 60_000);
const PHASE_TIMEOUT_MS = testTimeout(40 * 60_000);

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

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

type RegistrySandboxEntry = {
  imageTag?: unknown;
  messaging?: {
    plan?: {
      credentialBindings?: RegistryCredentialBinding[];
    };
  };
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
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

function sandboxImageTag(): string {
  const imageTag = readSandboxRegistryEntry().imageTag;
  const normalizedImageTag = typeof imageTag === "string" ? imageTag.trim() : "";
  expect(normalizedImageTag, "registry imageTag missing").not.toBe("");
  return normalizedImageTag;
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

function expectTelegramRotationOutput(output: string): void {
  const rotationLine = output
    .split(/\r?\n/)
    .find((line) => line.includes("Messaging credential(s) rotated:"));
  expect(rotationLine, output).toBeTruthy();
  expect(rotationLine).toContain(`${SANDBOX_NAME}-telegram-bridge`);
  expect(rotationLine).not.toContain(`${SANDBOX_NAME}-discord-bridge`);
  expect(rotationLine).not.toContain(`${SANDBOX_NAME}-slack-bridge`);
  expect(rotationLine).not.toContain(`${SANDBOX_NAME}-slack-app`);
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
    process.env.NVIDIA_INFERENCE_API_KEY,
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

async function sandboxIdentity(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  artifactName: string,
): Promise<string> {
  const sandboxGet = await host.command("openshell", ["sandbox", "get", SANDBOX_NAME], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  const output = resultText(sandboxGet);
  expect(sandboxGet.exitCode, output).toBe(0);
  const sandboxId = parseOpenShellSandboxId(output);
  expect(sandboxId, output).not.toBeNull();
  return sandboxId ?? "";
}

async function assertSandboxReused(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  beforeId: string,
  artifactName: string,
): Promise<void> {
  expect(await sandboxIdentity(host, `${artifactName}-identity`)).toBe(beforeId);
  await assertSandboxRunning(host, `${artifactName}-running`);
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

test(
  "messaging token rotation rebuilds only the changed provider and reuses unchanged credentials",
  {
    timeout: PHASE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the selected runtime and start hermetic inference",
        "install the sandbox and confirm provider hashes",
        "rotate only the Telegram provider",
        "reuse the sandbox and record rotation evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI targets",
    ).toBe(true);

    assertTokenPairsDiffer();

    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-token-rotation",
      scenarioLabel: "token rotation",
    });

    const fakeOpenAI = await startFakeOpenAiCompatibleServer({
      chatContent: "OK",
      host: "0.0.0.0",
      progress,
      publicHost: "host.openshell.internal",
      responseText: "OK",
    });
    cleanup.trackDisposable("stop fake OpenAI-compatible endpoint for token rotation", async () => {
      await artifacts.writeJson("fake-openai-compatible-requests.json", fakeOpenAI.requests());
      await fakeOpenAI.close();
    });

    await artifacts.target.declare({
      id: "token-rotation",
      boundary: "direct-cli-onboard-openshell",
      workflow: {
        workflow: "e2e.yaml",
        job: "token-rotation",
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
      ],
    });

    const cleanupEnv = buildAvailabilityProbeEnv();
    const gatewayCleanupOptions = {
      artifactName: "cleanup-openshell-gateway-destroy-token-rotation",
      env: cleanupEnv,
      redactionValues: redactionValues(),
      timeoutMs: 60_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-gateway-token-rotation",
              env: gatewayCleanupOptions.env,
              redactionValues: gatewayCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const openshellSandboxCleanupOptions = {
      artifactName: "cleanup-openshell-sandbox-delete-token-rotation",
      env: cleanupEnv,
      redactionValues: redactionValues(),
      timeoutMs: 60_000,
    };
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupWhenOpenShellAvailable(
        host,
        {
          artifactName: "cleanup-probe-openshell-sandbox-token-rotation",
          env: openshellSandboxCleanupOptions.env,
          redactionValues: openshellSandboxCleanupOptions.redactionValues,
          timeoutMs: 30_000,
        },
        () => sandbox.cleanupSandbox(SANDBOX_NAME, openshellSandboxCleanupOptions),
      ),
    );
    const nemoclawSandboxCleanupOptions = {
      artifactName: "cleanup-nemoclaw-destroy-token-rotation",
      env: cleanupEnv,
      redactionValues: redactionValues(),
      timeoutMs: 120_000,
    };
    cleanup.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-nemoclaw-sandbox-token-rotation",
              env: nemoclawSandboxCleanupOptions.env,
              redactionValues: nemoclawSandboxCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, nemoclawSandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      nemoclawSandboxCleanupOptions,
    );

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

    progress.phase("install the sandbox and confirm provider hashes");
    const first = await runInstall(host, fakeOpenAI.baseUrl, TOKEN_A, {
      NEMOCLAW_RECREATE_SANDBOX: "1",
    });
    expect(first.exitCode, resultText(first)).toBe(0);

    // OpenShell removes each deployment image during credential-driven
    // recreation. Retain one test-owned tag so Docker can reuse the identical
    // OpenClaw/plugin layers for the retained rotation; token values remain in
    // gateway providers and are never baked into this image.
    const cacheImageTag = `nemoclaw-token-rotation-cache:${process.pid}`;
    const retainBuildCache = await runtimeProvider.command(
      ["image", "tag", sandboxImageTag(), cacheImageTag],
      {
        artifactName: "phase-1-retain-build-cache",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(retainBuildCache.exitCode, resultText(retainBuildCache)).toBe(0);
    cleanup.trackDisposable("remove token-rotation build cache tag", async () => {
      const remove = await runtimeProvider.command(["image", "rm", cacheImageTag], {
        artifactName: "cleanup-token-rotation-build-cache",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      });
      expect(remove.exitCode, resultText(remove)).toBe(0);
    });

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

    ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].forEach(
      (envKey) => {
        expectCredentialHash(envKey);
      },
    );
    await assertSandboxRunning(host, "phase-1-sandbox-running-after-install");

    progress.phase("rotate only the Telegram provider");
    const telegram = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram },
      "phase-2-rotate-telegram",
    );
    const telegramText = resultText(telegram);
    expect(telegram.exitCode, telegramText).toBe(0);
    expectTelegramRotationOutput(telegramText);
    await assertSandboxRunning(host, "phase-2-sandbox-running-after-telegram-rotation");

    progress.phase("reuse the sandbox and record rotation evidence");
    const beforeTelegramReuseId = await sandboxIdentity(
      host,
      "phase-3-before-same-telegram-identity",
    );
    const afterTelegramSame = await runOnboard(
      host,
      fakeOpenAI.baseUrl,
      { ...TOKEN_A, telegram: TOKEN_B.telegram },
      "phase-3-same-after-telegram",
    );
    const afterTelegramSameText = resultText(afterTelegramSame);
    expect(afterTelegramSame.exitCode, afterTelegramSameText).toBe(0);
    await assertSandboxReused(host, beforeTelegramReuseId, "phase-3-after-same-telegram");

    await artifacts.target.complete({
      id: "token-rotation",
      sandboxName: SANDBOX_NAME,
      assertions: {
        providersCreated: true,
        credentialHashesStored: true,
        telegramRotationIsolated: true,
        unchangedTokensReuseSandbox: true,
      },
    });
  },
);
