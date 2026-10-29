// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeNativeLocalProviderAttachment } from "../../../src/lib/inference/native-local/contract.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { nativeLocalChatCommand } from "../fixtures/native-local-chat.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-gpu-double";
const PROXY_PORT = process.env.NEMOCLAW_OLLAMA_PROXY_PORT ?? "11435";
const GPU_E2E_MODEL = process.env.NEMOCLAW_MODEL ?? "qwen3.5:9b";
const SWITCH_MODEL = "nemoclaw-e2e-after-ollama";
const SWITCH_API_KEY = "sk-compatible-TEST-NOT-A-REAL-VALUE";
const TOKEN_FILE = path.join(os.homedir(), ".nemoclaw", "ollama-proxy-token");
const LIVE_TIMEOUT_MS = testTimeout(90 * 60_000);

validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_MODEL: GPU_E2E_MODEL,
    NEMOCLAW_OLLAMA_PROXY_PORT: PROXY_PORT,
    NEMOCLAW_PROVIDER: "ollama",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function nemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 20 * 60_000,
  redactionValues: string[] = [],
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    redactionValues,
    timeoutMs,
  });
}

async function preCleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await nemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], "pre-cleanup-nemoclaw-destroy").catch(
    () => undefined,
  );
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "pre-cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "pre-cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await host
    .command(
      "bash",
      [
        "-lc",
        String.raw`set +e
status=0
for pattern in '[o]llama serve' '[o]llama-auth-proxy'; do
  pkill -f "$pattern"
  rc=$?
  case "$rc" in
    0|1) ;;
    *) status="$rc" ;;
  esac
done
exit "$status"`,
      ],
      {
        artifactName: "pre-cleanup-ollama-processes",
        env: env(),
        timeoutMs: 30_000,
      },
    )
    .catch(() => undefined);
}

async function httpStatus(host: HostCliClient, url: string, artifactName: string, token?: string) {
  const header = token ? `-H 'Authorization: Bearer ${token}'` : "";
  return await host.command(
    "bash",
    ["-lc", `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 ${header} '${url}'`],
    {
      artifactName,
      env: env(),
      timeoutMs: 30_000,
    },
  );
}

function parseReplyCommand(): string {
  return String.raw`python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["choices"][0]["message"]; print((m.get("content") or m.get("reasoning_content") or m.get("reasoning") or "").strip())'`;
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
    max_tokens: 200,
  });
}

async function querySandboxForAnswer(
  sandbox: SandboxClient,
  model: string,
  artifactName: string,
  sharedRoute = false,
): Promise<ShellProbeResult> {
  // OpenClaw local inference uses a sandbox-owned provider behind the auth proxy, not the shared
  // gateway route (#13293). Re-read it after re-onboarding recreates the sandbox. A missing
  // attachment yields an unresolvable host. Provider switch uses the shared route.
  const endpoint =
    normalizeNativeLocalProviderAttachment(getSandbox(SANDBOX_NAME)?.nativeLocalProviderAttachment)
      ?.endpointUrl ?? "http://missing-native-local-attachment.invalid/v1";
  const command = sharedRoute
    ? `curl -fsS --max-time 120 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data ${shellQuote(chatRequest(model))}`
    : nativeLocalChatCommand(endpoint, chatRequest(model), "-fsS");
  return await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", `${command} | ${parseReplyCommand()}`], {
    artifactName,
    env: env(),
    timeoutMs: 150_000,
  });
}

async function expectSandboxInference42(
  sandbox: SandboxClient,
  model: string,
  artifactName: string,
): Promise<void> {
  const response = await querySandboxForAnswer(sandbox, model, artifactName);
  expect(response.exitCode, resultText(response)).toBe(0);
  expect(containsAnswer(response.stdout, "42"), resultText(response)).toBe(true);
}

