// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Direct Vitest replacement coverage for test/e2e/test-channels-add-remove.sh.
// Preserve the user-visible contract: onboard OpenClaw without messaging,
// add Telegram later, rebuild through the real CLI/OpenShell boundary, verify
// registry/gateway/policy/in-sandbox state, then remove Telegram and rebuild
// back to a clean state.

const TEST_SANDBOX_PREFIX = "e2e-channels-add-remove";
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? TEST_SANDBOX_PREFIX;
validateSandboxName(SANDBOX_NAME);

const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "test-fake-telegram-token-add-remove-e2e";
const TELEGRAM_ALLOWED_IDS = process.env.TELEGRAM_ALLOWED_IDS ?? "123456789";
const TELEGRAM_REQUIRE_MENTION = process.env.TELEGRAM_REQUIRE_MENTION ?? "0";
const PROVIDER_NAME = `${SANDBOX_NAME}-telegram-bridge`;

const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 4_500) * 1_000;
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const REBUILD_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 2 * 60_000;

type JsonRecord = Record<string, unknown>;

interface RegistrySandboxEntry extends JsonRecord {
  messaging?: {
    schemaVersion?: unknown;
    plan?: JsonRecord;
  };
}

type EgressProbeStatus = "open" | "denied" | "inconclusive";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFakeTelegramToken(value: string): boolean {
  return value.includes("fake");
}

function isEndpointRateLimited(error: unknown): boolean {
  const text = errorText(error);
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    (/Validation details were omitted/i.test(text) ||
      /HTTP 429|rate limit|too many requests|quota|temporarily unavailable|timed out|timeout/i.test(
        text,
      ))
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function channelEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    TELEGRAM_ALLOWED_IDS,
    TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    TELEGRAM_REQUIRE_MENTION,
    ...(isFakeTelegramToken(TELEGRAM_TOKEN) ? { NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1" } : {}),
    ...extra,
  });
}

function redactionValues(apiKey: string): string[] {
  return [apiKey, TELEGRAM_TOKEN].filter((value) => value.length > 0);
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and pre-cleanup must not mask the primary phase failure.
  }
}

function readSandboxEntry(): RegistrySandboxEntry {
  expect(fs.existsSync(REGISTRY_FILE), `registry file not found: ${REGISTRY_FILE}`).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, RegistrySandboxEntry>;
  };
  const entry = registry.sandboxes?.[SANDBOX_NAME];
  expect(entry, `sandbox ${SANDBOX_NAME} missing from registry`).toBeTruthy();
  if (!entry) throw new Error(`sandbox ${SANDBOX_NAME} missing from registry`);
  return entry;
}

