// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
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

const TIMEOUT_MS = testTimeout(90 * 60_000);

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
  async ({ artifacts, cleanup, host, inference, progress, runtimeProvider, sandbox }) => {
    const results: Record<string, unknown> = {
      model: inference.model,
      maxTurnSeconds: MAX_TURN_SECONDS,
    };
    await artifacts.target.declare({
      id: "agent-turn-latency",
      boundary:
        "two real sandboxes + hosted inference + host CLI agent turns with open stdin + Hermes API turn",
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
    const messageFile = "/sandbox/e2e-turn-message.txt";
    const stdinLink = "/sandbox/e2e-turn-stdin";
    const stdinChain = "/sandbox/e2e-turn-stdin-chain";
    const filePrompt = "Reply with exactly FILE_MESSAGE_OK and no other text.";
    for (const setup of [
      { name: "file", command: ["tee", messageFile], stdin: { text: filePrompt } },
      { name: "stdin-link", command: ["ln", "-s", "/dev/stdin", stdinLink], stdin: undefined },
      {
        name: "stdin-chain",
        command: ["ln", "-s", "e2e-turn-stdin", stdinChain],
        stdin: undefined,
      },
    ]) {
      const result = await sandbox.exec(OPENCLAW_SANDBOX, setup.command, {
        artifactName: `prepare-agent-message-${setup.name}`,
        env: env(OPENCLAW_SANDBOX, "openclaw", inference),
        stdin: setup.stdin,
        onOutput: progress.onOutput,
        timeoutMs: 30_000,
      });
      expect(result.exitCode, resultText(result)).toBe(0);
    }

    const formats = [
      { name: "json", args: ["--json"], readText: parseOpenClawAgentText },
      { name: "text", args: [], readText: (raw: string) => raw },
    ];
    const fileInputs = [
      {
        name: "regular-file-with-stdin",
        path: messageFile,
        stdin: { text: "Reply with exactly WRONG_STDIN_SOURCE and no other text." },
        expected: "FILE_MESSAGE_OK",
      },
      { name: "regular-file", path: messageFile, stdin: undefined, expected: "FILE_MESSAGE_OK" },
      {
        name: "stdin-file",
        path: "/dev/stdin",
        stdin: { text: "Reply with exactly STDIN_MESSAGE_OK and no other text." },
        expected: "STDIN_MESSAGE_OK",
      },
      {
        name: "stdin-symlink",
        path: stdinLink,
        stdin: { text: "Reply with exactly SYMLINK_MESSAGE_OK and no other text." },
        expected: "SYMLINK_MESSAGE_OK",
      },
      {
        name: "stdin-chain",
        path: stdinChain,
        stdin: { text: "Reply with exactly CHAIN_MESSAGE_OK and no other text." },
        expected: "CHAIN_MESSAGE_OK",
      },
    ];
    const turns: Array<{
      artifactName: string;
      args: string[];
      stdin?: ShellProbeRunOptions["stdin"];
      expected: string;
      readText: (raw: string) => string;
    }> = [
      {
        artifactName: "openclaw-agent-turn",
        args: [
          "--json",
          "-m",
          "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
        ],
        stdin: "open-pipe",
        expected: "42",
        readText: parseOpenClawAgentText,
      },
      {
        artifactName: "openclaw-agent-follow-up-turn",
        args: [
          "--verbose",
          "off",
          "--timeout",
          "60",
          "-m",
          "What is seven multiplied by eight? Reply with only the integer, no extra words.",
        ],
        stdin: "open-pipe",
        expected: "56",
        readText: (raw: string) => raw,
      },
      {
        artifactName: "openclaw-agent-explicit-local-turn",
        args: ["--local", "-m", "Reply with exactly LOCAL_MODE_OK and no other text."],
        stdin: "open-pipe",
        expected: "LOCAL_MODE_OK",
        readText: (raw: string) => raw,
      },
      ...fileInputs.flatMap((input) =>
        formats.map((format) => ({
          artifactName: `openclaw-agent-${input.name}-${format.name}`,
          args: [...format.args, "--message-file", input.path],
          stdin: input.stdin,
          expected: input.expected,
          readText: format.readText,
        })),
      ),
    ];
    const turnTimes: Record<string, number> = {};
    for (const turn of turns) {
      progress.event(`OpenClaw turn: ${turn.artifactName}`);
      const completed = await openclawTurn(host, inference, progress, turn);
      expect(completed.result.exitCode, resultText(completed.result)).toBe(0);
      assertNoOpenClawTransportErrors(resultText(completed.result));
      expect(
        containsAnswer(turn.readText(completed.result.stdout), turn.expected),
        resultText(completed.result),
      ).toBe(true);
      expect(completed.elapsedMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
      turnTimes[turn.artifactName] = completed.elapsedMs;
    }
    const emptyInput = await openclawTurn(host, inference, progress, {
      artifactName: "openclaw-agent-empty-stdin-file",
      args: ["--json", "--message-file", stdinLink],
      stdin: { text: "" },
    });
    expect(emptyInput.result.exitCode, resultText(emptyInput.result)).not.toBe(0);
    expect(resultText(emptyInput.result)).toContain("Message file is empty");
    assertNoOpenClawTransportErrors(resultText(emptyInput.result));

    results.openclaw = {
      firstTurnElapsedMs: turnTimes["openclaw-agent-turn"],
      followUpTurnElapsedMs: turnTimes["openclaw-agent-follow-up-turn"],
      turns: turnTimes,
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
    expect(containsAnswer(chatContent(hermesResponse.body), "42"), resultText(hermesTurn)).toBe(
      true,
    );
    expect(hermesMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.hermes = { elapsedMs: hermesMs };
    progress.phase("record hosted inference timing evidence");
    await artifacts.writeJson("turn-latency-results.json", results);
  },
);
