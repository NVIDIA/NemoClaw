// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { trustedProviderEndpoint } from "../fixtures/clients/provider.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  DEFAULT_HOSTED_INFERENCE_MODEL,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  assertSecurityPosture,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Migrated from test/e2e/test-hermes-e2e.sh.
//
// This is intentionally a direct live Vitest test, not a new registry layer:
// the legacy contract is the real installer/onboard/runtime boundary for Hermes.
// Vitest owns artifacts, cleanup, redaction, and timeouts while still spawning
// `bash install.sh --non-interactive`, `nemoclaw`, `openshell`, sandbox exec,
// direct NVIDIA Endpoints curl, and inference.local probes.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes";
validateSandboxName(SANDBOX_NAME);
const HERMES_HEALTH_URL = "http://localhost:8642/health";
const HERMES_HOST_HEALTH_URL = "http://127.0.0.1:8642/health";
const HERMES_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const HERMES_DASHBOARD_INTERNAL_PORT =
  process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ?? "19119";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const LIVE_TIMEOUT_MS = 70 * 60_000;
const CHAT_MODEL = process.env.NEMOCLAW_MODEL ?? DEFAULT_HOSTED_INFERENCE_MODEL;
const ONBOARD_VALIDATION_TIMEOUT_SECONDS =
  process.env.NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS ?? "60";

interface OpenAiChoiceLike {
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
  text?: unknown;
  finish_reason?: unknown;
}

interface OpenAiChatLike {
  choices?: OpenAiChoiceLike[];
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function truthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function hermesDashboardE2eEnabled(): boolean {
  return (
    truthyEnv(process.env.NEMOCLAW_E2E_HERMES_DASHBOARD) ||
    truthyEnv(process.env.NEMOCLAW_HERMES_DASHBOARD)
  );
}

function commandEnv(hostedEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    ...hostedEnv,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_MODEL: hostedEnv.NEMOCLAW_MODEL ?? CHAT_MODEL,
    NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS: ONBOARD_VALIDATION_TIMEOUT_SECONDS,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    ...securityPostureModeEnv(),
  };
  if (process.env.NEMOCLAW_E2E_HERMES_DASHBOARD) {
    env.NEMOCLAW_E2E_HERMES_DASHBOARD = process.env.NEMOCLAW_E2E_HERMES_DASHBOARD;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD) {
    env.NEMOCLAW_HERMES_DASHBOARD = process.env.NEMOCLAW_HERMES_DASHBOARD;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD_TUI) {
    env.NEMOCLAW_HERMES_DASHBOARD_TUI = process.env.NEMOCLAW_HERMES_DASHBOARD_TUI;
  }
  if (process.env.NEMOCLAW_DASHBOARD_PORT) {
    env.NEMOCLAW_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT;
  }
  if (process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT) {
    env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT =
      process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT;
  }
  return env;
}

function chatPayload(model: string, prompt: string, maxTokens = 256): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
}

function chatContent(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const choices = (response as OpenAiChatLike).choices;
  if (!Array.isArray(choices)) return "";
  for (const choice of choices) {
    const message = choice?.message;
    if (message) {
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content.trim();
      }
      if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        return message.reasoning_content.trim();
      }
    }
    if (typeof choice?.text === "string" && choice.text.trim()) return choice.text.trim();
  }
  return "";
}

function firstChoice(response: unknown): OpenAiChoiceLike | undefined {
  if (!response || typeof response !== "object") return undefined;
  const choices = (response as OpenAiChatLike).choices;
  if (!Array.isArray(choices)) return undefined;
  return choices.find((choice) => choice && typeof choice === "object");
}

function shouldRetryForReasoningBudget(response: unknown): boolean {
  const content = chatContent(response);
  if (/PONG/i.test(content)) return false;
  const choice = firstChoice(response);
  const message = choice?.message;
  return (
    choice?.finish_reason === "length" &&
    typeof message?.reasoning_content === "string" &&
    message.reasoning_content.trim().length > 0
  );
}

function expectPong(label: string, response: unknown): void {
  const content = chatContent(response);
  expect(
    content,
    `${label} expected PONG; response=${JSON.stringify(response).slice(0, 500)}`,
  ).toMatch(/PONG/i);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function registryEntry(name: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(REGISTRY_FILE)) return undefined;
  const registry = readJsonFile(REGISTRY_FILE);
  if (!registry || typeof registry !== "object") return undefined;
  const sandboxes = (registry as { sandboxes?: unknown }).sandboxes;
  if (!sandboxes || typeof sandboxes !== "object") return undefined;
  const entry = (sandboxes as Record<string, unknown>)[name];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

function httpStatusOk(status: string): boolean {
  return /^[23][0-9][0-9]$/.test(status.trim());
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g, "");
}

