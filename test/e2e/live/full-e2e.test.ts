// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsInteger42Answer } from "../../helpers/e2e-answer-assertions.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  maximumOutputSilenceMs,
  type OnboardTraceWindow,
  readOnboardTraceWindow,
} from "../fixtures/onboard-performance.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import {
  assertSecurityPosture,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";
import type { ShellProbeOutputEvent, ShellProbeResult } from "../fixtures/shell-probe.ts";
import { extractOpenClawAgentPayloadText } from "./agent-turn-latency-helpers.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-full";
const LIVE_TIMEOUT_MS = 50 * 60_000;
const FIRST_TURN_TIMEOUT_MS = 240_000;
const ONBOARD_BUDGET_SECS = 180;
const MAX_SILENCE_SECS = 60;
const EXPECTED_FIRST_REPLY = "NEMOCLAW_E2E_READY_6002";
const MEASURE_COLD_ONBOARD = process.env.E2E_TARGET_ID === "full-e2e";

interface ColdOnboardCapture {
  outputEvents: ShellProbeOutputEvent[];
  traceDirectory: string;
  traceFile: string;
}

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...securityPostureModeEnv(),
    ...extra,
  };
}

async function repoNemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 120_000,
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    timeoutMs,
  });
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await repoNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], "cleanup-nemoclaw-destroy").catch(
    () => undefined,
  );
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

function chatRequest(model: string): string {
  return JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      },
    ],
    max_tokens: 100,
  });
}

function parseReplyCommand(): string {
  return String.raw`python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["choices"][0]["message"]; print((m.get("content") or m.get("reasoning_content") or "").strip())'`;
}

