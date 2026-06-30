// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  applyFakePolicy,
  approveAndAssertPairing,
  assertOpenClawStateRoot,
  assertSlackPresetPolicySemantics,
  cleanupPairingSandbox,
  extractPairingCode,
  issuePairingRequest,
  PAIRING_USER,
  pairingEnv,
  pairingRedactions,
  startFakeSlackApi,
  writePairingArtifacts,
} from "./openclaw-pairing-helpers.ts";
import {
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  resultText,
} from "./phase6-messaging-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-openclaw-slack-pairing";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-fake-slack-pairing-e2e";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "xapp-fake-slack-pairing-e2e";
const LIVE_TIMEOUT_MS = 55 * 60_000;

function assertSlackCapture(captureFile: string, expectedCode: string, expectedUser: string): void {
  const rows = fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const ws = rows
    .filter(
      (row) => row.event === "websocket-message" && row.messageType === "socket_mode_client_hello",
    )
    .at(-1);
  expect(ws, "fake Slack did not capture Socket Mode hello").toBeTruthy();
  expect(ws?.tokenMatchesExpected, "Slack xapp websocket token rewrite").toBe(true);
  expect(ws?.tokenLooksPlaceholder, "Slack xapp placeholder leaked").toBe(false);

  const post = rows
    .filter((row) => row.event === "request" && row.path === "/api/chat.postMessage")
    .at(-1);
  expect(post, "fake Slack did not capture chat.postMessage").toBeTruthy();
  expect(post?.authorization, "raw Slack authorization should not be captured").toBeUndefined();
  expect(post?.body, "raw Slack body should not be captured").toBeUndefined();
  expect(post?.tokenMatchesExpected, "Slack xoxb auth rewrite").toBe(true);
  expect(post?.bodyMatchesExpected, "Slack xoxb body rewrite").toBe(true);
  expect(post?.tokenLooksPlaceholder, "Slack xoxb placeholder leaked").toBe(false);
  expect(String(post?.text ?? ""), "Slack pairing reply includes generated code").toContain(
    expectedCode,
  );
  const replyText = String(post?.text ?? "");
  expect(
    replyText.includes(expectedUser) || replyText.includes(`Slack user ID: ${expectedUser}`),
    "Slack pairing reply includes sender identity",
  ).toBe(true);
}

test.skipIf(!shouldRunLiveE2E())(
  "OpenClaw Slack Socket Mode pairing request is shared with connect-shell approval",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const env = pairingEnv({
      sandboxName: SANDBOX_NAME,
      apiKey,
      channel: "slack",
      slackBot: SLACK_BOT_TOKEN,
      slackApp: SLACK_APP_TOKEN,
    });
    const redactions = pairingRedactions({
      apiKey,
      slackBot: SLACK_BOT_TOKEN,
      slackApp: SLACK_APP_TOKEN,
    });

    await artifacts.writeJson("target.json", {
      id: "openclaw-slack-pairing",
      boundary:
        "install.sh Slack OpenClaw sandbox + fake Slack REST/websocket token rewrite + runtime pairing request + connect-shell approval",
      sandboxName: SANDBOX_NAME,
      pairingUser: PAIRING_USER.slack,
    });

    cleanup.add(`destroy Slack pairing sandbox ${SANDBOX_NAME}`, () =>
      cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "cleanup-slack-pairing"),
    );
    await cleanupPairingSandbox(host, SANDBOX_NAME, env, redactions, "preclean-slack-pairing");

    const docker = await dockerInfo(host, env);
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const install = await installSandboxOrSkipOnRateLimit(
      host,
      env,
      redactions,
      "install-slack-pairing",
      skip,
      "NVIDIA endpoint validation was rate-limited before Slack pairing assertions ran",
    );
    expectExitZero(install, "install.sh --non-interactive with Slack");
    await expectSandboxReady(host, SANDBOX_NAME, env, redactions, "sandbox-list-slack-pairing");

    for (const providerName of [`${SANDBOX_NAME}-slack-bridge`, `${SANDBOX_NAME}-slack-app`]) {
      const provider = await host.command("openshell", ["provider", "get", providerName], {
        artifactName: `provider-get-${providerName}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      expectExitZero(provider, `${providerName} exists`);
    }

    await assertOpenClawStateRoot(sandbox, SANDBOX_NAME, "slack", redactions);
    await assertSlackPresetPolicySemantics({
      host,
      sandboxName: SANDBOX_NAME,
      env,
      redactions,
    });

    const fakeSlack = await startFakeSlackApi(
      host,
      cleanup,
      env,
      SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN,
      redactions,
    );
    await applyFakePolicy({
      host,
      sandboxName: SANDBOX_NAME,
      api: fakeSlack,
      protocol: "rest",
      rewrite: "request-body-credential-rewrite",
      env,
      redactions,
      artifactName: "apply-slack-rest-policy",
    });
    await applyFakePolicy({
      host,
      sandboxName: SANDBOX_NAME,
      api: fakeSlack,
      protocol: "websocket",
      rewrite: "websocket-credential-rewrite",
      env,
      redactions,
      artifactName: "apply-slack-websocket-policy",
    });

    const issue = await issuePairingRequest({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "slack",
      redactions,
      fakeSlackPort: fakeSlack.port,
    });
    expectExitZero(issue, "Slack pairing request creation");
    const code = extractPairingCode(resultText(issue), "PAIRING_E2E_RESULT");
    assertSlackCapture(fakeSlack.captureFile, code, PAIRING_USER.slack);
    await writePairingArtifacts(artifacts, "slack", { code, user: PAIRING_USER.slack });

    await approveAndAssertPairing({
      sandbox,
      sandboxName: SANDBOX_NAME,
      channel: "slack",
      code,
      redactions,
    });
  },
);
