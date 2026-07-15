// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createLocalInferenceRouteApplier } from "../src/lib/onboard/local-inference-route.js";
import type { SetupInference } from "../src/lib/onboard/setup-inference.js";
import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";
import {
  bedrockRuntimeOnboard,
  type CommandEntry,
  createDirectSetupInferenceHarness,
  parseStdoutJson,
  stripMessagingEnv,
} from "./helpers/onboard-split-context";
import {
  createDirectCommandRouter,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

describe("onboard helpers", () => {
  it("reuses a registered Hermes Provider without re-collecting host credentials", async () => {
    await withProcessEnv(
      {
        NOUS_API_KEY: "nous-host-secret",
        OPENAI_API_KEY: "openai-host-secret",
      },
      async () => {
        const harness = createDirectSetupInferenceHarness({
          runOpenshell: (args) =>
            args.join(" ") === "provider get -g nemoclaw hermes-provider"
              ? { status: 0, stdout: "Provider: hermes-provider", stderr: "" }
              : undefined,
          overrides: { isNonInteractive: () => true },
        });

        await harness.setupInference(
          "test-box",
          "moonshotai/kimi-k2.6",
          "hermes-provider",
          "https://8.8.8.8/v1",
          "OPENAI_API_KEY",
          "oauth",
        );

        const commands = harness.commands;
        assert.equal(commands.length, 3);
        assert.equal(commands[0].command, "provider list -g nemoclaw");
        assert.equal(commands[1].command, "provider get -g nemoclaw hermes-provider");
        assert.match(
          commands[2].command,
          /inference set -g nemoclaw --no-verify --provider hermes-provider/,
        );
        assert.ok(!commands.some((entry) => entry.command.startsWith("gateway select")));
        assert.ok(!commands.some((entry) => /provider (create|update)/.test(entry.command)));
        assert.ok(!commands.some((entry) => entry.env?.NOUS_API_KEY || entry.env?.OPENAI_API_KEY));
        assert.ok(
          !commands.some((entry) => /nous-host-secret|openai-host-secret/.test(entry.command)),
          "host credential values must not appear in argv",
        );
      },
    );
  });
  it("routes Bedrock Runtime custom Anthropic endpoints through the hidden OpenAI adapter", async () => {
    await withProcessEnv({ COMPATIBLE_ANTHROPIC_API_KEY: "bedrock-bearer" }, async () => {
      const updateSandbox = vi.fn(() => true);
      const ensureAdapter = vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11436/v1",
        localBaseUrl: "http://127.0.0.1:11436/v1",
        credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
        token: "adapter-token",
        region: "us-east-1",
        logPath: "/tmp/bedrock-adapter.log",
      }));
      const setupBedrockRuntimeInference = bedrockRuntimeOnboard.setupBedrockRuntimeInference;
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args.join(" ") === "provider get -g nemoclaw compatible-anthropic-endpoint"
            ? { status: 1, stdout: "", stderr: "" }
            : undefined,
        overrides: {
          updateSandbox,
          bedrockRuntimeOnboard: {
            setupBedrockRuntimeInference: (
              input: Parameters<typeof setupBedrockRuntimeInference>[0],
            ) => setupBedrockRuntimeInference({ ...input, ensureAdapter }),
          },
        },
      });
      const consoleOutput: string[] = [];
      const captureConsole = (...args: unknown[]) => consoleOutput.push(args.map(String).join(" "));
      const error = vi.spyOn(console, "error").mockImplementation(captureConsole);
      const log = vi.spyOn(console, "log").mockImplementation(captureConsole);
      try {
        await harness.setupInference(
          "test-box",
          "anthropic.claude-3-5-sonnet-20240620-v1:0",
          "compatible-anthropic-endpoint",
          "https://bedrock-runtime.us-east-1.amazonaws.com",
          "COMPATIBLE_ANTHROPIC_API_KEY",
        );
      } finally {
        error.mockRestore();
        log.mockRestore();
      }

      const commands = harness.commands;
      const providerCommand = commands.find((entry) => /provider create/.test(entry.command));
      assert.ok(providerCommand, "expected hidden adapter provider registration");
      assert.match(providerCommand.command, /--name compatible-anthropic-endpoint/);
      assert.match(providerCommand.command, /--type openai/);
      assert.match(providerCommand.command, /--credential NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN/);
      assert.match(
        providerCommand.command,
        /OPENAI_BASE_URL=http:\/\/host\.openshell\.internal:11436\/v1/,
      );
      assert.equal(providerCommand.env?.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN, "adapter-token");
      assert.ok(
        !JSON.stringify(commands).includes("bedrock-bearer"),
        "Bedrock bearer token must not appear in OpenShell argv or env",
      );
      assert.deepEqual(harness.errors, []);
      assert.deepEqual(harness.logs, [
        "  Bedrock Runtime adapter ready: region us-east-1, sandbox route http://host.openshell.internal:11436/v1, host log /tmp/bedrock-adapter.log",
        "  ✓ Inference route set: compatible-anthropic-endpoint / anthropic.claude-3-5-sonnet-20240620-v1:0",
      ]);
      assert.doesNotMatch(
        [...harness.logs, ...harness.errors, ...consoleOutput].join("\n"),
        /bedrock-bearer|adapter-token/,
        "Bedrock tokens must not appear in onboarding console output",
      );
      const sandboxCommands = commands.filter((entry) => /\bsandbox\b/.test(entry.command));
      assert.ok(
        !sandboxCommands.some((entry) =>
          JSON.stringify(entry).includes("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"),
        ),
        "adapter credential env must not be passed to sandbox commands",
      );
      assert.ok(
        !sandboxCommands.some((entry) => JSON.stringify(entry).includes("adapter-token")),
        "adapter token must not be passed to sandbox commands",
      );
      assert.match(
        commands.at(-1)?.command || "",
        /inference set -g nemoclaw --no-verify --provider compatible-anthropic-endpoint --model anthropic\.claude-3-5-sonnet-20240620-v1:0/,
      );
      // biome-ignore format: keep the complete route reservation assertion within this legacy file's enforced budget.
      expect(updateSandbox).toHaveBeenCalledWith("test-box", { model: "anthropic.claude-3-5-sonnet-20240620-v1:0", provider: "compatible-anthropic-endpoint", endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY", preferredInferenceApi: null, gatewayName: "nemoclaw" });
    });
  });
  it("resolves a sandbox name before reconciling Hermes Provider on resume", {
    timeout: 60_000,
  }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-resume-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "hermes-resume-sandbox-name-check.js");
    const openshellPath = JSON.stringify(path.join(fakeBin, "openshell"));
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "onboard-session.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const nimPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "nim.ts"));
    const gatewayStatePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "state", "gateway.ts"),
    );
    const dockerDriverPlatformPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "docker-driver-platform.ts"),
    );
    const gatewayGpuPassthroughPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "gateway-gpu-passthrough.ts"),
    );
    const onboardProbesPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "onboard-probes.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const onboardSession = require(${sessionPath});