function planArray(plan: JsonRecord, key: string): JsonRecord[] {
  const value = plan[key];
  return Array.isArray(value)
    ? (value.filter((item) => item && typeof item === "object") as JsonRecord[])
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function messagingPlan(): JsonRecord {
  const state = readSandboxEntry().messaging;
  expect(state?.schemaVersion, "messaging state missing or schemaVersion != 1").toBe(1);
  const plan = state?.plan;
  expect(plan && typeof plan === "object", "messaging.plan missing").toBe(true);
  if (!plan || typeof plan !== "object") throw new Error("messaging.plan missing");
  expect(plan.schemaVersion, "messaging.plan missing or schemaVersion != 1").toBe(1);
  expect(plan.sandboxName, "messaging.plan.sandboxName mismatch").toBe(SANDBOX_NAME);
  expect(plan.agent, "messaging.plan.agent mismatch").toBe("openclaw");
  return plan;
}

function expectHostTelegramConfig(context: string): void {
  const plan = messagingPlan();
  const channel = planArray(plan, "channels").find((item) => item.channelId === "telegram");
  expect(channel, `telegram channel missing from messaging.plan.channels ${context}`).toBeTruthy();
  const inputs = planArray(channel ?? {}, "inputs");
  const inputValue = (id: string): unknown => inputs.find((input) => input.inputId === id)?.value;
  expect(inputValue("allowedIds"), `allowedIds input mismatch ${context}`).toBe(
    TELEGRAM_ALLOWED_IDS,
  );
  expect(inputValue("requireMention"), `requireMention input mismatch ${context}`).toBe(
    TELEGRAM_REQUIRE_MENTION,
  );
}

function expectHostTelegramPlan(expected: "active" | "removed", context: string): void {
  const plan = messagingPlan();
  const channels = planArray(plan, "channels");
  const channel = channels.find((item) => item.channelId === "telegram");
  const disabledChannels = stringArray(plan.disabledChannels);
  const credentialBindings = planArray(plan, "credentialBindings");
  const networkPolicy =
    plan.networkPolicy && typeof plan.networkPolicy === "object"
      ? (plan.networkPolicy as JsonRecord)
      : {};
  const networkEntries = planArray(networkPolicy, "entries");
  const networkPresets = stringArray(networkPolicy.presets);
  const agentRender = planArray(plan, "agentRender");

  if (expected === "active") {
    expect(
      channel,
      `telegram channel missing from messaging.plan.channels ${context}`,
    ).toBeTruthy();
    expect(channel?.active, `telegram plan active expected true ${context}`).toBe(true);
    expect(channel?.disabled, `telegram plan disabled unexpectedly true ${context}`).not.toBe(true);
    expect(
      networkPresets,
      `telegram missing from messaging.plan.networkPolicy.presets ${context}`,
    ).toContain("telegram");
    expect(
      networkEntries.some((entry) => entry.channelId === "telegram"),
      `telegram missing from messaging.plan.networkPolicy.entries ${context}`,
    ).toBe(true);
    expect(
      credentialBindings.some(
        (entry) => entry.channelId === "telegram" && entry.providerEnvKey === "TELEGRAM_BOT_TOKEN",
      ),
      `telegram TELEGRAM_BOT_TOKEN credential binding missing ${context}`,
    ).toBe(true);
    expect(
      agentRender.some((entry) => entry.channelId === "telegram" && entry.agent === "openclaw"),
      `telegram openclaw agent render entry missing ${context}`,
    ).toBe(true);
    expect(disabledChannels, `telegram unexpectedly disabled ${context}`).not.toContain("telegram");
    return;
  }

  expect(channel, `telegram still present in messaging.plan.channels ${context}`).toBeUndefined();
  expect(disabledChannels, `telegram still present in disabledChannels ${context}`).not.toContain(
    "telegram",
  );
  expect(
    networkPresets,
    `telegram still present in networkPolicy.presets ${context}`,
  ).not.toContain("telegram");
  expect(
    networkEntries.some((entry) => entry.channelId === "telegram"),
    `telegram still present in networkPolicy.entries ${context}`,
  ).toBe(false);
  expect(
    credentialBindings.some((entry) => entry.channelId === "telegram"),
    `telegram credential binding still present ${context}`,
  ).toBe(false);
  expect(
    agentRender.some((entry) => entry.channelId === "telegram"),
    `telegram agent render entry still present ${context}`,
  ).toBe(false);
}

async function expectSandboxReady(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<ShellProbeResult> {
  const result = await sandbox.list({
    artifactName,
    env: sandboxAccessEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assertExitZero(result, "openshell sandbox list");
  const lines = stripAnsi(resultText(result)).split(/\r?\n/);
  expect(
    lines.some((line) => {
      const trimmed = line.trim();
      const [name] = trimmed.split(/\s+/);
      return name === SANDBOX_NAME && /\bReady\b/i.test(trimmed);
    }),
    `${SANDBOX_NAME} was not Ready:\n${resultText(result)}`,
  ).toBe(true);
  return result;
}

async function expectProvider(
  host: HostCliClient,
  expected: "present" | "absent",
  artifactName: string,
): Promise<void> {
  const result = await host.command("openshell", ["provider", "get", PROVIDER_NAME], {
    artifactName,
    env: baseEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (expected === "present") {
    assertExitZero(result, `openshell provider get ${PROVIDER_NAME}`);
  } else {
    const text = stripAnsi(resultText(result));
    expect(
      result.exitCode,
      `${PROVIDER_NAME} unexpectedly exists:\n${resultText(result)}`,
    ).not.toBe(0);
    expect(
      /not found|does not exist|no provider|unknown provider/i.test(text),
      `${PROVIDER_NAME} absence check failed for an unexpected reason:\n${resultText(result)}`,
    ).toBe(true);
  }
}

async function openClawHasTelegram(sandbox: SandboxClient, artifactName: string): Promise<boolean> {
  const result = await sandbox.exec(
    SANDBOX_NAME,
    [
      "python3",
      "-c",
      [
        "import json",
        "data=json.load(open('/sandbox/.openclaw/openclaw.json'))",
        "print('yes' if 'telegram' in data.get('channels', {}) else 'no')",
      ].join("; "),
    ],
    {
      artifactName,
      env: sandboxAccessEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  assertExitZero(result, "read /sandbox/.openclaw/openclaw.json");
  const verdict = stripAnsi(result.stdout).trim().split(/\r?\n/).at(-1);
  expect(["yes", "no"], `unexpected openclaw.json verdict:\n${resultText(result)}`).toContain(
    verdict,
  );
  return verdict === "yes";
}

async function expectOpenClawTelegram(
  sandbox: SandboxClient,
  expected: boolean,
  artifactName: string,
): Promise<void> {
  await expect(openClawHasTelegram(sandbox, artifactName)).resolves.toBe(expected);
}

function policyListHasActivePreset(output: string, preset: string): boolean {
  const activePreset = new RegExp(`^\\s*\\u25cf\\s+${escapeRegex(preset)}\\b`, "im");
  return activePreset.test(stripAnsi(output));
}

async function expectPolicyPreset(
  host: HostCliClient,
  preset: string,
  expected: "applied" | "not-applied",
  artifactName: string,
): Promise<void> {
  const result = await host.nemoclaw([SANDBOX_NAME, "policy-list"], {
    artifactName,
    env: baseEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assertExitZero(result, `nemoclaw ${SANDBOX_NAME} policy-list`);
  const applied = policyListHasActivePreset(resultText(result), preset);
  expect(applied, `${preset} preset expected ${expected}:\n${resultText(result)}`).toBe(
    expected === "applied",
  );
}

async function telegramEgressProbe(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<{ result: ShellProbeResult; status: EgressProbeStatus }> {
  const source = [
    `const url = ${JSON.stringify(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`)};`,
    "fetch(url, { signal: AbortSignal.timeout(15000) })",
    "  .then((response) => console.log(`STATUS_${response.status}`))",
    "  .catch((error) => console.log(`ERROR_${error.cause?.code || error.code || error.message}`));",
  ].join(" ");
  const result = await sandbox.exec(SANDBOX_NAME, ["node", "-e", source], {
    artifactName,
    env: sandboxAccessEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  assertExitZero(result, "telegram egress probe");
  const output = resultText(result);
  if (/STATUS_[24][0-9][0-9]/.test(output)) return { result, status: "open" };
  if (/policy_denied|engine:ssrf|forbidden by policy|CONNECT.*40[0-9]/i.test(output)) {
    return { result, status: "denied" };
  }
  return { result, status: "inconclusive" };
}

const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

liveTest(
  "channels add/remove telegram updates registry, gateway, policy, and sandbox state",
  testTimeoutOptions(TEST_TIMEOUT_MS),
  async ({ artifacts, cleanup, environment, host, lifecycle, onboard, sandbox, secrets, skip }) => {
    if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
      throw new Error(
        `channels-add-remove live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
      );
    }
    const apiKey = secrets.required("NVIDIA_API_KEY");
    const secretsToRedact = redactionValues(apiKey);

    const ready = await environment.assertReady({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });

    await artifacts.writeJson("scenario.json", {
      id: "channels-add-remove",
      legacySource: "test/e2e/test-channels-add-remove.sh",
      runner: "vitest",
      sandboxName: SANDBOX_NAME,
      contract: [
        "onboard creates an OpenClaw sandbox with no Telegram channel",
        "channels add telegram registers the bridge and persists messaging.plan",
        "post-add rebuild reuses the gateway-stored inference credential when NVIDIA_API_KEY is absent",
        "post-add rebuild applies the Telegram policy preset and renders openclaw.json channel state",
        "channels remove telegram removes provider, policy, registry plan, and rendered channel state after rebuild",
      ],
    });

    cleanup.add(`destroy ${SANDBOX_NAME} after channels add/remove live test`, async () => {
      await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "cleanup-nemoclaw-destroy"));
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete",
          env: sandboxAccessEnv(),
          timeoutMs: COMMAND_TIMEOUT_MS,
        }),
      );
      await bestEffort(() =>
        host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "cleanup-openshell-gateway-destroy",
          env: baseEnv(),
          timeoutMs: COMMAND_TIMEOUT_MS,
        }),
      );
    });

    await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "pre-cleanup-nemoclaw-destroy"));
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete",
        env: sandboxAccessEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    );
    await bestEffort(() =>
      host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "pre-cleanup-openshell-gateway-destroy",
        env: baseEnv(),
        timeoutMs: COMMAND_TIMEOUT_MS,
      }),
    );

    let instance;
    try {
      instance = await onboard.from(ready, {
        sandboxName: SANDBOX_NAME,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      });
    } catch (error) {
      if (isEndpointRateLimited(error)) {
        await artifacts.writeText("endpoint-rate-limit-skip.txt", errorText(error));
        skip(
          "NVIDIA endpoint validation was unavailable/rate-limited before the channels add/remove contract could run",
        );
      }
      throw error;
    }
    await expectSandboxReady(sandbox, "phase-1-sandbox-ready-after-onboard");

    await expectProvider(host, "absent", "phase-2-provider-get-baseline");
    await expectOpenClawTelegram(sandbox, false, "phase-2-openclaw-json-baseline");
    await expectPolicyPreset(host, "telegram", "not-applied", "phase-2-policy-list-baseline");

    const add = await host.nemoclaw([SANDBOX_NAME, "channels", "add", "telegram"], {
      artifactName: "phase-3-channels-add-telegram",
      env: channelEnv(),
      redactionValues: secretsToRedact,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(add, `nemoclaw ${SANDBOX_NAME} channels add telegram`);
    expect(resultText(add)).toContain("Registered telegram");
    expectHostTelegramConfig("after channels add");
    expectHostTelegramPlan("active", "after channels add");

    const rebuildAdd = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "phase-3-rebuild-after-add-without-host-nvidia-key",
      env: channelEnv(),
      redactionValues: secretsToRedact,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    expect(resultText(rebuildAdd)).not.toContain("provider credential not found");
    assertExitZero(rebuildAdd, `nemoclaw ${SANDBOX_NAME} rebuild --yes after add`);
    await lifecycle.assertSandboxReadyAfterRebuild(instance, {
      artifactNamePrefix: "phase-3-sandbox-ready-after-add-rebuild",
      env: sandboxAccessEnv(),
      attempts: 12,
      delayMs: 5_000,
    });

    await expectPolicyPreset(host, "telegram", "applied", "phase-4-policy-list-after-add");
    await expectOpenClawTelegram(sandbox, true, "phase-4-openclaw-json-after-add");
    await expectProvider(host, "present", "phase-4-provider-get-after-add");
    expectHostTelegramConfig("after add+rebuild");
    expectHostTelegramPlan("active", "after add+rebuild");

    const egress = await telegramEgressProbe(sandbox, "phase-4-telegram-egress-probe");
    if (egress.status === "denied") {
      throw new Error(`egress to api.telegram.org was blocked:\n${resultText(egress.result)}`);
    }
    if (egress.status === "inconclusive") {
      await artifacts.writeText(
        "phase-4-telegram-egress-inconclusive.txt",
        `Telegram egress probe was inconclusive; preserving the legacy soft-skip behavior.\n\n${resultText(
          egress.result,
        )}`,
      );
    }

    const remove = await host.nemoclaw([SANDBOX_NAME, "channels", "remove", "telegram"], {
      artifactName: "phase-5-channels-remove-telegram",
      env: channelEnv({ NVIDIA_API_KEY: apiKey }),
      redactionValues: secretsToRedact,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(remove, `nemoclaw ${SANDBOX_NAME} channels remove telegram`);
    expect(resultText(remove)).toContain("Removed telegram");
    expectHostTelegramPlan("removed", "after channels remove");

    const rebuildRemove = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
      artifactName: "phase-5-rebuild-after-remove",
      env: channelEnv({ NVIDIA_API_KEY: apiKey }),
      redactionValues: secretsToRedact,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    assertExitZero(rebuildRemove, `nemoclaw ${SANDBOX_NAME} rebuild --yes after remove`);
    await lifecycle.assertSandboxReadyAfterRebuild(instance, {
      artifactNamePrefix: "phase-5-sandbox-ready-after-remove-rebuild",
      env: sandboxAccessEnv(),
      attempts: 12,
      delayMs: 5_000,
    });

    await expectOpenClawTelegram(sandbox, false, "phase-6-openclaw-json-after-remove");
    await expectProvider(host, "absent", "phase-6-provider-get-after-remove");
    await expectPolicyPreset(host, "telegram", "not-applied", "phase-6-policy-list-after-remove");
    expectHostTelegramPlan("removed", "after remove+rebuild");
  },
);
