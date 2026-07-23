// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { containsInteger42Answer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertHermesConfig,
  assertNoOpenClawTransportErrors,
  assertOpenClawConfig,
  CLI,
  chatContent,
  cleanupTurnSandbox,
  cleanupTurnSandboxes,
  EXPECTED_ROUTE_PROVIDER,
  env,
  extractOpenClawAgentText,
  HERMES_SANDBOX,
  hermesTurnCommand,
  installSandbox,
  MAX_TURN_SECONDS,
  MODEL,
  OPENCLAW_SANDBOX,
  openclawConfigCommand,
  openclawTurn,
  responseBodyAndStatus,
  route,
  waitHermesHealth,
} from "./agent-turn-latency-helpers.ts";

const TIMEOUT_MS = 90 * 60_000;

test("OpenClaw and Hermes complete real hosted inference turns within the latency cap", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "prepare clean inference hosts",
      "install OpenClaw sandbox",
      "validate OpenClaw inference route",
      "run OpenClaw hosted inference turn",
      "replace OpenClaw with Hermes sandbox",
      "validate Hermes inference route",
      "run Hermes hosted inference turn",
      "remove provisioned sandboxes",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets }) => {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const results: Record<string, unknown> = { model: MODEL, maxTurnSeconds: MAX_TURN_SECONDS };
  await artifacts.target.declare({
    id: "agent-turn-latency",
    boundary: "two real sandboxes + hosted inference + OpenClaw agent turn + Hermes API turn",
    openclawSandbox: OPENCLAW_SANDBOX,
    hermesSandbox: HERMES_SANDBOX,
  });
  cleanup.trackDisposable("remove gateway nemoclaw", async () => {
    await host.cleanupGatewayRegistration("nemoclaw", {
      artifactName: "cleanup-gateway-destroy-turn-latency",
      env: buildAvailabilityProbeEnv(),
      onOutput: progress.onOutput,
      timeoutMs: 60_000,
    });
  });
  cleanup.trackDisposable("stop forward 8642", async () => {
    await host.cleanupForward(8642, {
      artifactName: "cleanup-forward-stop-hermes-api",
      env: buildAvailabilityProbeEnv(),
      onOutput: progress.onOutput,
      timeoutMs: 30_000,
    });
  });
  cleanup.trackDisposable("delete Hermes OpenShell sandbox", async () => {
    await sandbox.cleanupSandbox(HERMES_SANDBOX, {
      artifactName: "cleanup-hermes-delete",
      env: env(HERMES_SANDBOX, "hermes"),
      onOutput: progress.onOutput,
      timeoutMs: 60_000,
    });
  });
  cleanup.trackDisposable("destroy Hermes sandbox", async () => {
    await cleanupTurnSandbox(host, HERMES_SANDBOX, "hermes", progress);
  });
  cleanup.trackDisposable("delete OpenClaw OpenShell sandbox", async () => {
    await sandbox.cleanupSandbox(OPENCLAW_SANDBOX, {
      artifactName: "cleanup-openclaw-delete",
      env: env(OPENCLAW_SANDBOX, "openclaw"),
      onOutput: progress.onOutput,
      timeoutMs: 60_000,
    });
  });
  cleanup.trackDisposable("destroy OpenClaw sandbox", async () => {
    await cleanupTurnSandbox(host, OPENCLAW_SANDBOX, "openclaw", progress);
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "docker-info",
    env: buildAvailabilityProbeEnv(),
    onOutput: progress.onOutput,
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, resultText(docker)).toBe(0);

  const cleanBeforeRetry = () => cleanupTurnSandboxes(host, sandbox, progress);
  await cleanupTurnSandboxes(host, sandbox, progress);
  progress.phase("install OpenClaw sandbox");
  const openclawInstall = await installSandbox(
    host,
    OPENCLAW_SANDBOX,
    "openclaw",
    apiKey,
    cleanBeforeRetry,
    progress,
  );
  expect(openclawInstall.exitCode, resultText(openclawInstall)).toBe(0);
  progress.phase("validate OpenClaw inference route");
  const openclawRoute = await route(
    sandbox,
    OPENCLAW_SANDBOX,
    "openclaw",
    "openclaw-route",
    progress,
  );
  expect(openclawRoute.exitCode, resultText(openclawRoute)).toBe(0);
  expect(resultText(openclawRoute)).toContain(EXPECTED_ROUTE_PROVIDER);
  expect(resultText(openclawRoute)).toContain(MODEL);
  const openclawConfig = await sandbox.execShell(
    OPENCLAW_SANDBOX,
    trustedSandboxShellScript(openclawConfigCommand()),
    {
      artifactName: "openclaw-config",
      env: env(OPENCLAW_SANDBOX, "openclaw"),
      onOutput: progress.onOutput,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(openclawConfig.exitCode, resultText(openclawConfig)).toBe(0);
  assertOpenClawConfig(openclawConfig.stdout, MODEL);

  progress.phase("run OpenClaw hosted inference turn");
  const openclaw = await openclawTurn(sandbox, apiKey, progress);
  expect(openclaw.result.exitCode, resultText(openclaw.result)).toBe(0);
  assertNoOpenClawTransportErrors(resultText(openclaw.result));
  expect(
    containsInteger42Answer(extractOpenClawAgentText(openclaw.result.stdout)),
    resultText(openclaw.result),
  ).toBe(true);
  expect(openclaw.elapsedMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
  results.openclaw = { elapsedMs: openclaw.elapsedMs };

  progress.phase("replace OpenClaw with Hermes sandbox");
  await host.command("node", [CLI, OPENCLAW_SANDBOX, "destroy", "--yes"], {
    artifactName: "destroy-openclaw-before-hermes",
    env: env(OPENCLAW_SANDBOX, "openclaw"),
    onOutput: progress.onOutput,
    timeoutMs: 120_000,
  });

  const hermesInstall = await installSandbox(
    host,
    HERMES_SANDBOX,
    "hermes",
    apiKey,
    cleanBeforeRetry,
    progress,
  );
  expect(hermesInstall.exitCode, resultText(hermesInstall)).toBe(0);
  progress.phase("validate Hermes inference route");
  const hermesRoute = await route(sandbox, HERMES_SANDBOX, "hermes", "hermes-route", progress);
  expect(hermesRoute.exitCode, resultText(hermesRoute)).toBe(0);
  expect(resultText(hermesRoute)).toContain(EXPECTED_ROUTE_PROVIDER);
  expect(resultText(hermesRoute)).toContain(MODEL);
  const hermesHealth = await waitHermesHealth(sandbox, progress);
  expect(hermesHealth.exitCode, resultText(hermesHealth)).toBe(0);
  const hermesConfig = await sandbox.exec(HERMES_SANDBOX, ["cat", "/sandbox/.hermes/config.yaml"], {
    artifactName: "hermes-config",
    env: env(HERMES_SANDBOX, "hermes"),
    onOutput: progress.onOutput,
    redactionValues: [apiKey],
    timeoutMs: 30_000,
  });
  expect(hermesConfig.exitCode, resultText(hermesConfig)).toBe(0);
  assertHermesConfig(hermesConfig.stdout, MODEL);

  const payload = JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      },
    ],
    max_tokens: 64,
  });
  progress.phase("run Hermes hosted inference turn");
  const hermesStarted = process.hrtime.bigint();
  const hermesTurn = await sandbox.execShell(
    HERMES_SANDBOX,
    trustedSandboxShellScript(hermesTurnCommand(payload)),
    {
      artifactName: "hermes-api-turn",
      env: env(HERMES_SANDBOX, "hermes"),
      onOutput: progress.onOutput,
      redactionValues: [apiKey],
      timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
    },
  );
  const hermesMs = Number((process.hrtime.bigint() - hermesStarted) / 1_000_000n);
  expect(hermesTurn.exitCode, resultText(hermesTurn)).toBe(0);
  const hermesResponse = responseBodyAndStatus(hermesTurn.stdout);
  expect(hermesResponse.status, resultText(hermesTurn)).toBe("200");
  expect(containsInteger42Answer(chatContent(hermesResponse.body)), resultText(hermesTurn)).toBe(
    true,
  );
  expect(hermesMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
  results.hermes = { elapsedMs: hermesMs };
  await artifacts.writeJson("turn-latency-results.json", results);
  progress.phase("remove provisioned sandboxes");
  fs.writeFileSync(
    artifacts.pathFor("agent-turn-latency-results-legacy-path.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
});
