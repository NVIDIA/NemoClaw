// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import { patchStagedDockerfile } from "../../../dist/lib/onboard/dockerfile-patch";

const BASE_DOCKERFILE = [
  "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
  "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
  "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
  "ARG CHAT_UI_URL=http://127.0.0.1:18789",
  "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
  "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
  "ARG NEMOCLAW_BUILD_ID=default",
  "ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=W10=",
].join("\n");

const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-extra-agents-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function extraAgentsArg(dockerfilePath: string): string | undefined {
  return fs
    .readFileSync(dockerfilePath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64="))
    ?.split("=")[1];
}

function withExtraAgentsEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
  if (value === undefined) {
    delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
  } else {
    process.env.NEMOCLAW_EXTRA_AGENTS_JSON = value;
  }
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.NEMOCLAW_EXTRA_AGENTS_JSON;
    } else {
      process.env.NEMOCLAW_EXTRA_AGENTS_JSON = prior;
    }
  }
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("patchStagedDockerfile :: NEMOCLAW_EXTRA_AGENTS_JSON", () => {
  it("encodes a valid JSON payload into the staged Dockerfile ARG", () => {
    const dockerfilePath = dockerfileWith(BASE_DOCKERFILE);
    const extras = [
      {
        id: "research",
        workspace: "/sandbox/.openclaw/workspace-research",
        agentDir: "/sandbox/.openclaw/agents/research",
        tools: { profile: "minimal", allow: ["read"], deny: ["exec"] },
        subagents: { maxSpawnDepth: 0 },
      },
    ];
    withExtraAgentsEnv(JSON.stringify(extras), () =>
      patchStagedDockerfile(
        dockerfilePath,
        "gpt-5.4",
        "http://127.0.0.1:18789",
        "build-extra-agents",
        "openai-api",
      ),
    );
    const encoded = extraAgentsArg(dockerfilePath);
    assert.ok(encoded, "expected extra agents build arg");
    assert.notEqual(encoded, "W10=", "expected default to be rewritten");
    assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), extras);
  });

  it("leaves the empty default when NEMOCLAW_EXTRA_AGENTS_JSON is unset or whitespace-only", () => {
    for (const [index, value] of ([undefined, "", "   "] as Array<string | undefined>).entries()) {
      const dockerfilePath = dockerfileWith(BASE_DOCKERFILE);
      withExtraAgentsEnv(value, () =>
        patchStagedDockerfile(
          dockerfilePath,
          "gpt-5.4",
          "http://127.0.0.1:18789",
          `build-extra-agents-empty-${index}`,
          "openai-api",
        ),
      );
      assert.match(
        fs.readFileSync(dockerfilePath, "utf8"),
        /^ARG NEMOCLAW_EXTRA_AGENTS_JSON_B64=W10=$/m,
        `value="${String(value)}" should leave the empty default untouched`,
      );
    }
  });

  it("passes a malformed payload through to the build-time validator", () => {
    // Host-side does not parse or shape-check; otherwise a malformed payload
    // would be silently dropped while docs promise an image-build failure.
    // The build-time validator in scripts/generate-openclaw-config.mts is the
    // single source of truth for structured validation errors.
    const cases = ["not-json", '{"id":"research"}', '[{"id":"main"}]'];
    for (const [index, value] of cases.entries()) {
      const dockerfilePath = dockerfileWith(BASE_DOCKERFILE);
      withExtraAgentsEnv(value, () =>
        patchStagedDockerfile(
          dockerfilePath,
          "gpt-5.4",
          "http://127.0.0.1:18789",
          `build-extra-agents-passthrough-${index}`,
          "openai-api",
        ),
      );
      const encoded = extraAgentsArg(dockerfilePath);
      assert.ok(encoded, "expected extra agents build arg");
      assert.notEqual(
        encoded,
        "W10=",
        `value="${value}" should be encoded into the ARG so the build validator can reject it`,
      );
      assert.equal(
        Buffer.from(encoded, "base64").toString("utf8"),
        value,
        `value="${value}" must round-trip through base64 unchanged`,
      );
    }
  });
});