function readAndDeleteTraceWindow(traceFile: string, traceDirectory: string): OnboardTraceWindow {
  try {
    return readOnboardTraceWindow(JSON.parse(fs.readFileSync(traceFile, "utf8")) as unknown);
  } catch (error) {
    throw new Error(
      `Cold onboard evidence requires a valid trace file with one successful nemoclaw.onboard root span: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    fs.rmSync(traceDirectory, { recursive: true, force: true });
  }
}

function createColdOnboardCapture(): ColdOnboardCapture | null {
  const traceDirectory = MEASURE_COLD_ONBOARD
    ? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-full-e2e-trace-"))
    : null;
  return traceDirectory
    ? {
        outputEvents: [],
        traceDirectory,
        traceFile: path.join(traceDirectory, "onboard.json"),
      }
    : null;
}

async function assertColdOnboardPerformance(input: {
  apiKey: string;
  artifacts: ArtifactSink;
  install: ShellProbeResult;
  outputEvents: readonly ShellProbeOutputEvent[];
  sandbox: SandboxClient;
  traceDirectory: string;
  traceFile: string;
}): Promise<void> {
  const traceWindow = readAndDeleteTraceWindow(input.traceFile, input.traceDirectory);
  const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const plain = resultText(input.install).replace(ansiSgr, "");
  const heartbeatCount = (plain.match(/Still working on /g) ?? []).length;
  const buildKitFallback = /Local BuildKit build [^\n]*using the gateway builder instead\./u.test(
    plain,
  );
  const usedBuildKitPrebuild =
    /Building sandbox image with BuildKit/u.test(plain) && !buildKitFallback;
  const classicBuildSteps = (plain.match(/Step \d+\/\d+ :/gu) ?? []).length;
  const maxSilenceMs = maximumOutputSilenceMs(traceWindow, input.outputEvents);
  const maxSilenceSecs = Math.ceil(maxSilenceMs / 1_000);

  const turn = await input.sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      "openclaw agent --agent main --json --thinking off --session-id e2e-6002 " +
        `-m 'Reply with exactly: ${EXPECTED_FIRST_REPLY}'`,
    ),
    {
      artifactName: "phase-1-first-agent-turn",
      env: env(),
      redactionValues: [input.apiKey],
      timeoutMs: FIRST_TURN_TIMEOUT_MS,
    },
  );
  const totalMs = Date.now() - traceWindow.startedAtMs;
  const totalSecs = Math.ceil(totalMs / 1_000);
  const turnText = resultText(turn);
  const assistantReply = extractOpenClawAgentPayloadText(turnText).trim();
  const compactAssistantReply = assistantReply.replace(/\s+/gu, "");
  const responseChars = assistantReply.length;

  await input.artifacts.writeJson("onboard-progress-budget.json", {
    sandbox: SANDBOX_NAME,
    installExitCode: input.install.exitCode,
    firstTurnExitCode: turn.exitCode,
    onboardSecs: Math.ceil(traceWindow.durationMs / 1_000),
    totalMs,
    totalSecs,
    budgetSecs: ONBOARD_BUDGET_SECS,
    heartbeatCount,
    maxSilenceSecs,
    maxSilenceBudgetSecs: MAX_SILENCE_SECS,
    buildKitFallback,
    usedBuildKitPrebuild,
    classicBuildSteps,
    responseChars,
  });

  expect(plain, "expected literal wizard step [1/8] in installer output").toContain("[1/8]");
  expect(buildKitFallback, "expected no fallback from BuildKit to the gateway builder").toBe(false);
  expect(usedBuildKitPrebuild, "expected the cold install to use BuildKit").toBe(true);
  expect(classicBuildSteps, "expected no classic per-instruction build steps").toBe(0);
  expect(
    maxSilenceSecs,
    `longest silent gap ${maxSilenceSecs}s exceeds the ${MAX_SILENCE_SECS}s guarantee`,
  ).toBeLessThanOrEqual(MAX_SILENCE_SECS);
  expect(turn.exitCode, turnText).toBe(0);
  expect(
    compactAssistantReply,
    `expected the sentinel first agent reply, got: ${turnText}`,
  ).toContain(EXPECTED_FIRST_REPLY);
  expect(
    totalMs,
    `[1/8]-to-first-response took ${totalSecs}s, over the ${ONBOARD_BUDGET_SECS}s budget`,
  ).toBeLessThanOrEqual(ONBOARD_BUDGET_SECS * 1_000);
}

test("full e2e: install, onboard, inference, cli operations, and cleanup", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
  const hosted = requireHostedInferenceConfig(secrets);
  const redactionValues = [hosted.apiKey];
  await artifacts.target.declare({
    id: "full-e2e",
    sandboxName: SANDBOX_NAME,
    endpointUrl: hosted.endpointUrl,
    model: hosted.model,
    contracts: [
      "install.sh --non-interactive completes onboarding",
      "nemoclaw and openshell are installed and usable",
      "sandbox appears in list/status and has policy/inference configuration",
      "direct hosted inference and sandbox inference.local both respond",
      "nemoclaw logs produces output and cleanup removes registry state",
      ...(securityPostureEnabled()
        ? ["non-root host, locked rc/proxy files, configure guard, and clean startup log"]
        : []),
    ],
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: env(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
    skip(`Docker is required: ${resultText(docker)}`);
  }

  cleanupRegistry.add("remove full-e2e sandbox", () => cleanup(host, sandbox));
  await cleanup(host, sandbox);

  const coldOnboard = createColdOnboardCapture();
  coldOnboard &&
    cleanupRegistry.add("remove raw full-e2e trace", async () => {
      fs.rmSync(coldOnboard.traceDirectory, { recursive: true, force: true });
    });

  const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
    artifactName: "phase-1-install-sh",
    cwd: REPO_ROOT,
    env: env({
      ...hosted.env,
      NVIDIA_INFERENCE_API_KEY: hosted.apiKey,
      ...(coldOnboard ? { NEMOCLAW_TRACE_FILE: coldOnboard.traceFile } : {}),
    }),
    ...(coldOnboard
      ? { onOutput: (event: ShellProbeOutputEvent) => coldOnboard.outputEvents.push(event) }
      : {}),
    redactionValues,
    timeoutMs: 25 * 60_000,
  });
  expect(install.exitCode, resultText(install)).toBe(0);
  await (coldOnboard
    ? assertColdOnboardPerformance({
        apiKey: hosted.apiKey,
        artifacts,
        install,
        outputEvents: coldOnboard.outputEvents,
        sandbox,
        traceDirectory: coldOnboard.traceDirectory,
        traceFile: coldOnboard.traceFile,
      })
    : Promise.resolve());

  const pathProbe = await host.command(
    "bash",
    [
      "-lc",
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
    ],
    { artifactName: "phase-2-path-probe", env: env(), timeoutMs: 60_000 },
  );
  expect(pathProbe.exitCode, resultText(pathProbe)).toBe(0);
  expect(pathProbe.stdout).toContain("nemoclaw");
  expect(pathProbe.stdout).toContain("openshell");

  const list = await repoNemoclaw(host, ["list"], "phase-3-nemoclaw-list");
  expect(list.exitCode, resultText(list)).toBe(0);
  expect(list.stdout).toContain(SANDBOX_NAME);
  const status = await repoNemoclaw(host, [SANDBOX_NAME, "status"], "phase-3-nemoclaw-status");
  expect(status.exitCode, resultText(status)).toBe(0);

  const inference = await sandbox.openshell(["inference", "get"], {
    artifactName: "phase-3-openshell-inference-get",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(inference.exitCode, resultText(inference)).toBe(0);
  expect(resultText(inference)).toContain(hosted.model);

  const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
    artifactName: "phase-3-openshell-policy-get",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, resultText(policy)).toBe(0);
  expect(resultText(policy)).toMatch(/network_policies|egress/i);

  const direct = await host.command(
    "curl",
    [
      "-fsS",
      "--max-time",
      "60",
      "-H",
      `Authorization: Bearer ${hosted.apiKey}`,
      `${hosted.endpointUrl}/models`,
    ],
    {
      artifactName: "phase-4-direct-hosted-inference-models",
      env: env(),
      redactionValues,
      timeoutMs: 90_000,
    },
  );
  expect(direct.exitCode, resultText(direct)).toBe(0);
  expect(resultText(direct)).toContain("data");

  const sandboxInference = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      `curl -fsS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${chatRequest(hosted.model)}' | ${parseReplyCommand()}`,
    ],
    {
      artifactName: "phase-4-sandbox-inference-local",
      env: env(),
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expect(sandboxInference.exitCode, resultText(sandboxInference)).toBe(0);
  expect(containsInteger42Answer(sandboxInference.stdout), resultText(sandboxInference)).toBe(true);

  const logs = await repoNemoclaw(
    host,
    [SANDBOX_NAME, "logs"],
    "phase-5-nemoclaw-logs",
    {},
    90_000,
  );
  expect(logs.exitCode, resultText(logs)).toBe(0);
  expect(resultText(logs).trim().length, resultText(logs)).toBeGreaterThan(0);

  const securityPosture = securityPostureEnabled()
    ? await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw")
    : null;

  await cleanup(host, sandbox);
  const registry = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
  const registryText = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : "";
  expect(registryText).not.toContain(SANDBOX_NAME);

  await artifacts.target.complete({
    id: "full-e2e",
    securityPosture,
    status: "passed",
  });
});
