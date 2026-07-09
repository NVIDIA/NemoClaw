// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertKimiUpstreamTraffic,
  assertTrajectory,
  CLI,
  cleanupKimi,
  env,
  KIMI_MODEL,
  kimiAgentEnv,
  kimiBoundary,
  kimiOnboardEnv,
  maybeRegisterKimiMockCleanup,
  parseConfig,
  REPO_ROOT,
  requirePublicNvidiaApiKey,
  resolveKimiInferenceMode,
  SANDBOX_NAME,
  startKimiUpstream,
} from "./kimi-inference-compat-helpers.ts";

const TIMEOUT_MS = 40 * 60_000;

test("Kimi-compatible endpoint config enables plugin wiring and managed inference route", {
  timeout: TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, secrets }) => {
  const mode = resolveKimiInferenceMode();
  const apiKey =
    mode === "public-nvidia"
      ? requirePublicNvidiaApiKey(secrets.required("NVIDIA_API_KEY"))
      : undefined;
  const fake = await startKimiUpstream(mode);
  maybeRegisterKimiMockCleanup(cleanup, fake);
  cleanup.add("destroy Kimi sandbox", () => cleanupKimi(host, sandbox));

  await artifacts.target.declare({
    id: "kimi-inference-compat",
    boundary: kimiBoundary(mode),
    inferenceClassification:
      mode === "public-nvidia"
        ? "public NVIDIA endpoint validation"
        : "hermetic Kimi compatibility validation",
    inferenceMode: mode,
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
      env: kimiOnboardEnv(fake, mode, apiKey),
      redactionValues: ["test-kimi-key", apiKey ?? ""],
      timeoutMs: 20 * 60_000,
    },
  );
  expect(onboard.exitCode, resultText(onboard)).toBe(0);

  const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.openclaw/openclaw.json"], {
    artifactName: "openclaw-config",
    env: env({}, { mode }),
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
    { artifactName: "inference-local-models", env: env({}, { mode }), timeoutMs: 60_000 },
  );
  expect(modelsRoute.exitCode, resultText(modelsRoute)).toBe(0);
  expect(resultText(modelsRoute)).toContain(KIMI_MODEL);

  const toolAgent = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      "openclaw agent --agent main --json --session-id e2e-kimi-tools -m 'Use the exec tool to run hostname, date, and uptime. Run each command and then say exactly: hostname, date, and uptime completed successfully.'",
    ),
    {
      artifactName: "kimi-agent-tool-splitting",
      env: kimiAgentEnv(mode),
      redactionValues: ["test-kimi-key", apiKey ?? ""],
      timeoutMs: 420_000,
    },
  );
  expect(toolAgent.exitCode, resultText(toolAgent)).toBe(0);
  await assertTrajectory(sandbox, mode);
  await assertKimiUpstreamTraffic({ fake, host, mode, apiKey });
});
