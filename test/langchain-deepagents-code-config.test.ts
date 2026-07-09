// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgent } from "../src/lib/agent/defs";
import {
  coerceAgentInferenceApi,
  getSandboxInferenceConfig,
  INFERENCE_ROUTE_URL,
} from "../src/lib/inference/config";

const tmpHomes: string[] = [];

afterEach(() => {
  for (const dir of tmpHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runGeneratorProcess(
  env: Record<string, string>,
): SpawnSyncReturns<string> & { home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-config-"));
  tmpHomes.push(home);
  const script = path.join(
    process.cwd(),
    "agents",
    "langchain-deepagents-code",
    "generate-config.ts",
  );
  return {
    ...spawnSync(process.execPath, ["--experimental-strip-types", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        ...env,
      },
    }),
    home,
  };
}

function runGenerator(env: Record<string, string>): string {
  const result = runGeneratorProcess(env);
  expect(result.status).toBe(0);
  return fs.readFileSync(path.join(result.home, ".deepagents", "config.toml"), "utf8");
}

describe("LangChain Deep Agents Code config generator", () => {
  it("routes managed inference through OpenAI-compatible chat completions", () => {
    const config = runGenerator({});

    expect(config).toContain('default = "openai:nvidia/nemotron-3-super-120b-a12b"');
    expect(config).toContain('api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"');
    expect(config).toContain('base_url = "https://inference.local/v1"');
    expect(config).toContain(
      "# NemoClaw provider route: inference; upstream provider: nvidia-prod; API: openai-completions.",
    );
    expect(config).toContain("use_responses_api = false");
    expect(config).not.toContain("force_nonempty_content");
    expect(config).toContain("check = false");
    expect(config).toContain("auto_update = false");
    expect(config).not.toMatch(/NVIDIA_API_KEY|OPENAI_API_KEY=|sk-/);
  });

  it("does not double-prefix provider-qualified model names", () => {
    const config = runGenerator({ NEMOCLAW_MODEL: "openai:gpt-oss-120b" });

    expect(config).toContain('default = "openai:gpt-oss-120b"');
    expect(config).toContain('models = ["gpt-oss-120b"]');
  });

  it.each([
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
  ])("adds the required coding-agent request options for %s", (model) => {
    const config = runGenerator({ NEMOCLAW_MODEL: model });

    expect(config).toContain(`[models.providers.openai.params."${model}"]`);
    expect(config).toContain(
      "extra_body = { chat_template_kwargs = { force_nonempty_content = true } }",
    );
  });

  it("preserves colons that belong to the model ID", () => {
    const config = runGenerator({ NEMOCLAW_MODEL: "minimax/minimax-m2.5:free" });

    expect(config).toContain('default = "openai:minimax/minimax-m2.5:free"');
    expect(config).toContain('models = ["minimax/minimax-m2.5:free"]');
  });

  it("rejects credential-bearing inference base URLs before writing config", () => {
    const result = runGeneratorProcess({
      NEMOCLAW_INFERENCE_BASE_URL: "https://user:pass@example.test/v1",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "NEMOCLAW_INFERENCE_BASE_URL must not include credentials.",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("user:pass");
    expect(fs.existsSync(path.join(result.home, ".deepagents", "config.toml"))).toBe(false);
  });

  it("rejects inference base URLs with query strings before writing config", () => {
    const result = runGeneratorProcess({
      NEMOCLAW_INFERENCE_BASE_URL: "https://example.test/v1?api_key=sk-test-secret",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "NEMOCLAW_INFERENCE_BASE_URL must not include query strings or fragments.",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("sk-test-secret");
    expect(fs.existsSync(path.join(result.home, ".deepagents", "config.toml"))).toBe(false);
  });

  it.each([
    ["NEMOCLAW_PROVIDER_KEY", "inference\n[update]\nauto_update = true"],
    ["NEMOCLAW_UPSTREAM_PROVIDER", "nvidia-prod\r[update]\nauto_update = true"],
    ["NEMOCLAW_INFERENCE_API", "openai-completions\n[update]\nauto_update = true"],
  ])("rejects control characters in %s before writing config", (envName, value) => {
    const result = runGeneratorProcess({ [envName]: value });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${envName} must not contain control characters.`,
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("auto_update = true");
    expect(fs.existsSync(path.join(result.home, ".deepagents", "config.toml"))).toBe(false);
  });

  it("bakes the /v1 managed route for a fresh Custom Anthropic-compatible onboard (#6294)", () => {
    // Real manifest: Deep Agents Code declares the OpenAI-only inference contract.
    const agent = loadAgent("langchain-deepagents-code");
    expect(agent.inference?.provider_type).toBe("openai_compatible");

    // The Anthropic endpoint probe resolves anthropic-messages on this route.
    // Pre-fix, that seed reached getSandboxInferenceConfig un-coerced and
    // produced the /v1-less Anthropic base URL that the egress proxy 403s.
    const uncoerced = getSandboxInferenceConfig(
      "nvidia/nvidia/nemotron-3-super-v3",
      "compatible-anthropic-endpoint",
      "anthropic-messages",
    );
    expect(uncoerced.inferenceBaseUrl).toBe("https://inference.local");

    const coercedApi = coerceAgentInferenceApi(agent, "anthropic-messages");
    expect(coercedApi).toBe("openai-completions");
    const route = getSandboxInferenceConfig(
      "nvidia/nvidia/nemotron-3-super-v3",
      "compatible-anthropic-endpoint",
      coercedApi,
    );
    expect(route.inferenceBaseUrl).toBe(INFERENCE_ROUTE_URL);

    // Feed the routed values through the real config generator, mirroring the
    // patched Dockerfile ARG -> ENV -> generate-config chain at image build.
    const config = runGenerator({
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-super-v3",
      NEMOCLAW_PROVIDER_KEY: route.providerKey,
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-anthropic-endpoint",
      NEMOCLAW_INFERENCE_BASE_URL: route.inferenceBaseUrl,
      NEMOCLAW_INFERENCE_API: route.inferenceApi,
    });

    expect(config).toContain('base_url = "https://inference.local/v1"');
    expect(config).toContain(
      "# NemoClaw provider route: inference; upstream provider: compatible-anthropic-endpoint; API: openai-completions.",
    );
    expect(config).toContain("[models.providers.openai]");
  });
});