const credentials = require(${credentialsPath});
const nim = require(${nimPath});
const gatewayState = require(${gatewayStatePath});
const dockerDriverPlatform = require(${dockerDriverPlatformPath});
const gatewayGpuPassthrough = require(${gatewayGpuPassthroughPath});
const onboardProbes = require(${onboardProbesPath});

const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const commands = [];
const prompts = [];
const registryUpdates = [];
const done = new Error("INFERENCE_STEP_DONE");
let inferenceSessionSnapshot = null;

delete process.env.NEMOCLAW_NON_INTERACTIVE;
delete process.env.NEMOCLAW_SANDBOX_NAME;
delete process.env.NOUS_API_KEY;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("DISCORD_") || key.startsWith("TELEGRAM_")) {
    delete process.env[key];
  }
}
process.env.NEMOCLAW_OPENSHELL_BIN = ${openshellPath};
process.env.OPENSHELL_GATEWAY = "nemoclaw";

try {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
} catch {
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
}

runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  if (normalized.includes("inference get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};

registry.getSandbox = (name) =>
  name === "hermes-resume"
    ? {
        name,
        gpuEnabled: false,
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
        hermesToolGateways: [],
        policies: ["nous-web"],
      }
    : null;
registry.reserveSandboxInferenceRoute = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};
registry.setDefault = () => true;
registry.removeSandbox = () => true;

credentials.prompt = async (question) => {
  prompts.push(String(question));
  if (String(question).includes("Sandbox name")) return "hermes-resume";
  return "yes";
};

nim.detectGpu = () => null;
gatewayState.getGatewayReuseState = () => "healthy";
gatewayState.shouldSelectNamedGatewayForReuse = () => false;
gatewayState.getSandboxStateFromOutputs = () => "ready";
gatewayState.isGatewayHealthy = () => true;
dockerDriverPlatform.isLinuxDockerDriverGatewayEnabled = () => false;
gatewayGpuPassthrough.reconcileGatewayGpuReuseForGpuIntent = ({ gatewayReuseState }) => gatewayReuseState;
onboardProbes.verifyOnboardInferenceSmoke = () => {};

const complete = () => ({
  status: "complete",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  error: null,
});
onboardSession.saveSession(
  onboardSession.createSession({
    mode: "interactive",
    agent: "hermes",
    sandboxName: null,
    provider: "hermes-provider",
    model: "moonshotai/kimi-k2.6",
    endpointUrl: "https://8.8.8.8/v1",
    credentialEnv: "NOUS_API_KEY",
    hermesAuthMethod: "api_key",
    hermesToolGateways: [],
    policyPresets: ["nous-web"],
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    steps: {
      preflight: complete(),
      gateway: complete(),
      provider_selection: complete(),
    },
  }),
);

const originalMarkStepComplete = onboardSession.markStepComplete;
onboardSession.markStepComplete = (stepName, updates = {}) => {
  const result = originalMarkStepComplete(stepName, updates);
  if (stepName === "inference") {
    inferenceSessionSnapshot = result;
    throw done;
  }
  return result;
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({ resume: true, agent: "hermes", acceptThirdPartySoftware: true, noGpu: true });
    throw new Error("Expected onboarding to reach the inference step");
  } catch (error) {
    if (error === done || error?.message === done.message) {
      console.log(JSON.stringify({
        commands,
        prompts,
        registryUpdates,
        inferenceSessionSandboxName: inferenceSessionSnapshot?.sandboxName ?? null,
      }));
      return;
    }
    console.error(error);
    process.exit(1);
  }
})();
`;
    fs.writeFileSync(scriptPath, script);

    const env: Record<string, string | undefined> = {
      ...stripMessagingEnv(process.env),
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
    };
    delete env.NEMOCLAW_NON_INTERACTIVE;
    delete env.NEMOCLAW_SANDBOX_NAME;
    delete env.NOUS_API_KEY;

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      `${result.stderr}\n${result.stdout}`,
      /Hermes Provider requires a sandbox name/,
    );
    const payload = parseStdoutJson<{
      commands: CommandEntry[];
      prompts: string[];
      registryUpdates: Array<{ name: string; updates: Record<string, unknown> }>;
      inferenceSessionSandboxName: string | null;
    }>(result.stdout);

    assert.ok(
      payload.prompts.some((question) => question.includes("Sandbox name")),
      "resume should prompt for the missing sandbox name before Hermes inference reconciliation",
    );
    assert.ok(
      payload.commands.some((entry) =>
        /inference set -g nemoclaw --no-verify --provider hermes-provider/.test(entry.command),
      ),
      "resume should reach openshell inference set",
    );
    assert.ok(!payload.commands.some((entry) => /provider (create|update)/.test(entry.command)));
    assert.equal(
      payload.inferenceSessionSandboxName,
      null,
      "resume inference must not persist sandboxName before sandbox creation",
    );
    assert.ok(
      payload.registryUpdates.some(
        (call) =>
          call.name === "hermes-resume" &&
          call.updates.provider === "hermes-provider" &&
          call.updates.model === "moonshotai/kimi-k2.6",
      ),
      "Hermes setup should reconcile inference against the resolved sandbox name",
    );
  });

  it("reconciles a registered Hermes Provider when a fresh shell Nous key is selected", async () => {
    await withProcessEnv(
      {
        NOUS_API_KEY: "nous-host-secret",
        OPENAI_API_KEY: undefined,
      },
      async () => {
        const harness = createDirectSetupInferenceHarness({
          runOpenshell: (args) =>
            args.join(" ") === "provider get -g nemoclaw hermes-provider"
              ? { status: 0, stdout: "Provider: hermes-provider", stderr: "" }
              : undefined,
          overrides: { isNonInteractive: () => true },
        });

        await harness.setupInference(
          "test-box",
          "moonshotai/kimi-k2.6",
          "hermes-provider",
          "https://8.8.8.8/v1",
          "NOUS_API_KEY",
          "api_key",
        );

        const update = harness.commands.find((entry) =>
          /provider update -g nemoclaw hermes-provider/.test(entry.command),
        );
        assert.ok(update);
        assert.match(update.command, /--credential NOUS_API_KEY/);
        assert.equal(update.env?.NOUS_API_KEY, "nous-host-secret");
        assert.ok(
          !harness.commands.some((entry) => /nous-host-secret/.test(entry.command)),
          "shell credential value must not appear in argv",
        );
        assert.match(
          harness.commands.at(-1)?.command || "",
          /inference set -g nemoclaw --no-verify --provider hermes-provider/,
        );
      },
    );
  });
  it("does not delete saved OpenAI credentials when configuring local vLLM", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-local-vllm-"));
    const credentials = require("../src/lib/credentials/store") as {
      saveCredential(key: string, value: string): void;
      getCredential(key: string): string | null;
    };
    try {
      await withProcessEnv({ HOME: tmpDir, OPENAI_API_KEY: undefined }, async () => {
        credentials.saveCredential("OPENAI_API_KEY", "sk-existing");
        let harness: ReturnType<typeof createDirectSetupInferenceHarness>;
        const applyLocalInferenceRoute = createLocalInferenceRouteApplier({
          runOpenshell: (args, options) => harness.runOpenshell(args, options),
          isNonInteractive: () => false,
          promptValidationRecovery: async () => "selection",
          classifyApplyFailure: () => ({}) as never,
          compactText: (value) => value.trim(),
          redact: (value) => value,
          localInferenceTimeoutSecs: 120,
          error: vi.fn(),
          exitProcess: () => assert.fail("unexpected exit"),
        });
        harness = createDirectSetupInferenceHarness({
          runOpenshell: (args) =>
            args.slice(0, 2).join(" ") === "provider get"
              ? { status: 1, stdout: "", stderr: "" }
              : undefined,
          overrides: { applyLocalInferenceRoute },
        });
        await harness.setupInference("test-box", "meta-llama", "vllm-local");
        const providerCommand = harness.commands.find((entry) =>
          entry.command.includes("provider create"),
        );
        assert.ok(providerCommand, "expected local vLLM provider create command");
        assert.match(providerCommand.command, /--credential NEMOCLAW_VLLM_LOCAL_TOKEN/);
        assert.doesNotMatch(providerCommand.command, /--credential OPENAI_API_KEY/);
        assert.equal(providerCommand.env?.NEMOCLAW_VLLM_LOCAL_TOKEN, "dummy");
        assert.equal(credentials.getCredential("OPENAI_API_KEY"), "sk-existing");
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("recovers the Ollama auth proxy on WSL when the sandbox needs proxy fronting", async () => {
    const proxyCalls: string[] = [];
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: (args) =>
        args.slice(0, 2).join(" ") === "provider get"
          ? { status: 1, stdout: "", stderr: "" }
          : undefined,
      overrides: {
        validateLocalProvider: () => ({
          ok: false,
          message: "container cannot reach Ollama",
          diagnostic: "simulated WSL native Docker reachability failure",
        }),
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy: () => proxyCalls.push("ensure"),
        isProxyHealthy: () => {
          proxyCalls.push("healthy");
          return true;
        },
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy: async (token: string) => {
          proxyCalls.push(`persist:${token}`);
        },
        applyLocalInferenceRoute: undefined,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await harness.setupInference("test-box", "qwen3.5:9b", "ollama-local");
    } finally {
      warn.mockRestore();
    }
    assert.deepEqual(proxyCalls, ["ensure", "healthy", "persist:proxy-token"]);
    const providerCommand = harness.commands.find(
      (entry) =>
        entry.command.includes("provider create") && entry.command.includes("ollama-local"),
    );
    assert.ok(providerCommand, "expected ollama-local provider create command");
    assert.match(providerCommand.command, /--credential NEMOCLAW_OLLAMA_PROXY_TOKEN/);
    assert.equal(providerCommand.env?.NEMOCLAW_OLLAMA_PROXY_TOKEN, "proxy-token");
    assert.doesNotMatch(providerCommand.command, /proxy-token/);
    assert.ok(
      harness.commands.some((entry) =>
        entry.command.includes("inference set -g nemoclaw --no-verify --provider ollama-local"),
      ),
      "expected ollama-local inference route to be selected",
    );
  });
  it("surfaces a contextual error and exits when ollama-local inference set fails after the proxy-ready warning (#4257)", async () => {
    const error = vi.fn();
    const exitProcess = vi.fn((code: number): never => {
      throw Object.assign(new Error(`EXIT_CALLED:${code}`), { __exit: true });
    });
    const commandRouter = createDirectCommandRouter([
      {
        name: "provider-get",
        matches: (command) => command.startsWith("provider get"),
        results: [{ status: 1, stdout: "", stderr: "" }],
      },
      {
        name: "ollama-inference-set",
        matches: (command) => command.includes("inference set") && command.includes("ollama-local"),
        results: [{ status: 7, stdout: "", stderr: "openshell: route apply failed" }],
      },
    ]);
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: commandRouter.runOpenshell,
      overrides: {
        isNonInteractive: () => true,
        validateLocalProvider: () => ({
          ok: false,
          message: "container cannot reach Ollama",
          diagnostic: "simulated WSL native Docker reachability failure",
        }),
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy: () => {},
        isProxyHealthy: () => true,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy: async () => {},
        applyLocalInferenceRoute: undefined,
        error,
        exitProcess,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await assert.rejects(
        harness.setupInference("test-box", "qwen3.5:9b", "ollama-local"),
        (error: Error & { __exit?: boolean }) => error.__exit === true,
      );
    } finally {
      warn.mockRestore();
    }
    const setCmd = harness.commands.find((entry) =>
      entry.command.includes("inference set -g nemoclaw --no-verify --provider ollama-local"),
    );
    assert.ok(setCmd, "expected ollama-local inference set command to be issued");
    assert.equal(
      setCmd.ignoreError,
      true,
      "ollama-local inference set must use ignoreError so onboard can recover",
    );
    const combinedErr = error.mock.calls.flat().join("\n");
    assert.equal(exitProcess.mock.calls.length, 1);
    assert.equal(exitProcess.mock.calls[0]?.[0], 7);
    assert.match(combinedErr, /No sandbox was created/);
    assert.match(combinedErr, /nemoclaw onboard --resume/);
  });
  it("surfaces a contextual error and exits when vllm-local inference set fails (#4257)", async () => {
    const exitProcess = vi.fn((code: number): never => {
      throw Object.assign(new Error(`EXIT_CALLED:${code}`), { __exit: true });
    });
    const commandRouter = createDirectCommandRouter([
      {
        name: "provider-get",
        matches: (command) => command.startsWith("provider get"),
        results: [{ status: 1, stdout: "", stderr: "" }],
      },
      {
        name: "vllm-inference-set",
        matches: (command) => command.includes("inference set") && command.includes("vllm-local"),
        results: [{ status: 13, stdout: "", stderr: "openshell: vllm route apply failed" }],
      },
    ]);
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: commandRouter.runOpenshell,
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        exitProcess,
      },
    });

    await assert.rejects(
      harness.setupInference("test-box", "meta-llama", "vllm-local"),
      (error: Error & { __exit?: boolean }) => error.__exit === true,
    );

    const setCmd = harness.commands.find((entry) =>
      entry.command.includes("inference set -g nemoclaw --no-verify --provider vllm-local"),
    );
    assert.ok(setCmd, "expected vllm-local inference set command to be issued");
    assert.equal(
      setCmd.ignoreError,
      true,
      "vllm-local inference set must use ignoreError so onboard can recover",
    );
    const combinedErr = harness.errors.join("\n");
    assert.equal(exitProcess.mock.calls.length, 1);
    assert.equal(exitProcess.mock.calls[0]?.[0], 13);
    assert.match(combinedErr, /No sandbox was created/);
    assert.match(combinedErr, /nemoclaw onboard --resume/);
  });
  it("detects when the live inference route already matches the requested provider and model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "inference-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "inference" ] && [ "$2" = "get" ] && [ "$3" = "-g" ] && [ "$4" = "team-gateway" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: nvidia-prod
  Model: nvidia/nemotron-3-super-120b-a12b
  Version: 1
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isInferenceRouteReady } = require(${onboardPath});
console.log(JSON.stringify({
  same: isInferenceRouteReady("team-gateway", "nvidia-prod", "nvidia/nemotron-3-super-120b-a12b"),
  otherModel: isInferenceRouteReady("team-gateway", "nvidia-prod", "nvidia/other-model"),
  otherProvider: isInferenceRouteReady("team-gateway", "openai-api", "nvidia/nemotron-3-super-120b-a12b"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        same: true,
        otherModel: false,
        otherProvider: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when OpenClaw is already configured inside the sandbox", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "openclaw-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "sandbox" ] && [ "$2" = "download" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/sandbox/.openclaw"
  cat > "$dest/sandbox/.openclaw/openclaw.json" <<'EOF'
{"gateway":{"auth":{"token":"test-token"}}}
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isOpenclawReady } = require(${onboardPath});
console.log(JSON.stringify({
  ready: isOpenclawReady("my-assistant"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ ready: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when recorded policy presets are already applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-ready-"));
    const registryDir = path.join(tmpDir, ".nemoclaw");
    const registryFile = path.join(registryDir, "sandboxes.json");
    const scriptPath = path.join(tmpDir, "policy-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify(
        {
          sandboxes: {
            "my-assistant": {
              name: "my-assistant",
              policies: ["pypi", "npm"],
            },
          },
          defaultSandbox: "my-assistant",
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      scriptPath,
      `
