// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-kimi-inference-compat.sh. */

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-kimi-compat";
validateSandboxName(SANDBOX_NAME);
const KIMI_MODEL = process.env.NEMOCLAW_KIMI_MODEL ?? "moonshotai/kimi-k2.6";
const TIMEOUT_MS = 40 * 60_000;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: "test-kimi-key",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_MODEL: KIMI_MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_POLICY_TIER: "restricted",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_YES: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {}
}

function parseConfig(raw: string): {
  providers?: Record<
    string,
    {
      baseUrl?: string;
      api?: string;
      models?: Array<{ id?: string; compat?: Record<string, unknown> }>;
    }
  >;
  primary?: string;
  pluginEnabled?: unknown;
  toolSearch?: unknown;
} {
  const cfg = JSON.parse(raw) as {
    models?: {
      providers?: Record<
        string,
        {
          baseUrl?: string;
          api?: string;
          models?: Array<{ id?: string; compat?: Record<string, unknown> }>;
        }
      >;
    };
    agents?: { defaults?: { model?: { primary?: string } } };
    plugins?: { entries?: Record<string, { enabled?: unknown }> };
    tools?: { toolSearch?: unknown };
  };
  return {
    providers: cfg.models?.providers,
    primary: cfg.agents?.defaults?.model?.primary,
    pluginEnabled: cfg.plugins?.entries?.["nemoclaw-kimi-inference-compat"]?.enabled,
    toolSearch: cfg.tools?.toolSearch,
  };
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Kimi-compatible endpoint config enables plugin wiring and managed inference route",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox }) => {
    const fake = await startFakeOpenAiCompatibleServer({ model: KIMI_MODEL, responseText: "OK" });
    cleanup.add("close fake Kimi endpoint", () => fake.close());
    cleanup.add("destroy Kimi sandbox", async () => {
      await bestEffort(() =>
        host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-destroy-kimi",
          env: env(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-delete-kimi",
          env: env(),
          timeoutMs: 60_000,
        }),
      );
    });

    await artifacts.writeJson("scenario.json", {
      id: "kimi-inference-compat",
      legacySource: "test/e2e/test-kimi-inference-compat.sh",
      boundary:
        "source CLI onboard + fake OpenAI-compatible Kimi endpoint + OpenClaw config/plugin/inference route",
      sandboxName: SANDBOX_NAME,
      model: KIMI_MODEL,
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    await bestEffort(() =>
      host.command("node", [CLI, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-destroy-kimi",
        env: env(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-delete-kimi",
        env: env(),
        timeoutMs: 60_000,
      }),
    );

    const onboard = await host.command(
      "node",
      [CLI, "onboard", "--fresh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "onboard-kimi-compatible",
        cwd: REPO_ROOT,
        env: env({ NEMOCLAW_ENDPOINT_URL: fake.baseUrl }),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 20 * 60_000,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
      artifactName: "openclaw-config",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    const parsed = parseConfig(config.stdout);
    expect(Object.keys(parsed.providers ?? {})).toEqual(["inference"]);
    const inference = parsed.providers?.inference;
    expect(inference?.baseUrl).toBe("https://inference.local/v1");
    expect(inference?.api).toBe("openai-completions");
    const modelEntry = inference?.models?.find((entry) => entry.id === KIMI_MODEL);
    expect(modelEntry, config.stdout).toBeDefined();
    expect(modelEntry?.compat?.requiresStringContent).toBe(true);
    expect(modelEntry?.compat?.requiresToolResultName).toBe(true);
    expect(modelEntry?.compat?.supportsStore).toBe(false);
    expect(parsed.primary).toBe(`inference/${KIMI_MODEL}`);
    expect(parsed.pluginEnabled).toBe(true);
    expect(parsed.toolSearch).toBe(false);

    const modelsRoute = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-sk", "--max-time", "20", "https://inference.local/v1/models"],
      { artifactName: "inference-local-models", env: env(), timeoutMs: 60_000 },
    );
    expect(modelsRoute.exitCode, resultText(modelsRoute)).toBe(0);
    expect(resultText(modelsRoute)).toContain(KIMI_MODEL);

    const agent = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --session-id e2e-kimi-compat -m 'Reply with exactly: OK'",
      ),
      {
        artifactName: "kimi-agent-smoke",
        env: env(),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 150_000,
      },
    );
    expect(agent.exitCode, resultText(agent)).toBe(0);
    expect(resultText(agent)).toMatch(/OK/i);
    expect(
      fake
        .requests()
        .some(
          (request) => request.path.includes("/chat/completions") && request.model === KIMI_MODEL,
        ),
    ).toBe(true);
  },
);
