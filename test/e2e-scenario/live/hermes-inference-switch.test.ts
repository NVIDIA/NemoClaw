// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-hermes-inference-switch.sh. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-hermes-inference-switch";
validateSandboxName(SANDBOX_NAME);
const SWITCH_PROVIDER = process.env.NEMOCLAW_SWITCH_PROVIDER ?? "nvidia-prod";
const SWITCH_MODEL = process.env.NEMOCLAW_SWITCH_MODEL ?? "z-ai/glm-5.1";
const SWITCH_API = process.env.NEMOCLAW_SWITCH_INFERENCE_API ?? "openai-completions";
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const TIMEOUT_MS = 45 * 60_000;

function env(apiKey?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
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

function parseHermesModelBlock(text: string): Record<string, string> {
  const model: Record<string, string> = {};
  let inModel = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^model:\s*$/u.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel && /^[A-Za-z0-9_-]+:/u.test(line)) break;
    if (!inModel) continue;
    const match = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/gu, "");
    model[match[1]] = value;
  }
  return model;
}

function chatContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    content?: Array<{ text?: unknown }>;
  };
  const anthropicText = parsed.content?.find((part) => typeof part.text === "string")?.text;
  if (typeof anthropicText === "string" && anthropicText.trim()) return anthropicText.trim();
  const message = parsed.choices?.[0]?.message ?? {};
  for (const key of ["content", "reasoning_content", "reasoning"]) {
    const value = message[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Hermes inference set updates route/config and preserves live runtime",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    await artifacts.writeJson("scenario.json", {
      id: "hermes-inference-switch",
      legacySource: "test/e2e/test-hermes-inference-switch.sh",
      boundary: "install.sh + Hermes sandbox + inference set + in-sandbox health/chat probes",
      sandboxName: SANDBOX_NAME,
      switchProvider: SWITCH_PROVIDER,
      switchModel: SWITCH_MODEL,
      switchApi: SWITCH_API,
    });

    cleanup.add("destroy Hermes inference switch sandbox", async () => {
      await bestEffort(() =>
        host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy",
          env: env(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete",
          env: env(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() =>
      host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-destroy",
        env: env(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-delete",
        env: env(),
        timeoutMs: 60_000,
      }),
    );

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    let install: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
      install = await host.command(
        "bash",
        ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
        {
          artifactName: attempt === 1 ? "install-hermes" : `install-hermes-attempt-${attempt}`,
          cwd: REPO_ROOT,
          env: env(apiKey),
          redactionValues: [apiKey],
          timeoutMs: 25 * 60_000,
        },
      );
      if (install.exitCode === 0) break;
      if (isTransientProviderValidationFailure(install) && attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
    expect(install, "install command must run").toBeDefined();
    expect(install?.exitCode, resultText(install as ShellProbeResult)).toBe(0);

    const pidBefore = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "ps -eo pid=,comm=,args= | awk '$0 ~ /hermes/ && $0 ~ /gateway run/ { print $1; exit }'",
      ),
      { artifactName: "pid-before", env: env(), timeoutMs: 30_000 },
    );
    const envHashBefore = await sandbox.exec(SANDBOX_NAME, ["sha256sum", "/sandbox/.hermes/.env"], {
      artifactName: "env-hash-before",
      env: env(),
      timeoutMs: 30_000,
    });

    const switched = await host.command(
      "node",
      [CLI, "inference", "set", "--provider", SWITCH_PROVIDER, "--model", SWITCH_MODEL],
      {
        artifactName: "hermes-inference-set",
        env: env(apiKey),
        redactionValues: [apiKey],
        timeoutMs: 180_000,
      },
    );
    expect(switched.exitCode, resultText(switched)).toBe(0);

    const pidAfter = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "ps -eo pid=,comm=,args= | awk '$0 ~ /hermes/ && $0 ~ /gateway run/ { print $1; exit }'",
      ),
      { artifactName: "pid-after", env: env(), timeoutMs: 30_000 },
    );
    if (pidBefore.stdout.trim() && pidAfter.stdout.trim())
      expect(pidAfter.stdout.trim()).toBe(pidBefore.stdout.trim());

    const health = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-sf", "--max-time", "10", "http://localhost:8642/health"],
      { artifactName: "hermes-health-after-switch", env: env(), timeoutMs: 30_000 },
    );
    expect(health.exitCode, resultText(health)).toBe(0);
    expect(resultText(health)).toMatch(/ok/i);

    const route = await sandbox.openshell(["inference", "get", "-g", "nemoclaw"], {
      artifactName: "openshell-inference-route",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(route.exitCode, resultText(route)).toBe(0);
    expect(resultText(route)).toContain(SWITCH_PROVIDER);
    expect(resultText(route)).toContain(SWITCH_MODEL);

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/config.yaml"], {
      artifactName: "hermes-config-yaml",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    const model = parseHermesModelBlock(config.stdout);
    expect(model.default).toBe(SWITCH_MODEL);
    expect(model.provider).toBe("custom");
    expect(model.base_url).toBe(
      SWITCH_API === "anthropic-messages"
        ? "https://inference.local"
        : "https://inference.local/v1",
    );
    if (SWITCH_API === "anthropic-messages") expect(model.api_mode).toBe("anthropic_messages");
    else if (SWITCH_API === "openai-responses") expect(model.api_mode).toBe("codex_responses");
    else expect(model.api_mode).toBeUndefined();
    const apiKeyShape = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "python3 - <<'PY'\nimport re\ntext=open('/sandbox/.hermes/config.yaml', encoding='utf-8').read()\nmatch=re.search(r'^\\s+api_key:\\s*[\\\"\\']?(sk-[^\\\"\\'\\s]+)', text, re.M)\nraise SystemExit(0 if match else 1)\nPY",
      ),
      { artifactName: "hermes-config-api-key-shape", env: env(), timeoutMs: 30_000 },
    );
    expect(apiKeyShape.exitCode, resultText(apiKeyShape)).toBe(0);
    expect(config.stdout).not.toMatch(/^models:\s*$/mu);

    for (const [file, artifact] of [
      ["/etc/nemoclaw/hermes.config-hash", "strict"],
      ["/sandbox/.hermes/.config-hash", "compat"],
    ] as const) {
      const hash = await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(`sha256sum -c ${file} --status && echo OK`),
        { artifactName: `hermes-${artifact}-hash-check`, env: env(), timeoutMs: 30_000 },
      );
      expect(hash.exitCode, resultText(hash)).toBe(0);
      expect(hash.stdout).toContain("OK");
    }
    const strictHashPerms = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript("stat -c '%u %a' /etc/nemoclaw/hermes.config-hash"),
      { artifactName: "hermes-strict-hash-perms", env: env(), timeoutMs: 30_000 },
    );
    expect(strictHashPerms.stdout.trim()).toMatch(/^0\s+[0-7]+$/u);
    expect(Number.parseInt(strictHashPerms.stdout.trim().split(/\s+/u)[1], 8) & 0o222).toBe(0);

    const envHashAfter = await sandbox.exec(SANDBOX_NAME, ["sha256sum", "/sandbox/.hermes/.env"], {
      artifactName: "env-hash-after",
      env: env(),
      timeoutMs: 30_000,
    });
    if (envHashBefore.stdout.trim())
      expect(envHashAfter.stdout.split(/\s+/u)[0]).toBe(envHashBefore.stdout.split(/\s+/u)[0]);

    const registry = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".nemoclaw", "sandboxes.json"), "utf8"),
    );
    expect(registry.sandboxes?.[SANDBOX_NAME]?.agent).toBe("hermes");
    expect(registry.sandboxes?.[SANDBOX_NAME]?.provider).toBe(SWITCH_PROVIDER);
    expect(registry.sandboxes?.[SANDBOX_NAME]?.model).toBe(SWITCH_MODEL);
    const session = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".nemoclaw", "onboard-session.json"), "utf8"),
    );
    expect(session.sandboxName).toBe(SANDBOX_NAME);
    expect(session.agent).toBe("hermes");
    expect(session.provider).toBe(SWITCH_PROVIDER);
    expect(session.model).toBe(SWITCH_MODEL);

    const inferenceLocalPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const inferenceLocalCommand =
      SWITCH_API === "anthropic-messages"
        ? `curl -sS --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' -d '${inferenceLocalPayload.replace(/'/gu, `'\\''`)}'`
        : `curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d '${inferenceLocalPayload.replace(/'/gu, `'\\''`)}'`;
    const inferenceLocal = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(inferenceLocalCommand),
      {
        artifactName: "hermes-inference-local-chat-after-switch",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 120_000,
      },
    );
    expect(inferenceLocal.exitCode, resultText(inferenceLocal)).toBe(0);
    expect(chatContent(inferenceLocal.stdout)).toMatch(/PONG/i);

    const payload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const chat = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY:-}" -d '${payload.replace(/'/gu, `'\\''`)}'`,
      ),
      {
        artifactName: "hermes-api-chat-after-switch",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 150_000,
      },
    );
    expect(chat.exitCode, resultText(chat)).toBe(0);
    expect(chatContent(chat.stdout)).toMatch(/PONG/i);
  },
);
