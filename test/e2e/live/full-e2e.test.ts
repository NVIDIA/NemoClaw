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
  type ColdOnboardPerformanceBudget,
  evaluateColdOnboardPerformance,
  maximumOutputSilenceMs,
  type OnboardTraceWindow,
  readColdOnboardPerformanceBudget,
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
const MAX_SILENCE_SECS = 60;
const EXPECTED_FIRST_REPLY = "NEMOCLAW_E2E_READY_6002";
const AUTHORITATIVE_LOCAL_BASE_BUILD_OUTPUT =
  "Building OpenClaw sandbox base image locally because no compatible published base image was found.";
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

function readFullE2eColdPathBudget() {
  try {
    return readColdOnboardPerformanceBudget(
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "ci", "onboard-performance-budget.json"), "utf8"),
      ) as unknown,
    );
  } catch (error) {
    throw new Error(
      `Full E2E cold-path performance budget is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function assertColdOnboardPerformance(input: {
  apiKey: string;
  artifacts: ArtifactSink;
  budget: ColdOnboardPerformanceBudget;
  install: ShellProbeResult;
  installCompletedAtMs: number;
  outputEvents: readonly ShellProbeOutputEvent[];
  sandbox: SandboxClient;
  traceDirectory: string;
  traceFile: string;
}): Promise<void> {
  const traceWindow = readAndDeleteTraceWindow(input.traceFile, input.traceDirectory);
  expect(
    input.installCompletedAtMs,
    "install completion must not precede the onboard root end",
  ).toBeGreaterThanOrEqual(traceWindow.finishedAtMs);
  const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const plain = resultText(input.install).replace(ansiSgr, "");
  const usedAuthoritativeLocalBaseBuild = plain.includes(AUTHORITATIVE_LOCAL_BASE_BUILD_OUTPUT);
  const heartbeatCount = (plain.match(/Still working on /g) ?? []).length;
  const buildKitFallback = /Local BuildKit build [^\n]*using the gateway builder instead\./u.test(
    plain,
  );
  const usedBuildKitPrebuild =
    /Building sandbox image with BuildKit/u.test(plain) && !buildKitFallback;
  const classicBuildSteps = (plain.match(/Step \d+\/\d+ :/gu) ?? []).length;
  const maxSilenceMs = maximumOutputSilenceMs(traceWindow, input.outputEvents);
  const maxSilenceSecs = Math.ceil(maxSilenceMs / 1_000);
  const rootEndToInstallCompletionMs = input.installCompletedAtMs - traceWindow.finishedAtMs;

  const firstTurnStartedAtMs = Date.now();
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
  const firstTurnCompletedAtMs = Date.now();
  const firstTurnCommandMs = firstTurnCompletedAtMs - firstTurnStartedAtMs;
  const performanceEvaluation = evaluateColdOnboardPerformance(
    traceWindow,
    firstTurnCompletedAtMs,
    input.budget,
    usedAuthoritativeLocalBaseBuild,
  );
  const rootStartToFirstTurnCompletionSecs = Math.ceil(
    performanceEvaluation.rootStartToFirstTurnCompletionMs / 1_000,
  );
  const turnText = resultText(turn);
  const assistantReply = extractOpenClawAgentPayloadText(turnText).trim();
  const compactAssistantReply = assistantReply.replace(/\s+/gu, "");
  const responseChars = assistantReply.length;

  await input.artifacts.writeJson("onboard-progress-budget.json", {
    schemaVersion: "nemoclaw.full_e2e_cold_performance.v2",
    sandbox: SANDBOX_NAME,
    installExitCode: input.install.exitCode,
    firstTurnExitCode: turn.exitCode,
    phaseMeasurements: {
      onboardRootMs: traceWindow.durationMs,
      rootStartToFirstTurnCompletionMs: performanceEvaluation.rootStartToFirstTurnCompletionMs,
      rootEndToInstallCompletionMs,
      firstTurnCommandMs,
      rootEndToFirstTurnCompletionMs: performanceEvaluation.rootEndToFirstTurnCompletionMs,
      tracePhasesMs: traceWindow.phaseDurationsMs,
    },
    onboardSecs: Math.ceil(traceWindow.durationMs / 1_000),
    rootStartToFirstTurnCompletionSecs,
    budget: input.budget,
    performance: {
      passed: performanceEvaluation.passed,
      violations: performanceEvaluation.violations,
      usedAuthoritativeLocalBaseBuild,
      appliedAuthoritativeLocalBaseBuildAllowanceMs:
        performanceEvaluation.appliedAuthoritativeLocalBaseBuildAllowanceMs,
    },
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
    performanceEvaluation.passed,
    `onboard-root-start-to-first-turn-completion took ${rootStartToFirstTurnCompletionSecs}s; ${performanceEvaluation.violations.join("; ")}`,
  ).toBe(true);
}

test("full e2e: install, onboard, inference, cli operations, and cleanup", {
  timeout: LIVE_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "check full E2E prerequisites",
      "install and onboard OpenClaw sandbox",
      "validate CLI sandbox and policy state",
      "exercise hosted and sandbox inference",
      "inspect runtime logs and security posture",
      "remove full-E2E sandbox",
    ],
  },
}, async ({ artifacts, cleanup: cleanupRegistry, host, progress, sandbox, secrets, skip }) => {
  const hosted = requireHostedInferenceConfig(secrets);
  const coldOnboardBudget = readFullE2eColdPathBudget();
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

  cleanupRegistry.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway-destroy",
    env: env(),
    redactionValues: [hosted.apiKey],
    timeoutMs: 60_000,
  });
  cleanupRegistry.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      redactionValues: [hosted.apiKey],
      timeoutMs: 60_000,
    }),
  );
  cleanupRegistry.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy",
    env: env(),
    redactionValues: [hosted.apiKey],
    timeoutMs: 120_000,
  });
  await cleanup(host, sandbox);

  const coldOnboard = createColdOnboardCapture();
  coldOnboard &&
    cleanupRegistry.trackDisposable("remove raw full-e2e trace", async () => {
      fs.rmSync(coldOnboard.traceDirectory, { recursive: true, force: true });
    });

  progress.phase("install and onboard OpenClaw sandbox");
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
  const installCompletedAtMs = Date.now();
  expect(install.exitCode, resultText(install)).toBe(0);
  await (coldOnboard
    ? assertColdOnboardPerformance({
        apiKey: hosted.apiKey,
        artifacts,
        budget: coldOnboardBudget,
        install,
        installCompletedAtMs,
        outputEvents: coldOnboard.outputEvents,
        sandbox,
        traceDirectory: coldOnboard.traceDirectory,
        traceFile: coldOnboard.traceFile,
      })
    : Promise.resolve());

  progress.phase("validate CLI sandbox and policy state");
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

  progress.phase("exercise hosted and sandbox inference");
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

  progress.phase("inspect runtime logs and security posture");
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

  progress.phase("remove full-E2E sandbox");
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
