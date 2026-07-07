// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  applyFakePolicy,
  approveAndAssertPairing,
  assertDiscordGatewayCapture,
  assertOpenClawStateRoot,
  cleanupPairingSandbox,
  DISCORD_DM_CHANNEL,
  extractPairingResult,
  issuePairingRequest,
  PAIRING_USER,
  pairingEnv,
  pairingRedactions,
  runDiscordGatewayProof,
  startFakeDiscordGateway,
  writePairingArtifacts,
} from "./openclaw-pairing-helpers.ts";
import {
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  resultText,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-discord-pairing";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "test-fake-discord-pairing-e2e";
const LIVE_TIMEOUT_MS = 55 * 60_000;

test.skipIf(!shouldRunLiveE2E())(
  "OpenClaw Discord pairing request is shared with connect-shell approval",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = pairingEnv({
      sandboxName: SANDBOX_NAME,
      apiKey,
      channel: "discord",
      discordToken: DISCORD_TOKEN,
    });
    const redactions = pairingRedactions({ apiKey, discordToken: DISCORD_TOKEN });

    await artifacts.target.declare({
      id: "openclaw-discord-pairing",
      boundary:
        "install.sh Discord OpenClaw sandbox + fake Discord Gateway token rewrite + runtime pairing request + connect-shell approval",
      sandboxName: SANDBOX_NAME,
      pairingUser: PAIRING_USER.discord,
      dmChannel: DISCORD_DM_CHANNEL,
    });

    cleanup.add(`destroy Discord pairing sandbox ${SANDBOX_NAME}`, () =>
      cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "cleanup-discord-pairing"),
    );
    await cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "preclean-discord-pairing");

    const docker = await dockerInfo(host, env);
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "install-discord-pairing",
      skip,
      "NVIDIA endpoint validation was rate-limited before Discord pairing assertions ran",
    );
    expectExitZero(install, "install.sh --non-interactive with Discord");
    await expectSandboxReady(host, SANDBOX_NAME, env, redactions, "sandbox-list-discord-pairing");

    const provider = await host.command(
      "openshell",
      ["provider", "get", `${SANDBOX_NAME}-discord-bridge`],
      {
        artifactName: "provider-get-discord-pairing",
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      },
    );
    expectExitZero(provider, "Discord provider exists");

    const configScript =
      "import json; cfg=json.load(open('/sandbox/.openclaw/openclaw.json')); account=(cfg.get('channels',{}).get('discord',{}).get('accounts',{}).get('default') or {}); proxy=cfg.get('proxy') or {}; print(json.dumps({'token': account.get('token',''), 'dmPolicy': account.get('dmPolicy',''), 'allowFrom': account.get('allowFrom', []), 'accountProxy': account.get('proxy',''), 'managedProxy': proxy.get('proxyUrl','')}))";
    const config = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      `python3 -c ${shellQuote(configScript)}`,
      { artifactName: "discord-openclaw-config", redactionValues: redactions },
    );
    expectExitZero(config, "Discord OpenClaw config");
    const configSummary = JSON.parse(config.stdout.trim()) as {
      token: string;
      dmPolicy: string;
      allowFrom: string[];
      accountProxy: string;
      managedProxy: string;
    };
    expect(configSummary.token).toContain("openshell:resolve:env:");
    expect(configSummary.token).toContain("DISCORD_BOT_TOKEN");
    expect(configSummary.dmPolicy).not.toBe("allowlist");
    expect(configSummary.accountProxy, "Discord account proxy").toBe("");
    expect(configSummary.managedProxy, "OpenClaw managed proxy").toMatch(/^http:\/\//);

    await assertOpenClawStateRoot(sandbox, SANDBOX_NAME, "discord", redactions);

    const fakeGateway = await startFakeDiscordGateway(
      host,
      cleanup,
      env,
      DISCORD_TOKEN,
      redactions,
    );
    await applyFakePolicy({
      host,
      sandboxName: SANDBOX_NAME,
      api: fakeGateway,
      protocol: "websocket",
      rewrite: "websocket-credential-rewrite",
      env,
      redactions,
      artifactName: "apply-discord-gateway-policy",
    });
    const gatewayProof = await runDiscordGatewayProof({
      sandbox,
      sandboxName: SANDBOX_NAME,
      port: fakeGateway.port,
      redactions,
    });
    expectExitZero(gatewayProof, "Discord Gateway protocol proof");
    expect(resultText(gatewayProof)).toContain("UPGRADE");
    expect(resultText(gatewayProof)).toContain("HELLO");
    expect(resultText(gatewayProof)).toContain("IDENTIFY_SENT_PLACEHOLDER");
    expect(resultText(gatewayProof)).toContain("READY");
    expect(resultText(gatewayProof)).toContain("HEARTBEAT_ACK");
    assertDiscordGatewayCapture(fakeGateway.captureFile, DISCORD_TOKEN);

    const issue = await issuePairingRequest({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "discord",
      redactions,
    });
    expectExitZero(issue, "Discord pairing request creation");
    const pairing = extractPairingResult(resultText(issue), "DISCORD_PAIRING_E2E_RESULT");
    expect(pairing.senderId).toBe(PAIRING_USER.discord);
    expect(pairing.channelId).toBe(DISCORD_DM_CHANNEL);
    expect(pairing.replyText, "Discord pairing reply includes generated code").toContain(
      pairing.code,
    );
    expect(pairing.replyText, "Discord pairing reply includes sender identity").toContain(
      PAIRING_USER.discord,
    );
    await writePairingArtifacts(artifacts, "discord", { ...pairing, user: PAIRING_USER.discord });

    await approveAndAssertPairing({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "discord",
      code: pairing.code,
      redactions,
    });
  },
);
