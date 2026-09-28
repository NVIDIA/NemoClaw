// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

const roots: string[] = [];

function fixture(dockerfile = "FROM example.invalid/openclaw\nUSER sandbox\n"): {
  configPath: string;
  dockerfilePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-model-"));
  roots.push(root);
  const dockerfilePath = path.join(root, "Dockerfile");
  const configDir = path.join(root, "openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  fs.writeFileSync(dockerfilePath, dockerfile);
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { defaults: { model: { primary: "inference/baked-model" } } },
      models: {
        providers: {
          inference: {
            models: [
              {
                id: "baked-model",
                name: "inference/baked-model",
                contextWindow: 131_072,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    }),
  );
  fs.writeFileSync(path.join(configDir, ".config-hash"), "stale\n");
  fs.chmodSync(configPath, 0o660);
  return { configPath, dockerfilePath };
}

function patchAndRun(dockerfilePath: string, configPath: string, model: string) {
  patchStagedDockerfile(
    dockerfilePath,
    model,
    "",
    "build-custom-model",
    "custom",
    null,
    null,
    null,
    false,
    null,
    [],
    { agentName: "openclaw", reconcileCustomOpenClawModel: true },
  );
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const script = /<<'PYNEMOCLAWCUSTOMMODEL'\n([\s\S]*?)\nPYNEMOCLAWCUSTOMMODEL/u.exec(
    dockerfile,
  )?.[1];
  const encodedModel = /^ARG NEMOCLAW_CUSTOM_MODEL_B64=(.+)$/mu.exec(dockerfile)?.[1];
  const encodedLimits = /^ARG NEMOCLAW_CUSTOM_MODEL_LIMITS_B64=(.+)$/mu.exec(dockerfile)?.[1];
  assert.ok(script);
  assert.ok(encodedModel);
  assert.ok(encodedLimits);
  const result = spawnSync("/usr/bin/python3", ["-I", "-"], {
    encoding: "utf8",
    input: script,
    env: {
      ...process.env,
      NEMOCLAW_CUSTOM_CONFIG_PATH: configPath,
      NEMOCLAW_CUSTOM_MODEL_B64: encodedModel,
      NEMOCLAW_CUSTOM_MODEL_LIMITS_B64: encodedLimits,
    },
  });
  return { dockerfile, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("custom OpenClaw model reconciliation", () => {
  it("uses the selected model and removes inherited limits (#12033)", () => {
    const { configPath, dockerfilePath } = fixture();
    const { dockerfile, result } = patchAndRun(
      dockerfilePath,
      configPath,
      "aws/anthropic/bedrock-claude-opus-4-8",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(dockerfile).toContain(
      "RUN NEMOCLAW_CUSTOM_CONFIG_PATH=/sandbox/.openclaw/openclaw.json \\",
    );
    expect(dockerfile.trimEnd().endsWith("USER sandbox")).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.agents.defaults.model.primary).toBe(
      "inference/aws/anthropic/bedrock-claude-opus-4-8",
    );
    expect(config.models.providers.inference.models[0]).toEqual({
      id: "aws/anthropic/bedrock-claude-opus-4-8",
      name: "inference/aws/anthropic/bedrock-claude-opus-4-8",
    });
    const digest = createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
    expect(fs.readFileSync(path.join(path.dirname(configPath), ".config-hash"), "utf8")).toBe(
      `${digest}  openclaw.json\n`,
    );
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o660);
  });

  it("keeps each explicit limit independent of inherited limits (#12033)", () => {
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", "200000");
    const { configPath, dockerfilePath } = fixture();
    const { result } = patchAndRun(dockerfilePath, configPath, "selected-model");

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.inference.models[0],
    ).toEqual({
      id: "selected-model",
      name: "inference/selected-model",
      contextWindow: 200_000,
    });
  });

  it("preserves inherited limits when the selected model already matches (#12033)", () => {
    const { configPath, dockerfilePath } = fixture();
    const { result } = patchAndRun(dockerfilePath, configPath, "baked-model");

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.inference.models[0],
    ).toEqual({
      id: "baked-model",
      name: "inference/baked-model",
      contextWindow: 131_072,
      maxTokens: 4096,
    });
  });

  it("reconciles a selected model entry without changing its siblings (#12033)", () => {
    const { configPath, dockerfilePath } = fixture();
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.models.providers.inference.models.push({
      id: "selected-model",
      name: "inference/selected-model",
      contextWindow: 65_536,
      maxTokens: 2048,
    });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { result } = patchAndRun(dockerfilePath, configPath, "selected-model");

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.inference.models,
    ).toEqual([
      {
        id: "baked-model",
        name: "inference/baked-model",
        contextWindow: 131_072,
        maxTokens: 4096,
      },
      {
        id: "selected-model",
        name: "inference/selected-model",
      },
    ]);
  });

  it("appends a selected model when a multi-model config does not contain it (#12033)", () => {
    const { configPath, dockerfilePath } = fixture();
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.models.providers.inference.models.push({
      id: "other-model",
      name: "inference/other-model",
      contextWindow: 32_768,
      maxTokens: 1024,
    });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { result } = patchAndRun(dockerfilePath, configPath, "selected-model");

    expect(result.status, result.stderr).toBe(0);
    const models = JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.inference
      .models;
    expect(models.slice(0, 2)).toEqual(config.models.providers.inference.models);
    expect(models[2]).toEqual({
      id: "selected-model",
      name: "inference/selected-model",
    });
  });

  it("keeps an inherited image user when the Dockerfile has no USER instruction (#12033)", () => {
    const { configPath, dockerfilePath } = fixture("FROM example.invalid/openclaw\n");
    const { dockerfile, result } = patchAndRun(dockerfilePath, configPath, "selected-model");

    expect(result.status, result.stderr).toBe(0);
    expect(dockerfile).not.toContain("\nUSER root\n");
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.inference.models[0].id,
    ).toBe("selected-model");
  });

  it("rejects an inherited image without an OpenClaw config (#12033)", () => {
    const { configPath, dockerfilePath } = fixture();
    fs.unlinkSync(configPath);
    const { result } = patchAndRun(dockerfilePath, configPath, "selected-model");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `custom OpenClaw model reconciliation requires ${configPath} in the inherited image`,
    );
  });

  it("rejects a Dockerfile that ends as root (#12033)", () => {
    const { dockerfilePath } = fixture("FROM example.invalid/openclaw\nUSER root\n");

    expect(() =>
      patchStagedDockerfile(
        dockerfilePath,
        "selected-model",
        "",
        "build-root",
        "custom",
        null,
        null,
        null,
        false,
        null,
        [],
        { agentName: "openclaw", reconcileCustomOpenClawModel: true },
      ),
    ).toThrow(/must end with a non-root USER/u);
  });
});
