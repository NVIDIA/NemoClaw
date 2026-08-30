// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { normalizeMode } from "../fixtures/inference-adapter.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import {
  assertHermesConfig,
  assertNoOpenClawTransportErrors,
  assertOpenClawConfig,
  CLI,
  chatContent,
  cleanupTurnSandbox,
  cleanupTurnSandboxes,
  env,
  HERMES_SANDBOX,
  hermesTurnCommand,
  installSandbox,
  MAX_TURN_SECONDS,
  OPENCLAW_SANDBOX,
  openclawConfigCommand,
  openclawTurn,
  responseBodyAndStatus,
  route,
  waitHermesHealth,
} from "./agent-turn-latency-helpers.ts";

const TIMEOUT_MS = 90 * 60_000;

// A real latency measurement needs a real hosted endpoint; the shared
// adapter's hermetic `mock` mode would just measure a loopback round trip
// and report a meaningless number. Select `internal-nvidia` or
// `public-nvidia` via NEMOCLAW_E2E_INFERENCE_MODE for this target. Resolved
// at module scope (matching issue-4434's runIssue4434LiveTest pattern) so
// the skip is a test-definition boundary, not a conditional test body.
const runAgentTurnLatencyTest = test.skipIf(normalizeMode(process.env) === "mock");