const { arePolicyPresetsApplied } = require(${onboardPath});
console.log(JSON.stringify({
  ready: arePolicyPresetsApplied("my-assistant", ["pypi", "npm"]),
  missing: arePolicyPresetsApplied("my-assistant", ["pypi", "slack"]),
  empty: arePolicyPresetsApplied("my-assistant", []),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    try {
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload).toEqual({
        ready: true,
        missing: false,
        empty: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses native Anthropic provider creation without embedding the secret in argv", async () => {
    await withProcessEnv({ ANTHROPIC_API_KEY: "sk-ant-TEST-NOT-A-REAL-VALUE" }, async () => {
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get"
            ? { status: 1, stdout: "", stderr: "" }
            : undefined,
      });

      await harness.setupInference(
        "test-box",
        "claude-sonnet-4-5",
        "anthropic-prod",
        "https://api.anthropic.com",
        "ANTHROPIC_API_KEY",
      );

      const commands = harness.commands;
      assert.equal(commands.length, 3);
      assert.match(commands[0].command, /^provider get -g nemoclaw /);
      assert.match(commands[1].command, /^provider create -g nemoclaw /);
      assert.match(commands[1].command, /--type anthropic/);
      assert.match(commands[1].command, /--credential ANTHROPIC_API_KEY/);
      assert.doesNotMatch(commands[1].command, /sk-ant-TEST-NOT-A-REAL-VALUE/);
      assert.match(commands[2].command, /^inference set -g nemoclaw /);
      assert.match(commands[2].command, /--provider anthropic-prod/);
    });
  });
  it("updates OpenAI-compatible providers without passing an unsupported --type flag", async () => {
    await withProcessEnv({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-VALUE" }, async () => {
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args.slice(0, 2).join(" ") === "provider get"
            ? { status: 0, stdout: "", stderr: "" }
            : undefined,
      });

      await harness.setupInference(
        "test-box",
        "gpt-5.4",
        "openai-api",
        "https://api.openai.com/v1",
        "OPENAI_API_KEY",
      );

      const commands = harness.commands;
      assert.equal(commands.length, 3);
      assert.match(commands[0].command, /^provider get -g nemoclaw /);
      assert.match(commands[1].command, /^provider update -g nemoclaw openai-api/);
      assert.doesNotMatch(commands[1].command, /--type/);
      assert.match(commands[2].command, /^inference set -g nemoclaw --no-verify/);
    });
  });
  it("re-prompts for credentials when openshell inference set fails with authorization errors", async () => {
    await withProcessEnv({ OPENAI_API_KEY: "sk-bad" }, async () => {
      const commandRouter = createDirectCommandRouter([
        {
          name: "provider-get",
          matches: (command) => command.startsWith("provider get"),
          results: [{ status: 0, stdout: "", stderr: "" }],
        },
        {
          name: "inference-set",
          matches: (command) => command.includes("inference set"),
          results: [{ status: 1, stdout: "", stderr: "HTTP 403: forbidden" }, undefined],
        },
      ]);
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: commandRouter.runOpenshell,
        overrides: {
          promptValidationRecovery: async () => {
            process.env.OPENAI_API_KEY = "sk-good";
            return "retry";
          },
        },
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await harness.setupInference(
          "test-box",
          "gpt-5.4",
          "openai-api",
          "https://api.openai.com/v1",
          "OPENAI_API_KEY",
        );
      } finally {
        error.mockRestore();
      }

      assert.equal(process.env.OPENAI_API_KEY, "sk-good");
      assert.equal(commandRouter.callCount("inference-set"), 2);
      const providerEnvs = harness.commands
        .filter((entry) => entry.command.includes("provider"))
        .map((entry) => entry.env?.OPENAI_API_KEY)
        .filter(Boolean);
      assert.deepEqual(providerEnvs, ["sk-bad", "sk-good"]);
    });
  });
  it("returns control to provider selection when inference apply recovery chooses back", async () => {
    await withProcessEnv({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-VALUE" }, async () => {
      const commandRouter = createDirectCommandRouter([
        {
          name: "provider-get",
          matches: (command) => command.startsWith("provider get"),
          results: [{ status: 0, stdout: "", stderr: "" }],
        },
        {
          name: "inference-set",
          matches: (command) => command.includes("inference set"),
          results: [{ status: 1, stdout: "", stderr: "HTTP 404: model not found" }],
        },
      ]);
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: commandRouter.runOpenshell,
        overrides: { promptValidationRecovery: async () => "selection" },
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let result: Awaited<ReturnType<SetupInference>>;
      try {
        result = await harness.setupInference(
          "test-box",
          "gpt-5.4",
          "openai-api",
          "https://api.openai.com/v1",
          "OPENAI_API_KEY",
        );
      } finally {
        error.mockRestore();
      }

      assert.deepEqual(result, { retry: "selection" });
      assert.equal(
        harness.commands.filter((entry) => entry.command.includes("inference set")).length,
        1,
      );
    });
  });
  it("migrates a legacy credentials.json into env so setupInference can register the provider", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const legacyDir = path.join(tmpDir, ".nemoclaw");
    const legacyFile = path.join(legacyDir, "credentials.json");
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-STORED-KEY" }),
      { mode: 0o600 },
    );
    const credentialEnv =
      require("../src/lib/onboard/credential-env") as typeof import("../src/lib/onboard/credential-env.js");
    try {
      await withProcessEnv({ HOME: tmpDir, OPENAI_API_KEY: undefined }, async () => {
        const harness = createDirectSetupInferenceHarness({
          runOpenshell: (args) =>
            args.slice(0, 2).join(" ") === "provider get"
              ? { status: 0, stdout: "", stderr: "" }
              : undefined,
          overrides: { hydrateCredentialEnv: credentialEnv.hydrateCredentialEnv },
        });

        await harness.setupInference(
          "test-box",
          "gpt-5.4",
          "openai-api",
          "https://api.openai.com/v1",
          "OPENAI_API_KEY",
        );

        assert.equal(process.env.OPENAI_API_KEY, "sk-TEST-NOT-A-REAL-STORED-KEY");
        assert.equal(
          fs.existsSync(legacyFile),
          true,
          "legacy credentials.json must survive the staging-only hydrate path",
        );
        const providerUpdate = harness.commands.find((entry) =>
          entry.command.includes("provider update -g nemoclaw openai-api"),
        );
        assert.ok(providerUpdate, "expected provider update command");
        assert.equal(providerUpdate.env?.OPENAI_API_KEY, "sk-TEST-NOT-A-REAL-STORED-KEY");
        assert.doesNotMatch(providerUpdate.command, /sk-TEST-NOT-A-REAL-STORED-KEY/);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
