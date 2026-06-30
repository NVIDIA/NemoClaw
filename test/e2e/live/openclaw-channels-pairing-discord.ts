// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "../fixtures/e2e-test.ts";
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
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME =
  process.env.NEMOCLAW_DISCORD_PAIRING_SANDBOX_NAME ?? "e2e-openclaw-channels-pairing-discord";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "test-fake-discord-pairing-e2e";

export const OPENCLAW_DISCORD_PAIRING_TIMEOUT_MS = 55 * 60_000;

export async function runOpenClawDiscordPairing({
  artifacts,
  cleanup,
  host,
  sandbox,
  secrets,
  skip,
}: import("../fixtures/e2e-test.ts").E2ETargetFixtures & {
  skip: (note?: string) => never;
}): Promise<void> {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const env = pairingEnv({
    sandboxName: SANDBOX_NAME,
    apiKey,
    channel: "discord",
    discordToken: DISCORD_TOKEN,
  });
  const redactions = pairingRedactions({ apiKey, discordToken: DISCORD_TOKEN });

  await artifacts.writeJson("discord-target.json", {
    id: "openclaw-channels-pairing",
    case: "discord",
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

  await assertOpenClawStateRoot(sandbox, SANDBOX_NAME, "discord", redactions);

  const fakeGateway = await startFakeDiscordGateway(host, cleanup, env, DISCORD_TOKEN, redactions);
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
}
