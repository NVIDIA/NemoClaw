// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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
const PHASE_TIMEOUT_MS = 7 * ONBOARD_TIMEOUT_MS;

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
  messaging?: {
    plan?: {
      credentialBindings?: RegistryCredentialBinding[];
    };
  };
};

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function onboardEnv(apiKey: string, tokens: TokenSet): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NVIDIA_API_KEY: apiKey,
    TELEGRAM_BOT_TOKEN: tokens.telegram,
    DISCORD_BOT_TOKEN: tokens.discord,
    SLACK_BOT_TOKEN: tokens.slackBot,
    SLACK_APP_TOKEN: tokens.slackApp,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_YES: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_PROVIDER: "cloud",
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

function redactionValues(apiKey: string): string[] {
  return [
    apiKey,
    process.env.GITHUB_TOKEN,
    ...Object.values(TOKEN_A),
    ...Object.values(TOKEN_B),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function runInstall(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  apiKey: string,
  tokens: TokenSet,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return host.command("bash", ["install.sh", "--non-interactive"], {
    artifactName: "phase-0-install-token-a",
    cwd: REPO_ROOT,
    env: {
      ...onboardEnv(apiKey, tokens),
      ...extraEnv,
    },
    redactionValues: redactionValues(apiKey),
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
}

async function runOnboard(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  apiKey: string,
  tokens: TokenSet,
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
    artifactName,
    env: {
      ...onboardEnv(apiKey, tokens),
      ...extraEnv,
    },
    redactionValues: redactionValues(apiKey),
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
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

const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

liveTest(
  "messaging token rotation rebuilds only the changed provider and reuses unchanged credentials",
  testTimeoutOptions(PHASE_TIMEOUT_MS),
  async ({ artifacts, cleanup, host, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

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

    const apiKey = secrets.required("NVIDIA_API_KEY");

    await artifacts.writeJson("scenario.json", {
      id: "token-rotation",
      runner: "vitest",
      boundary: "direct-cli-onboard-openshell",
      legacySource: "test/e2e/test-token-rotation.sh",
      originalRunner: {
        workflow: "nightly-e2e.yaml",
        job: "token-rotation-e2e",
        runsOn: "ubuntu-latest",
        resources: ["Docker", "install.sh/OpenShell", "NVIDIA_API_KEY", "fake messaging tokens"],
      },
      replacementRunner: {
        workflow: "e2e-vitest-scenarios.yaml",
        job: "token-rotation-vitest",
        runsOn: "ubuntu-latest",
        resources: ["Docker", "install.sh/OpenShell", "NVIDIA_API_KEY", "fake messaging tokens"],
      },
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

    const first = await runInstall(host, apiKey, TOKEN_A, {
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

    const telegram = await runOnboard(
      host,
      apiKey,
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

    const afterTelegramSame = await runOnboard(
      host,
      apiKey,
      { ...TOKEN_A, telegram: TOKEN_B.telegram },
      "phase-3-same-after-telegram",
    );
    const afterTelegramSameText = resultText(afterTelegramSame);
    expect(afterTelegramSame.exitCode, afterTelegramSameText).toBe(0);
    expect(afterTelegramSameText).toContain(`Sandbox '${SANDBOX_NAME}' exists and is ready`);
    expect(afterTelegramSameText).toContain("reusing it");

    const discord = await runOnboard(
      host,
      apiKey,
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

    const afterDiscordSame = await runOnboard(
      host,
      apiKey,
      { ...TOKEN_A, telegram: TOKEN_B.telegram, discord: TOKEN_B.discord },
      "phase-5-same-after-discord",
    );
    const afterDiscordSameText = resultText(afterDiscordSame);
    expect(afterDiscordSame.exitCode, afterDiscordSameText).toBe(0);
    expect(afterDiscordSameText).toContain(`Sandbox '${SANDBOX_NAME}' exists and is ready`);
    expect(afterDiscordSameText).toContain("reusing it");

    const slack = await runOnboard(host, apiKey, TOKEN_B, "phase-6-rotate-slack");
    const slackText = resultText(slack);
    expect(slack.exitCode, slackText).toBe(0);
    expectRotationOutput(
      slackText,
      [`${SANDBOX_NAME}-slack-bridge`, `${SANDBOX_NAME}-slack-app`],
      [`${SANDBOX_NAME}-telegram-bridge`, `${SANDBOX_NAME}-discord-bridge`],
    );

    const afterSlackSame = await runOnboard(host, apiKey, TOKEN_B, "phase-7-same-after-slack");
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
