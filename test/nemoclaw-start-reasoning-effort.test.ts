// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const src = fs.readFileSync(START_SCRIPT, "utf-8");

function extractShellFunction(name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  expect(match, `Expected ${name} in scripts/nemoclaw-start.sh`).not.toBeNull();
  return `${name}() {${match?.[1] ?? ""}\n}`;
}

function runApplyModelOverride(
  env: Record<string, string> = {},
  initialApi = "openai-completions",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reasoning-effort-override-"));
  const openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify({
      agents: { defaults: { model: { primary: "old-model" } } },
      models: {
        providers: {
          inference: {
            api: initialApi,
            models: [
              {
                id: "old-model",
                name: "old-model",
                contextWindow: 1024,
                maxTokens: 128,
                reasoning: false,
                params: {
                  extra_body: {
                    reasoning_effort: "low",
                    preserve_me: true,
                  },
                },
              },
            ],
          },
        },
      },
    }),
  );
  const configPath = path.join(openclawDir, "openclaw.json");
  const hashPath = path.join(openclawDir, ".config-hash");
  fs.writeFileSync(hashPath, "oldhash\n");
  fs.chmodSync(openclawDir, 0o2770);
  fs.chmodSync(configPath, 0o660);
  fs.chmodSync(hashPath, 0o660);

  const helperFns = [
    extractShellFunction("openclaw_config_dir_owner"),
    extractShellFunction("prepare_openclaw_config_for_write"),
    extractShellFunction("restore_openclaw_config_after_write"),
  ]
    .join("\n")
    .replaceAll("/sandbox", root);
  const fn = extractShellFunction("apply_model_override").replaceAll("/sandbox", root);
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "id() { echo 0; }",
    "chown() { return 0; }",
    `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
    'relax_config_for_write() { chmod 644 "$@"; }',
    'lock_config_after_write() { chmod 444 "$@"; }',
    helperFns,
    fn,
    "apply_model_override",
  ].join("\n");
  const script = path.join(root, "run.sh");
  fs.writeFileSync(script, wrapper, { mode: 0o700 });
  const result = spawnSync("bash", [script], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const hash = fs.readFileSync(hashPath, "utf-8");
  fs.rmSync(root, { recursive: true, force: true });
  return { result, config, hash };
}

describe("runtime reasoning-effort override (#7659)", () => {
  it("applies reasoning effort only to the final compatible OpenAI route", () => {
    const applied = runApplyModelOverride({
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_REASONING_EFFORT: "high",
    });
    expect(applied.result.status).toBe(0);
    expect(applied.config.models.providers.inference.models[0].params).toEqual({
      extra_body: { reasoning_effort: "high", preserve_me: true },
    });

    const switched = runApplyModelOverride({
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      NEMOCLAW_REASONING_EFFORT: "high",
    });
    expect(switched.result.status).toBe(0);
    expect(switched.config.models.providers.inference.api).toBe("anthropic-messages");
    expect(switched.config.models.providers.inference.models[0].params).toEqual({
      extra_body: { preserve_me: true },
    });

    const switchedToOpenAi = runApplyModelOverride(
      {
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_API_OVERRIDE: "openai-completions",
        NEMOCLAW_REASONING_EFFORT: "high",
      },
      "anthropic-messages",
    );
    expect(switchedToOpenAi.result.status).toBe(0);
    expect(switchedToOpenAi.config.models.providers.inference.api).toBe("openai-completions");
    expect(switchedToOpenAi.config.models.providers.inference.models[0].params).toEqual({
      extra_body: { reasoning_effort: "high", preserve_me: true },
    });
  });

  it("accepts default as an explicit reasoning-effort clear", () => {
    const { result, config } = runApplyModelOverride({
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_REASONING_EFFORT: "default",
    });

    expect(result.status).toBe(0);
    expect(config.models.providers.inference.models[0].params).toEqual({
      extra_body: { preserve_me: true },
    });
  });

  it("treats an invalid effort as an atomic no-op", () => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_REASONING_EFFORT: "extreme",
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'must be "low", "medium", "high", or "default"',
    );
    expect(config.agents.defaults.model.primary).toBe("old-model");
    expect(config.models.providers.inference.api).toBe("openai-completions");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "old-model",
      name: "old-model",
      contextWindow: 1024,
      maxTokens: 128,
      reasoning: false,
      params: {
        extra_body: {
          reasoning_effort: "low",
          preserve_me: true,
        },
      },
    });
    expect(hash).toBe("oldhash\n");
  });
});
