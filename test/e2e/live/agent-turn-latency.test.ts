// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { normalizeMode } from "../fixtures/inference-adapter.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import {
  buildOpenClawFirstTurnLatencyEvidence,
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
  openclawTurn,
  responseBodyAndStatus,
  route,
} from "./agent-turn-latency-helpers.ts";

const TIMEOUT_MS = testTimeout(90 * 60_000);
const MAX_HOST_DISPATCH_OVERHEAD_MS = 60_000;

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
        "run OpenClaw hosted inference turn",
        "replace OpenClaw with Hermes sandbox",
        "validate Hermes inference route",
        "run Hermes hosted inference turn",
        "record hosted inference timing evidence",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    host,
    inference,
    lifecycle,
    progress,
    runtimeProvider,
    sandbox,
  }) => {
    const results: Record<string, unknown> = {
      model: inference.model,
      maxTurnSeconds: MAX_TURN_SECONDS,
      maxHostDispatchOverheadMs: MAX_HOST_DISPATCH_OVERHEAD_MS,
    };
    await artifacts.target.declare({
      id: "agent-turn-latency",
      boundary:
        "two real sandboxes + hosted inference + one OpenClaw host CLI JSON turn with open stdin + one Hermes API turn",
      openclawSandbox: OPENCLAW_SANDBOX,
      hermesSandbox: HERMES_SANDBOX,
    });
    lifecycle.trackInstallerGatewayUserService();
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

    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info",
      scenarioLabel: "agent-turn latency",
    });

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
    for (const expected of [inference.expectedRouteProvider, inference.model]) {
      expect(resultText(openclawRoute)).toContain(expected);
    }
    progress.phase("run OpenClaw hosted inference turn");
    const firstTurn = await openclawTurn(host, inference, progress, {
      artifactName: "openclaw-agent-turn",
      args: [
        "--json",
        "-m",
        "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      ],
      stdin: "open-pipe",
    });
    expect(firstTurn.result.exitCode, resultText(firstTurn.result)).toBe(0);
    const openclawAnswer = parseOpenClawAgentText(firstTurn.result.stdout);
    expect(containsAnswer(openclawAnswer, "42"), resultText(firstTurn.result)).toBe(true);
    expect(firstTurn.elapsedMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    const firstTurnTiming = buildOpenClawFirstTurnLatencyEvidence(
      firstTurn.result.stdout,
      firstTurn.elapsedMs,
    );
    // This excludes the reported agent duration, so slow inference cannot hide
    // a multi-minute wait in host dispatch, transport, or CLI startup.
    expect(
      firstTurnTiming.firstTurnHostOverheadMs,
      JSON.stringify(firstTurnTiming),
    ).toBeLessThanOrEqual(MAX_HOST_DISPATCH_OVERHEAD_MS);
    results.openclaw = {
      ...firstTurnTiming,
      answer: openclawAnswer,
      elapsedMs: firstTurn.elapsedMs,
      model: inference.model,
      provider: inference.expectedRouteProvider,
    };

    progress.phase("replace OpenClaw with Hermes sandbox");
    const openclawDestroy = await host.command(
      "node",
      [CLI, OPENCLAW_SANDBOX, "destroy", "--yes", "--cleanup-gateway"],
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
    for (const expected of [inference.expectedRouteProvider, inference.model]) {
      expect(resultText(hermesRoute)).toContain(expected);
    }

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
    const hermesAnswer = chatContent(hermesResponse.body);
    expect(hermesResponse.status, resultText(hermesTurn)).toBe("200");
    expect(containsAnswer(hermesAnswer, "42"), resultText(hermesTurn)).toBe(true);
    expect(hermesMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.hermes = {
      answer: hermesAnswer,
      elapsedMs: hermesMs,
      httpStatus: hermesResponse.status,
      model: inference.model,
      provider: inference.expectedRouteProvider,
    };
    progress.phase("record hosted inference timing evidence");
    await artifacts.writeJson("turn-latency-results.json", results);
  },
);
