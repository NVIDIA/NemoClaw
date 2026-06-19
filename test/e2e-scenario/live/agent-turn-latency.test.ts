// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-agent-turn-latency-e2e.sh. */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const OPENCLAW_SANDBOX =
  process.env.NEMOCLAW_OPENCLAW_TURN_LATENCY_SANDBOX_NAME ?? "e2e-openclaw-turn-latency";
const HERMES_SANDBOX =
  process.env.NEMOCLAW_HERMES_TURN_LATENCY_SANDBOX_NAME ?? "e2e-hermes-turn-latency";
validateSandboxName(OPENCLAW_SANDBOX);
validateSandboxName(HERMES_SANDBOX);
const MODEL = process.env.NEMOCLAW_TURN_LATENCY_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const PROVIDER = process.env.NEMOCLAW_TURN_LATENCY_PROVIDER ?? "build";
const EXPECTED_ROUTE_PROVIDER = process.env.NEMOCLAW_TURN_LATENCY_ROUTE_PROVIDER ?? "nvidia-prod";
const MAX_TURN_SECONDS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_MAX_SECONDS, 300);
const INSTALL_ATTEMPTS = positiveInt(process.env.NEMOCLAW_TURN_LATENCY_INSTALL_ATTEMPTS, 2);
const TIMEOUT_MS = 90 * 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return fallback;
  return Number.parseInt(value, 10);
}