function forwardListHasRunningPort(output: string, sandboxName: string, port: string): boolean {
  return output
    .split("\n")
    .map(stripAnsi)
    .some((line) => {
      const parts = line.trim().split(/\s+/);
      return (
        parts.length >= 5 &&
        parts[0] === sandboxName &&
        parts[2] === port &&
        ["running", "active"].includes(parts.at(-1)?.toLowerCase() ?? "")
      );
    });
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup is best-effort because the pre-install path may not have
    // nemoclaw/openshell available yet.
  }
}

async function retryHostedInference<T>(
  label: string,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(5_000 * attempt);
    }
  }
  throw new Error(
    `${label} failed after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "hermes-e2e: install.sh onboards Hermes and proves health plus live inference",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, provider, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    await artifacts.writeJson("scenario.json", {
      id: "hermes-e2e",
      runner: "vitest",
      migratedFrom: "test/e2e/test-hermes-e2e.sh",
      boundary: "install.sh --non-interactive + Hermes sandbox runtime",
      sandboxName: SANDBOX_NAME,
      dashboardEnabled: hermesDashboardE2eEnabled(),
      securityPostureEnabled: securityPostureEnabled(),
    });

    const env = commandEnv(hosted.env);
    const redactionValues = [apiKey];

    const cleanupHermes = async (label: string) => {
      await bestEffort(() =>
        host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: `${label}-nemoclaw-destroy`,
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: `${label}-openshell-sandbox-delete`,
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: `${label}-openshell-gateway-destroy`,
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
    };

    cleanup.add(`destroy Hermes sandbox ${SANDBOX_NAME}`, async () => {
      await cleanupHermes("cleanup");
    });

    // Phase 0: pre-cleanup, after the secret gate so local skipped runs do not
    // mutate host state.
    await cleanupHermes("pre-cleanup");

    // Phase 1: prerequisites.
    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-1-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(dockerInfo.exitCode, resultText(dockerInfo)).toBe(0);

    expect(fs.existsSync(path.join(REPO_ROOT, "agents", "hermes", "manifest.yaml"))).toBe(true);

    const providerReachability = await provider.probeReachability(
      trustedProviderEndpoint(hosted.endpointUrl, { allowedHosts: ["inference-api.nvidia.com"] }),
      {
        artifactName: "phase-1-inference-reachability",
        env: buildAvailabilityProbeEnv(),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    const reachabilityStatus = providerReachability.stdout.trim();
    expect(providerReachability.exitCode, resultText(providerReachability)).toBe(0);
    expect(["000", "401", "403"], resultText(providerReachability)).not.toContain(
      reachabilityStatus,
    );
    expect(Number(reachabilityStatus), resultText(providerReachability)).toBeLessThan(500);

    // Phase 2: real installer + non-interactive Hermes onboard.
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-2-install-hermes",
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 60 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    const cliProbe = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && command -v openshell"],
      {
        artifactName: "phase-2-cli-probe",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);
    expect(cliProbe.stdout).toContain("nemoclaw");
    expect(cliProbe.stdout).toContain("openshell");

    const help = await host.command("nemoclaw", ["--help"], {
      artifactName: "phase-2-nemoclaw-help",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(help.exitCode, resultText(help)).toBe(0);

    if (hermesDashboardE2eEnabled()) {
      expect(resultText(install)).toContain(
        "Deployment verified — gateway and dashboard are healthy.",
      );
      expect(resultText(install)).toContain("Hermes Agent Dashboard");
      expect(resultText(install)).toContain(`http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`);
    }

    // Phase 3: sandbox verification.
    const list = await host.command("nemoclaw", ["list"], {
      artifactName: "phase-3-nemoclaw-list",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(list.exitCode, resultText(list)).toBe(0);
    expect(resultText(list)).toContain(SANDBOX_NAME);

    const status = await host.command("nemoclaw", [SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);

    expect(fs.existsSync(SESSION_FILE), `${SESSION_FILE} missing`).toBe(true);
    expect(readJsonFile(SESSION_FILE)).toMatchObject({ agent: "hermes" });

    const inference = await sandbox.openshell(["inference", "get"], {
      artifactName: "phase-3-openshell-inference-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(inference.exitCode, resultText(inference)).toBe(0);
    expect(resultText(inference)).toContain(hosted.providerName);

    const policy = await sandbox.openshell(["policy", "get", "--full", SANDBOX_NAME], {
      artifactName: "phase-3-openshell-policy-get",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(policy.exitCode, resultText(policy)).toBe(0);
    expect(resultText(policy)).toMatch(/network_policies/i);

    // Phase 4: Hermes health and sandbox state.
    let health: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      health = await sandbox.exec(SANDBOX_NAME, ["curl", "-sf", HERMES_HEALTH_URL], {
        artifactName: `phase-4-hermes-health-attempt-${attempt}`,
        env: commandEnv(),
        timeoutMs: 20_000,
      });
      if (health.exitCode === 0 && /"ok"/i.test(resultText(health))) break;
      await sleep(4_000);
    }
    expect(health, "Hermes health probe did not run").toBeTruthy();
    expect(health?.exitCode, health ? resultText(health) : "missing health result").toBe(0);
    expect(resultText(health!)).toMatch(/"ok"/i);

    const hermesVersion = await sandbox.exec(SANDBOX_NAME, ["hermes", "--version"], {
      artifactName: "phase-4-hermes-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(hermesVersion.exitCode, resultText(hermesVersion)).toBe(0);
    expect(resultText(hermesVersion)).not.toMatch(/MISSING|not found|No such file/i);

    const configProbe = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "test -f /sandbox/.hermes/config.yaml && test -d /sandbox/.hermes && touch /sandbox/.hermes/test-write && rm -f /sandbox/.hermes/test-write && echo OK",
      ),
      {
        artifactName: "phase-4-hermes-config-state",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(configProbe.exitCode, resultText(configProbe)).toBe(0);
    expect(configProbe.stdout).toContain("OK");

    if (hermesDashboardE2eEnabled()) {
      const entry = registryEntry(SANDBOX_NAME);
      expect(entry, `registry missing ${SANDBOX_NAME}`).toBeTruthy();
      expect(entry).toMatchObject({
        agent: "hermes",
        dashboardPort: Number(HERMES_DASHBOARD_PORT),
      });

      const forwardList = await sandbox.openshell(["forward", "list"], {
        artifactName: "phase-4-dashboard-forward-list",
        env: commandEnv(),
        timeoutMs: 30_000,
      });
      expect(forwardList.exitCode, resultText(forwardList)).toBe(0);
      expect(forwardListHasRunningPort(forwardList.stdout, SANDBOX_NAME, "8642")).toBe(true);
      expect(
        forwardListHasRunningPort(forwardList.stdout, SANDBOX_NAME, HERMES_DASHBOARD_PORT),
      ).toBe(true);

      const hostDashboard = await host.command(
        "curl",
        [
          "-sS",
          "-L",
          "--max-time",
          "10",
          "-o",
          "/tmp/hermes-dashboard-vitest-body",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`,
        ],
        {
          artifactName: "phase-4-dashboard-host-probe",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(hostDashboard.exitCode, resultText(hostDashboard)).toBe(0);
      expect(httpStatusOk(hostDashboard.stdout)).toBe(true);

      const hostHealth = await host.command(
        "curl",
        ["-sf", "--max-time", "10", HERMES_HOST_HEALTH_URL],
        {
          artifactName: "phase-4-hermes-host-health",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(hostHealth.exitCode, resultText(hostHealth)).toBe(0);
      expect(resultText(hostHealth)).toMatch(/"ok"/i);

      const dashboardInternal = await sandbox.exec(
        SANDBOX_NAME,
        [
          "curl",
          "-sS",
          "-L",
          "--max-time",
          "10",
          "-o",
          "/tmp/hermes-dashboard-vitest-body",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${HERMES_DASHBOARD_INTERNAL_PORT}/`,
        ],
        {
          artifactName: "phase-4-dashboard-sandbox-probe",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(dashboardInternal.exitCode, resultText(dashboardInternal)).toBe(0);
      expect(httpStatusOk(dashboardInternal.stdout)).toBe(true);
    }

    // Phase 5: live inference through both the external provider and the
    // sandbox's inference.local route.
    const directChat = await retryHostedInference(
      "direct NVIDIA Endpoints chat",
      async (attempt) => {
        const response = await provider.requestJson(
          trustedProviderEndpoint("https://inference-api.nvidia.com/v1/chat/completions", {
            allowedHosts: ["inference-api.nvidia.com"],
          }),
          {
            artifactName: `phase-5-direct-nvidia-chat-attempt-${attempt}`,
            body: chatPayload(
              hosted.model,
              "Reply with exactly one word: PONG",
              attempt === 1 ? 256 : 1024,
            ),
            curlMaxTimeSeconds: 90,
            headers: ["Content-Type: application/json", `Authorization: Bearer ${apiKey}`],
            env: buildAvailabilityProbeEnv(),
            redactionValues,
            timeoutMs: 120_000,
          },
        );
        if (shouldRetryForReasoningBudget(response.json)) {
          throw new Error("direct chat exhausted response budget while reasoning before PONG");
        }
        return response;
      },
    );
    expectPong("direct NVIDIA Endpoints chat", directChat.json);

    const sandboxChatJson = await retryHostedInference(
      "Hermes sandbox inference.local chat",
      async (attempt) => {
        const result = await sandbox.exec(
          SANDBOX_NAME,
          [
            "curl",
            "-fsS",
            "--max-time",
            "90",
            "-H",
            "Content-Type: application/json",
            "--data-raw",
            chatPayload(
              hosted.model,
              "Reply with exactly one word: PONG",
              attempt === 1 ? 256 : 1024,
            ),
            "https://inference.local/v1/chat/completions",
          ],
          {
            artifactName: `phase-5-inference-local-chat-attempt-${attempt}`,
            env: commandEnv(),
            timeoutMs: 120_000,
          },
        );
        if (result.exitCode !== 0) throw new Error(resultText(result));
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.stdout) as unknown;
        } catch (error) {
          throw new Error(
            `Hermes sandbox inference.local chat response was not JSON: ${
              error instanceof Error ? error.message : String(error)
            }; body=${result.stdout.slice(0, 500)}`,
          );
        }
        if (shouldRetryForReasoningBudget(parsed)) {
          throw new Error("sandbox chat exhausted response budget while reasoning before PONG");
        }
        return parsed;
      },
    );
    expectPong("Hermes sandbox inference.local chat", sandboxChatJson);

    // Phase 6: CLI operations and agent manifest regression.
    const logs = await host.command("nemoclaw", [SANDBOX_NAME, "logs"], {
      artifactName: "phase-6-nemoclaw-logs",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(logs.exitCode, resultText(logs)).toBe(0);
    expect(resultText(logs).trim().length).toBeGreaterThan(0);

    const manifestCheck = await host.command(
      "node",
      [
        "-e",
        `const { loadAgent, listAgents } = require(${JSON.stringify(path.join(REPO_ROOT, "bin", "lib", "agent-defs"))});\n` +
          `const agents = listAgents();\n` +
          `console.log('agents:', agents.join(', '));\n` +
          `console.log('openclaw_display:', loadAgent('openclaw').displayName);\n` +
          `console.log('hermes_display:', loadAgent('hermes').displayName);`,
      ],
      {
        artifactName: "phase-6-agent-manifest-check",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(manifestCheck.exitCode, resultText(manifestCheck)).toBe(0);
    expect(manifestCheck.stdout).toMatch(/openclaw_display:.*OpenClaw/);
    expect(manifestCheck.stdout).toMatch(/hermes_display:.*Hermes/);
    expect(manifestCheck.stdout).toMatch(/agents:.*(openclaw.*hermes|hermes.*openclaw)/);

    const securityPosture = securityPostureEnabled()
      ? await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "hermes")
      : null;

    // Phase 8: explicit cleanup and post-destroy registry proof.
    if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX !== "1") {
      const destroy = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "phase-8-nemoclaw-destroy",
        env: commandEnv(),
        timeoutMs: 120_000,
      });
      expect(destroy.exitCode, resultText(destroy)).toBe(0);
      await bestEffort(() =>
        sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "phase-8-openshell-gateway-destroy",
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
      expect(
        registryEntry(SANDBOX_NAME),
        `${SANDBOX_NAME} still in ${REGISTRY_FILE}`,
      ).toBeUndefined();
    }

    await artifacts.writeJson("scenario-result.json", {
      id: "hermes-e2e",
      assertions: {
        installShNonInteractiveHermes: true,
        sandboxListedAndHealthy: true,
        directProviderInferencePong: true,
        sandboxInferenceLocalPong: true,
        dashboardChecked: hermesDashboardE2eEnabled(),
        securityPostureChecked: securityPosture !== null,
      },
      securityPosture,
    });
  },
);
