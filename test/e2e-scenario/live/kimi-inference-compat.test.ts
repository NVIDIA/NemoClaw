// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-kimi-inference-compat.sh. */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  assertTrajectory,
  CLI,
  cleanupKimi,
  env,
  KIMI_MODEL,
  parseConfig,
  REPO_ROOT,
  SANDBOX_NAME,
  startKimiMock,
} from "./kimi-inference-compat-helpers.ts";

const TIMEOUT_MS = 40 * 60_000;

test.skipIf(!shouldRunLiveE2EScenarios())(
  "Kimi-compatible endpoint config enables plugin wiring and managed inference route",
  { timeout: TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox }) => {
    const fake = await startKimiMock();
    cleanup.add("close fake Kimi endpoint", () => fake.close());
    cleanup.add("destroy Kimi sandbox", () => cleanupKimi(host, sandbox));

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

    await cleanupKimi(host, sandbox);

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
    expect(modelEntry?.compat?.maxTokensField).toBe("max_tokens");
    expect(modelEntry?.compat?.supportsStore).toBe(false);
    expect(config.stdout).toContain(
      "/usr/local/share/nemoclaw/openclaw-plugins/kimi-inference-compat",
    );
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

    const toolAgent = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --session-id e2e-kimi-tools -m 'Use the exec tool to run hostname, date, and uptime. Run each command and then say exactly: hostname, date, and uptime completed successfully.'",
      ),
      {
        artifactName: "kimi-agent-tool-splitting",
        env: env(),
        redactionValues: ["test-kimi-key"],
        timeoutMs: 420_000,
      },
    );
    expect(toolAgent.exitCode, resultText(toolAgent)).toBe(0);
    await assertTrajectory(sandbox);
    expect(
      fake.requests.some(
        (request) =>
          request.authOk &&
          request.path.includes("/chat/completions") &&
          request.model === KIMI_MODEL &&
          request.hasTools,
      ),
    ).toBe(true);
    expect(fake.requests.some((request) => request.authOk && request.hasToolResult)).toBe(true);
  },
);