test(
  "gpu double onboard preserves proxy auth and unloads Ollama on provider switch",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate GPU and runtime prerequisites",
        "install Ollama runtime",
        "perform first Ollama onboard",
        "validate first proxy token and inference",
        "re-onboard GPU sandbox",
        "validate persisted proxy auth and inference",
        "verify the Ollama model is active before switching providers",
        "switch inference to a non-Ollama provider",
        "verify new-provider inference and confirm Ollama unloaded the old model",
        "remove GPU double-onboard sandbox",
      ],
    },
  },
  async ({
    artifacts,
    cleanup: cleanupRegistry,
    host,
    progress,
    runtimeProvider,
    sandbox,
    skip,
  }) => {
    await artifacts.target.declare({
      id: "gpu-double-onboard",
      sandboxName: SANDBOX_NAME,
      proxyPort: PROXY_PORT,
      contracts: [
        "GPU and runtime prerequisites are present",
        "install.sh onboards with the Ollama provider",
        "nemoclaw onboard --non-interactive --yes recreates the sandbox",
        "the running proxy accepts the persisted token after re-onboard and rejects unauthenticated/wrong-token requests",
        "the sandbox-owned native provider reaches Ollama after first onboard and re-onboard",
        "Ollama reports the selected model as active before the provider switch",
        "nemoclaw onboard switches the sandbox to a local compatible endpoint",
        "sandbox inference succeeds through the new provider and host ollama ps no longer reports the superseded model",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "phase-0-runtime-info",
      scenarioLabel: "GPU double-onboard",
    });
    const smi = await host.command("nvidia-smi", [], {
      artifactName: "phase-0-nvidia-smi",
      env: env(),
      timeoutMs: 30_000,
    });
    if (smi.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(smi));
      skip(`NVIDIA GPU is required: ${resultText(smi)}`);
    }

    cleanupRegistry.trackDisposable("stop gpu double-onboard Ollama processes", async () => {
      const stop = await host.command(
        "bash",
        [
          "-lc",
          String.raw`set +e
status=0
for pattern in '[o]llama serve' '[o]llama-auth-proxy'; do
  pkill -f "$pattern"
  rc=$?
  case "$rc" in
    0|1) ;;
    *) status="$rc" ;;
  esac
done
exit "$status"`,
        ],
        {
          artifactName: "cleanup-ollama-processes",
          env: env(),
          timeoutMs: 30_000,
        },
      );
      expect(stop.exitCode, resultText(stop)).toBe(0);
    });
    const gatewayCleanupOptions = {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    };
    cleanupRegistry.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-gateway",
              env: gatewayCleanupOptions.env,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const openshellSandboxCleanupOptions = {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    };
    cleanupRegistry.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      cleanupWhenOpenShellAvailable(
        host,
        {
          artifactName: "cleanup-probe-openshell-sandbox",
          env: openshellSandboxCleanupOptions.env,
          timeoutMs: 30_000,
        },
        () => sandbox.cleanupSandbox(SANDBOX_NAME, openshellSandboxCleanupOptions),
      ),
    );
    const nemoclawSandboxCleanupOptions = {
      artifactName: "cleanup-nemoclaw-destroy",
      env: env(),
      timeoutMs: 120_000,
    };
    cleanupRegistry.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-nemoclaw-sandbox",
              env: nemoclawSandboxCleanupOptions.env,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, nemoclawSandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      nemoclawSandboxCleanupOptions,
    );
    await preCleanup(host, sandbox);

    progress.phase("install Ollama runtime");
    const installOllama = await host.command(
      "bash",
      ["-lc", "command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh"],
      {
        artifactName: "phase-1-install-ollama",
        env: env(),
        timeoutMs: 5 * 60_000,
      },
    );
    expect(installOllama.exitCode, resultText(installOllama)).toBe(0);
    await host.command(
      "bash",
      [
        "-lc",
        "systemctl --user stop ollama 2>/dev/null || true; systemctl stop ollama 2>/dev/null || true; pkill -f 'ollama serve' 2>/dev/null || true; pkill -f 'ollama-auth-proxy' 2>/dev/null || true",
      ],
      {
        artifactName: "phase-1-stop-preexisting-ollama",
        env: env(),
        timeoutMs: 60_000,
      },
    );

    progress.phase("perform first Ollama onboard");
    const first = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "phase-2-install-sh-first-onboard",
      cwd: REPO_ROOT,
      env: env(),
      timeoutMs: execTimeout(30 * 60_000),
    });
    expect(first.exitCode, resultText(first)).toBe(0);

    progress.phase("validate first proxy token and inference");
    const tokenAfterFirst = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    expect(tokenAfterFirst.length).toBeGreaterThan(10);

    const model = GPU_E2E_MODEL;
    await expectSandboxInference42(sandbox, model, "phase-3-sandbox-inference-first-onboard");

    progress.phase("re-onboard GPU sandbox");
    const reonboard = await nemoclaw(
      host,
      ["onboard", "--non-interactive", "--yes"],
      "phase-4-reonboard",
      env({ NEMOCLAW_RECREATE_SANDBOX: "1" }),
      execTimeout(30 * 60_000),
    );
    expect(reonboard.exitCode, resultText(reonboard)).toBe(0);
    const tokenAfterSecond = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    expect(tokenAfterSecond).toBe(tokenAfterFirst);
    expect(fs.statSync(TOKEN_FILE).mode & 0o777).toBe(0o600);

    progress.phase("validate persisted proxy auth and inference");
    const authStatus = await httpStatus(
      host,
      `http://127.0.0.1:${PROXY_PORT}/v1/models`,
      "phase-5-proxy-persisted-token-status",
      tokenAfterFirst,
    );
    expect(authStatus.stdout.trim(), resultText(authStatus)).toBe("200");
    const unauthPost = await host.command(
      "bash",
      [
        "-lc",
        `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 -X POST 'http://127.0.0.1:${PROXY_PORT}/api/generate' -d '{}'`,
      ],
      { artifactName: "phase-5-proxy-unauth-post-status", env: env(), timeoutMs: 30_000 },
    );
    expect(unauthPost.stdout.trim()).toBe("401");
    const wrongStatus = await httpStatus(
      host,
      `http://127.0.0.1:${PROXY_PORT}/v1/models`,
      "phase-5-proxy-wrong-token-status",
      `wrong-${Date.now()}`,
    );
    expect(wrongStatus.stdout.trim()).toBe("401");

    await expectSandboxInference42(sandbox, model, "phase-6-sandbox-inference-after-reonboard");

    const fake = await startFakeOpenAiCompatibleServer({
      apiKey: SWITCH_API_KEY,
      chatContent: "42",
      host: "0.0.0.0",
      model: SWITCH_MODEL,
      port: 8000,
      progress,
      publicHost: "host.openshell.internal",
      requireAuth: true,
      requireAuthModels: true,
    });
    cleanupRegistry.trackDisposable("close switched compatible endpoint", async () => {
      try {
        await artifacts.writeJson("phase-9-compatible-endpoint-requests.json", fake.requests());
      } finally {
        await fake.close();
      }
    });
    progress.phase("verify the Ollama model is active before switching providers");
    const keepAlivePayload = JSON.stringify({
      model,
      prompt: "Hello, reply in less than 5 words",
      stream: false,
      keep_alive: "45m",
      options: { num_predict: 16 },
    });
    const activeModelsBeforeSwitch = await host.command(
      "bash",
      [
        "-lc",
        `curl --fail-with-body --silent --show-error --connect-timeout 10 --max-time 120 -H 'Content-Type: application/json' -d ${shellQuote(keepAlivePayload)} http://127.0.0.1:11434/api/generate >/dev/null && ollama ps`,
      ],
      {
        artifactName: "phase-7-ollama-ps-before-provider-switch",
        env: env(),
        timeoutMs: 150_000,
      },
    );
    expect(activeModelsBeforeSwitch.exitCode, resultText(activeModelsBeforeSwitch)).toBe(0);
    expect(activeModelsBeforeSwitch.stdout).toContain(model);

    progress.phase("switch inference to a non-Ollama provider");
    const providerSwitch = await nemoclaw(
      host,
      ["onboard", "--non-interactive", "--yes"],
      "phase-8-reonboard-away-from-ollama",
      {
        COMPATIBLE_API_KEY: SWITCH_API_KEY,
        NEMOCLAW_COMPAT_MODEL: SWITCH_MODEL,
        NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
        NEMOCLAW_MODEL: SWITCH_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_RECREATE_SANDBOX: "0",
      },
      execTimeout(30 * 60_000),
      [SWITCH_API_KEY],
    );
    expect(providerSwitch.exitCode, resultText(providerSwitch)).toBe(0);

    progress.phase("verify new-provider inference and confirm Ollama unloaded the old model");
    const switchedRequestOffset = fake.requests().length;
    const switchedInference = await querySandboxForAnswer(
      sandbox,
      SWITCH_MODEL,
      "phase-9-sandbox-inference-after-provider-switch",
      true,
    );
    expect(switchedInference.exitCode, resultText(switchedInference)).toBe(0);
    expect(containsAnswer(switchedInference.stdout, "42"), resultText(switchedInference)).toBe(
      true,
    );
    expect(
      fake
        .requests()
        .slice(switchedRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions" &&
            request.model === SWITCH_MODEL,
        ),
    ).toBe(true);
    const activeModelsAfterSwitch = await host.command("ollama", ["ps"], {
      artifactName: "phase-9-ollama-ps-after-provider-switch",
      env: env(),
      timeoutMs: 30_000,
    });
    expect(activeModelsAfterSwitch.exitCode, resultText(activeModelsAfterSwitch)).toBe(0);
    expect(activeModelsAfterSwitch.stdout).not.toContain(model);

    progress.phase("remove GPU double-onboard sandbox");
    await host.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "verify-cleanup-nemoclaw-destroy",
      env: env(),
      timeoutMs: 20 * 60_000,
    });
    const registryFile = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
    const registryText = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, "utf8") : "";
    expect(registryText).not.toContain(SANDBOX_NAME);
    await artifacts.target.complete({
      id: "gpu-double-onboard",
      status: "passed",
      assertions: {
        ollamaModelActiveBeforeProviderSwitch: true,
        inferenceSetCompleted: providerSwitch.exitCode === 0,
        switchedProviderInferenceReturned42: true,
        supersededOllamaModelAbsentAfterSwitch: true,
      },
    });
  },
);