runAgentTurnLatencyTest(
  "OpenClaw and Hermes complete real hosted inference turns within the latency cap",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean inference hosts",
        "install OpenClaw sandbox",
        "validate OpenClaw inference route",
        "run OpenClaw hosted inference turns",
        "replace OpenClaw with Hermes sandbox",
        "validate Hermes inference route",
        "run Hermes hosted inference turn",
        "record hosted inference timing evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, inference, progress, sandbox }) => {
    const results: Record<string, unknown> = {
      model: inference.model,
      maxTurnSeconds: MAX_TURN_SECONDS,
    };
    await artifacts.target.declare({
      id: "agent-turn-latency",
      boundary: "two real sandboxes + hosted inference + OpenClaw agent turns + Hermes API turn",
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
        env: env(HERMES_SANDBOX, "hermes", inference),
        onOutput: progress.onOutput,
        timeoutMs: 60_000,
      });
    });
    cleanup.trackDisposable("destroy Hermes sandbox", async () => {
      await cleanupTurnSandbox(host, HERMES_SANDBOX, "hermes", inference, progress);
    });
    cleanup.trackDisposable("delete OpenClaw OpenShell sandbox", async () => {
      await sandbox.cleanupSandbox(OPENCLAW_SANDBOX, {
        artifactName: "cleanup-openclaw-delete",
        env: env(OPENCLAW_SANDBOX, "openclaw", inference),
        onOutput: progress.onOutput,
        timeoutMs: 60_000,
      });
    });
    cleanup.trackDisposable("destroy OpenClaw sandbox", async () => {
      await cleanupTurnSandbox(host, OPENCLAW_SANDBOX, "openclaw", inference, progress);
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      onOutput: progress.onOutput,
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const cleanBeforeRetry = () => cleanupTurnSandboxes(host, sandbox, inference, progress);
    await cleanupTurnSandboxes(host, sandbox, inference, progress);
    progress.phase("install OpenClaw sandbox");
    const openclawInstall = await installSandbox(
      host,
      OPENCLAW_SANDBOX,
      "openclaw",
      inference,
      cleanBeforeRetry,
      progress,
    );
    expect(openclawInstall.exitCode, resultText(openclawInstall)).toBe(0);
    progress.phase("validate OpenClaw inference route");
    const openclawRoute = await route(
      sandbox,
      OPENCLAW_SANDBOX,
      "openclaw",
      inference,
      "openclaw-route",
      progress,
    );
    expect(openclawRoute.exitCode, resultText(openclawRoute)).toBe(0);
    expect(resultText(openclawRoute)).toContain(inference.expectedRouteProvider);
    expect(resultText(openclawRoute)).toContain(inference.model);
    const openclawConfig = await sandbox.execShell(
      OPENCLAW_SANDBOX,
      trustedSandboxShellScript(openclawConfigCommand()),
      {
        artifactName: "openclaw-config",
        env: env(OPENCLAW_SANDBOX, "openclaw", inference),
        onOutput: progress.onOutput,
        redactionValues: inference.redactionValues(),
        timeoutMs: 30_000,
      },
    );
    expect(openclawConfig.exitCode, resultText(openclawConfig)).toBe(0);
    assertOpenClawConfig(openclawConfig.stdout, inference.model);

    progress.phase("run OpenClaw hosted inference turns");
    const openclaw = await openclawTurn(sandbox, inference, progress);
    expect(openclaw.result.exitCode, resultText(openclaw.result)).toBe(0);
    assertNoOpenClawTransportErrors(resultText(openclaw.result));
    expect(
      containsAnswer(parseOpenClawAgentText(openclaw.result.stdout), "42"),
      resultText(openclaw.result),
    ).toBe(true);
    expect(openclaw.elapsedMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);

    const openclawFollowUp = await openclawTurn(sandbox, inference, progress, {
      artifactName: "openclaw-agent-follow-up-turn",
      prompt: "What is seven multiplied by eight? Reply with only the integer, no extra words.",
    });
    expect(openclawFollowUp.result.exitCode, resultText(openclawFollowUp.result)).toBe(0);
    assertNoOpenClawTransportErrors(resultText(openclawFollowUp.result));
    expect(
      containsAnswer(parseOpenClawAgentText(openclawFollowUp.result.stdout), "56"),
      resultText(openclawFollowUp.result),
    ).toBe(true);
    expect(openclawFollowUp.elapsedMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.openclaw = {
      firstTurnElapsedMs: openclaw.elapsedMs,
      followUpTurnElapsedMs: openclawFollowUp.elapsedMs,
    };

    progress.phase("replace OpenClaw with Hermes sandbox");
    const openclawDestroy = await host.command(
      "node",
      [CLI, OPENCLAW_SANDBOX, "destroy", "--yes"],
      {
        artifactName: "destroy-openclaw-before-hermes",
        env: env(OPENCLAW_SANDBOX, "openclaw", inference),
        onOutput: progress.onOutput,
        timeoutMs: 120_000,
      },
    );
    expect(openclawDestroy.exitCode, resultText(openclawDestroy)).toBe(0);

    const hermesInstall = await installSandbox(
      host,
      HERMES_SANDBOX,
      "hermes",
      inference,
      cleanBeforeRetry,
      progress,
    );
    expect(hermesInstall.exitCode, resultText(hermesInstall)).toBe(0);
    progress.phase("validate Hermes inference route");
    const hermesRoute = await route(
      sandbox,
      HERMES_SANDBOX,
      "hermes",
      inference,
      "hermes-route",
      progress,
    );
    expect(hermesRoute.exitCode, resultText(hermesRoute)).toBe(0);
    expect(resultText(hermesRoute)).toContain(inference.expectedRouteProvider);
    expect(resultText(hermesRoute)).toContain(inference.model);
    const hermesHealth = await waitHermesHealth(sandbox, inference, progress);
    expect(hermesHealth.exitCode, resultText(hermesHealth)).toBe(0);
    const hermesConfig = await sandbox.exec(
      HERMES_SANDBOX,
      ["cat", "/sandbox/.hermes/config.yaml"],
      {
        artifactName: "hermes-config",
        env: env(HERMES_SANDBOX, "hermes", inference),
        onOutput: progress.onOutput,
        redactionValues: inference.redactionValues(),
        timeoutMs: 30_000,
      },
    );
    expect(hermesConfig.exitCode, resultText(hermesConfig)).toBe(0);
    assertHermesConfig(hermesConfig.stdout, inference.model);

    const payload = JSON.stringify({
      model: inference.model,
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
        env: env(HERMES_SANDBOX, "hermes", inference),
        onOutput: progress.onOutput,
        redactionValues: inference.redactionValues(),
        timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
      },
    );
    const hermesMs = Number((process.hrtime.bigint() - hermesStarted) / 1_000_000n);
    expect(hermesTurn.exitCode, resultText(hermesTurn)).toBe(0);
    const hermesResponse = responseBodyAndStatus(hermesTurn.stdout);
    expect(hermesResponse.status, resultText(hermesTurn)).toBe("200");
    expect(containsAnswer(chatContent(hermesResponse.body), "42"), resultText(hermesTurn)).toBe(true);
    expect(hermesMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.hermes = { elapsedMs: hermesMs };
    progress.phase("record hosted inference timing evidence");
    await artifacts.writeJson("turn-latency-results.json", results);
  },
);
