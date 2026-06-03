// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchStagedDockerfile } from "../dist/lib/onboard/dockerfile-patch";
import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-config-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function readDockerArgs(dockerfilePath: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of fs.readFileSync(dockerfilePath, "utf-8").split("\n")) {
    const match = line.match(/^ARG ([A-Z0-9_]+)=(.*)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

function decodeCompat(args: Record<string, string>): Record<string, unknown> {
  const compatB64 = args.NEMOCLAW_INFERENCE_COMPAT_B64;
  assert.ok(compatB64, "expected NEMOCLAW_INFERENCE_COMPAT_B64 to be patched");
  return JSON.parse(Buffer.from(compatB64, "base64").toString("utf-8"));
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ollama-local OpenClaw config propagation", () => {
  it("propagates streaming usage compat through the managed inference route", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:0.5b",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    expect(dockerArgs).toMatchObject({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(decodeCompat(dockerArgs)).toEqual({ supportsUsageInStreaming: true });

    const config = buildConfig({
      ...dockerArgs,
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_AGENT_TIMEOUT: "600",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "qwen2.5:0.5b",
      name: "inference/qwen2.5:0.5b",
      compat: { supportsUsageInStreaming: true },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/qwen2.5:0.5b");
  });
});
