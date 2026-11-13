// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, onTestFinished } from "vitest";
import {
  createOnboardProcessWorkspace,
  minimalSpawnEnv,
} from "../helpers/onboard-child-process-harness";
import { execTimeout, testTimeout } from "../helpers/timeouts";

function createResumeScenario(editing: boolean) {
  const workspace = createOnboardProcessWorkspace("onboard-nvidia-provider-resume-");
  onTestFinished(workspace.remove);
  const env = minimalSpawnEnv(workspace.homeDir, { NODE_OPTIONS: process.env.NODE_OPTIONS });
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const load = (name) => require(path.join(process.cwd(), "src/lib", name));
    const attempt = process.env.TEST_ATTEMPT;
    const vllmInstall = attempt === "vllm install";
    const fresh = attempt === "fresh" || vllmInstall;
    const unattended = process.env.NEMOCLAW_NON_INTERACTIVE === "1";
    const editing = ${editing};
    const reviewedRoute = {
      provider: "openai-api", model: "gpt-5", endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY", preferredInferenceApi: "openai-responses",
    };
    const chosenModel = "nvidia/nemotron-3-super-120b-a12b";
    const interrupted = new Error("interrupted during provider selection");
    const name = "cred-interrupt";
    const state = load("state/onboard-session.ts");
    const sandbox = load("onboard/session-bootstrap.ts");
    const credentials = load("credentials/store.ts");
    credentials.prompt = async (question, options) => {
      assert.equal(unattended, false, "unattended resume unexpectedly prompted");
      if (question.includes("Options: retry")) return "retry";
      if (question.includes("NVIDIA Endpoints API key")) {
        assert.equal(options.secret, true);
        throw interrupted;
      }
      assert.match(question, /Choose /);
      if (attempt === "provider menu") throw interrupted;
      assert.ok(fresh, "explicit build unexpectedly prompted for a provider");
      return "1"; // NVIDIA Endpoints
    };
    if (fresh && editing) {
      process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-rejected";
      for (const stream of [process.stdin, process.stderr]) Object.assign(stream, { isTTY: true });
      load("onboard/nvidia-featured-model-selection.ts").createNvidiaFeaturedModelSession = (options) =>
        ({ select: async () => { options.onModelSelected(chosenModel, "product_catalog"); return chosenModel; } });
    } else {
      credentials.ensureApiKey = async () => {
        assert.ok(fresh || attempt === "build key", "unexpected NVIDIA key prompt");
        throw interrupted;
      };
    }
    load("onboard/provider-host-state.ts").detectInferenceProviderHostState = () => ({
      isWsl: true, hasOllama: true, ollamaRunning: true, ollamaHost: "localhost", gpuNimCapable: false,
      windowsHostOllamaDockerRequirement: { supported: true }, vllmEntries: [], ollamaInstallMenu: {},
    });
    const wrongProvider = () => { throw new Error("resume selected local Ollama"); };
    load("onboard/setup-nim-ollama.ts").createSetupNimOllamaHandlers = () => ({
      handleRunningOllamaSelection: wrongProvider,
      handleInstallOllamaSelection: wrongProvider,
    });
    load("inference/onboard-probes.ts").probeOpenAiLikeEndpointOptimized = async (_url, model) => {
      if (unattended) return { ok: true, api: "openai-completions" };
      assert.equal(model, chosenModel);
      return { ok: false, failures: [{ httpStatus: 401 }] };
    };
    const { setupNim } = load("onboard.ts");
    const agent = load("agent/defs.ts").loadAgent("openclaw");

    async function run() {
      if (fresh) state.saveSession(state.createSession({ sandboxName: name, agent: "openclaw" }));
      if (fresh && editing) await sandbox.checkpointSandboxName(name, agent, state.updateSession);
      const session = state.markStepStarted("provider_selection", fresh && editing ? reviewedRoute : {});
      if (vllmInstall) {
        state.checkpointVllmInstallModel("example/local-model");
        state.markStepFailed("provider_selection", "vLLM install interrupted");
        return;
      }
      // The sandbox does not exist yet, so registry and gateway recovery are disabled.
      const select = () => setupNim(null, name, agent, false, null, "nemoclaw", undefined,
        undefined, session.sessionId);
      if (!unattended) {
        await assert.rejects(select, (error) => error === interrupted);
        state.markStepFailed("provider_selection", interrupted.message);
        return;
      }
      const selection = await select();
      assert.equal(selection.provider, "nvidia-prod");
      assert.equal(state.loadSession().vllmInstallModel, null);
      assert.equal(selection.model, editing ? chosenModel : load("inference/config.ts").resolveAgentDefaultCloudModel(agent));
      if (editing) assert.equal(selection.modelSelectionProvenance?.modelSource, "product_catalog");
    }
    run().then(() => {
      const savedSession = fs.readFileSync(state.SESSION_FILE, "utf8");
      assert.doesNotMatch(savedSession, /nvapi-(?:rejected|fixture)/u);
      if (fresh && editing) {
        const saved = JSON.parse(savedSession);
        for (const field of Object.keys(reviewedRoute)) assert.equal(saved[field], null, field);
        assert.equal(sandbox.getCheckpointedSandboxName(true, agent, saved), name);
      }
      console.log("scenario completed");
    });
  `;
  return function run(
    attempt: string,
    overrides: NodeJS.ProcessEnv = {},
    expected = { status: 0, output: "scenario completed" },
  ) {
    const result = workspace.runNodeSource(script, {
      timeout: execTimeout(30_000),
      env: { ...env, TEST_ATTEMPT: attempt, ...overrides },
    });
    expect(result.status, result.output).toBe(expected.status);
    expect(result.output).toContain(expected.output);
  };
}

const timeout = { timeout: testTimeout(60_000) };
const unattendedEnv = { NEMOCLAW_NON_INTERACTIVE: "1", NVIDIA_INFERENCE_API_KEY: "nvapi-fixture" };

it("resumes NVIDIA Endpoints after switching from an interrupted vLLM install", timeout, () => {
  const run = createResumeScenario(false);
  run("vllm install");
  run("build key", { NEMOCLAW_PROVIDER: "build" });
  run("unattended", unattendedEnv);
});

it(
  "resumes NVIDIA Endpoints after interrupting the first key prompt on WSL (#13968)",
  timeout,
  () => {
    const run = createResumeScenario(false);
    run("fresh");
    run("unattended", unattendedEnv);
  },
);

it(
  "keeps the chosen NVIDIA model across interrupted prompts and an unavailable Local NIM switch on WSL (#13968)",
  timeout,
  () => {
    const run = createResumeScenario(true);
    run("fresh");
    run("provider menu");
    run("build key", { NEMOCLAW_PROVIDER: "build" });
    run(
      "unavailable Local NIM",
      {
        NEMOCLAW_EXPERIMENTAL: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "nim-local",
      },
      { status: 1, output: "Requested provider 'nim-local' is not available" },
    );
    run("unattended", unattendedEnv);
  },
);