function env(
  sandboxName: string,
  agent: "openclaw" | "hermes",
  apiKey?: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: PROVIDER,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  if (agent === "hermes") out.NEMOCLAW_AGENT = "hermes";
  if (apiKey) {
    out.NVIDIA_INFERENCE_API_KEY = apiKey;
    out.NVIDIA_API_KEY = apiKey;
  }
  return out;
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

function firstJsonObject(output: string): unknown {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(output.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function collectAssistantText(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  const record = value as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of [
    "result",
    "payloads",
    "messages",
    "choices",
    "message",
    "delta",
    "content",
    "text",
  ]) {
    if (key in record) texts.push(...collectAssistantText(record[key]));
  }
  return texts;
}

function extractOpenClawAgentText(output: string): string {
  const parsed = firstJsonObject(output);
  return collectAssistantText(parsed)[0] ?? "";
}

function responseBodyAndStatus(raw: string): { body: string; status: string } {
  const match = raw.match(/\n__NEMOCLAW_HTTP_STATUS__=(\d{3})\s*$/u);
  return { body: match ? raw.slice(0, match.index).trim() : raw, status: match?.[1] ?? "000" };
}

function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown>; text?: unknown }>;
  };
  const choice = parsed.choices?.[0];
  const message = choice?.message ?? {};
  for (const value of [
    message.content,
    message.reasoning_content,
    message.reasoning,
    choice?.text,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function msSince(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}

function assertOpenClawConfig(raw: string, model: string): void {
  const cfg = JSON.parse(raw) as {
    agents?: { defaults?: { model?: { primary?: unknown } } };
    models?: {
      providers?: {
        inference?: { baseUrl?: unknown; models?: Array<{ id?: unknown; name?: unknown }> };
      };
    };
  };
  const provider = cfg.models?.providers?.inference;
  expect(cfg.agents?.defaults?.model?.primary).toBe(`inference/${model}`);
  expect(provider?.baseUrl).toBe("https://inference.local/v1");
  expect(provider?.models?.[0]?.id).toBe(model);
  expect(provider?.models?.[0]?.name).toBe(`inference/${model}`);
}

function assertHermesConfig(raw: string, model: string): void {
  const values: Record<string, string> = {};
  let inModel = false;
  for (const line of raw.split(/\r?\n/u)) {
    if (/^model:\s*$/u.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel && /^[A-Za-z0-9_-]+:/u.test(line)) break;
    const match = inModel ? line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u) : null;
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
  }
  expect(values.default).toBe(model);
  expect(values.base_url).toBe("https://inference.local/v1");
  expect(values.provider).toBe("custom");
  expect(raw).not.toMatch(/^models:\s*\n(?:[ \t].*\n)*?[ \t]+providers:/mu);
}

async function installSandbox(
  host: HostCliClient,
  sandboxName: string,
  agent: "openclaw" | "hermes",
  apiKey: string,
): Promise<void> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: `${agent}-install-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: env(sandboxName, agent, apiKey),
        redactionValues: [apiKey],
        timeoutMs: 30 * 60_000,
      },
    );
    if (install.exitCode === 0) break;
    if (isTransientProviderValidationFailure(install) && attempt < INSTALL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
      continue;
    }
    break;
  }
  if (!install) throw new Error(`${agent} install command did not run`);
  expect(install.exitCode, resultText(install)).toBe(0);
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "OpenClaw and Hermes complete real hosted inference turns within the latency cap",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const results: Record<string, unknown> = { model: MODEL, maxTurnSeconds: MAX_TURN_SECONDS };
    await artifacts.writeJson("scenario.json", {
      id: "agent-turn-latency",
      legacySource: "test/e2e/test-agent-turn-latency-e2e.sh",
      boundary: "two real sandboxes + hosted inference + OpenClaw agent turn + Hermes API turn",
      openclawSandbox: OPENCLAW_SANDBOX,
      hermesSandbox: HERMES_SANDBOX,
    });

    cleanup.add("destroy turn latency sandboxes", async () => {
      for (const [name, agent] of [
        [OPENCLAW_SANDBOX, "openclaw"],
        [HERMES_SANDBOX, "hermes"],
      ] as const) {
        await bestEffort(() =>
          host.command("node", [CLI, name, "destroy", "--yes"], {
            artifactName: `cleanup-${agent}-destroy`,
            env: env(name, agent),
            timeoutMs: 120_000,
          }),
        );
        await bestEffort(() =>
          sandbox.openshell(["sandbox", "delete", name], {
            artifactName: `cleanup-${agent}-delete`,
            env: env(name, agent),
            timeoutMs: 60_000,
          }),
        );
      }
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    await installSandbox(host, OPENCLAW_SANDBOX, "openclaw", apiKey);
    const openclawRoute = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: "openclaw-route",
      env: env(OPENCLAW_SANDBOX, "openclaw"),
      timeoutMs: 30_000,
    });
    expect(openclawRoute.exitCode, resultText(openclawRoute)).toBe(0);
    expect(resultText(openclawRoute)).toContain(EXPECTED_ROUTE_PROVIDER);
    expect(resultText(openclawRoute)).toContain(MODEL);
    const openclawConfig = await sandbox.exec(
      OPENCLAW_SANDBOX,
      ["cat", "/sandbox/.openclaw/openclaw.json"],
      {
        artifactName: "openclaw-config",
        env: env(OPENCLAW_SANDBOX, "openclaw"),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(openclawConfig.exitCode, resultText(openclawConfig)).toBe(0);
    assertOpenClawConfig(openclawConfig.stdout, MODEL);

    const openclawStarted = process.hrtime.bigint();
    const openclawTurn = await sandbox.execShell(
      OPENCLAW_SANDBOX,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --thinking off --session-id e2e-turn-latency -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.'",
      ),
      {
        artifactName: "openclaw-agent-turn",
        env: env(OPENCLAW_SANDBOX, "openclaw"),
        redactionValues: [apiKey],
        timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
      },
    );
    const openclawMs = msSince(openclawStarted);
    expect(openclawTurn.exitCode, resultText(openclawTurn)).toBe(0);
    expect(extractOpenClawAgentText(openclawTurn.stdout), resultText(openclawTurn)).toMatch(
      /(^|[^0-9])42([^0-9]|$)/,
    );
    expect(openclawMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.openclaw = { elapsedMs: openclawMs };

    await host.command("node", [CLI, OPENCLAW_SANDBOX, "destroy", "--yes"], {
      artifactName: "destroy-openclaw-before-hermes",
      env: env(OPENCLAW_SANDBOX, "openclaw"),
      timeoutMs: 120_000,
    });

    await installSandbox(host, HERMES_SANDBOX, "hermes", apiKey);
    const hermesRoute = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: "hermes-route",
      env: env(HERMES_SANDBOX, "hermes"),
      timeoutMs: 30_000,
    });
    expect(hermesRoute.exitCode, resultText(hermesRoute)).toBe(0);
    expect(resultText(hermesRoute)).toContain(EXPECTED_ROUTE_PROVIDER);
    expect(resultText(hermesRoute)).toContain(MODEL);
    const hermesHealth = await sandbox.exec(
      HERMES_SANDBOX,
      ["curl", "-sf", "--max-time", "10", "http://localhost:8642/health"],
      { artifactName: "hermes-health", env: env(HERMES_SANDBOX, "hermes"), timeoutMs: 30_000 },
    );
    expect(hermesHealth.exitCode, resultText(hermesHealth)).toBe(0);
    const hermesConfig = await sandbox.exec(
      HERMES_SANDBOX,
      ["cat", "/sandbox/.hermes/config.yaml"],
      {
        artifactName: "hermes-config",
        env: env(HERMES_SANDBOX, "hermes"),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
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
    const hermesStarted = process.hrtime.bigint();
    const hermesTurn = await sandbox.execShell(
      HERMES_SANDBOX,
      trustedSandboxShellScript(
        `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; tmp=$(mktemp); code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time ${MAX_TURN_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -d '${payload.replace(/'/gu, `'\\''`)}'); rc=$?; cat "$tmp"; rm -f "$tmp"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' "\${code:-000}"; exit "$rc"`,
      ),
      {
        artifactName: "hermes-api-turn",
        env: env(HERMES_SANDBOX, "hermes"),
        redactionValues: [apiKey],
        timeoutMs: (MAX_TURN_SECONDS + 30) * 1000,
      },
    );
    const hermesMs = msSince(hermesStarted);
    expect(hermesTurn.exitCode, resultText(hermesTurn)).toBe(0);
    const hermesResponse = responseBodyAndStatus(hermesTurn.stdout);
    expect(hermesResponse.status, resultText(hermesTurn)).toBe("200");
    expect(chatContent(hermesResponse.body)).toMatch(/(^|[^0-9])42([^0-9]|$)/);
    expect(hermesMs).toBeLessThanOrEqual(MAX_TURN_SECONDS * 1000);
    results.hermes = { elapsedMs: hermesMs };
    await artifacts.writeJson("turn-latency-results.json", results);
    fs.writeFileSync(
      artifacts.pathFor("agent-turn-latency-results-legacy-path.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  },
);
