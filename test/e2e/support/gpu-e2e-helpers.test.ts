// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { env, openClawModelConfigProjectionScript } from "../live/gpu-e2e-helpers.ts";

describe("GPU E2E helpers", () => {
  it("forwards the workflow-owned Ollama model pull timeout", () => {
    expect(env({}, { NEMOCLAW_OLLAMA_PULL_TIMEOUT: "2400" }).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe(
      "2400",
    );
  });

  it("does not synthesize an Ollama model pull timeout outside workflow configuration", () => {
    expect(env({}, {}).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBeUndefined();
  });

  it("uses the release-supported small GPU model by default", () => {
    expect(env({}, {}).NEMOCLAW_MODEL).toBe("qwen3.5:9b");
  });

  it("honors the workflow-owned GPU model", () => {
    expect(env({}, { NEMOCLAW_MODEL: "workflow/model" }).NEMOCLAW_MODEL).toBe("workflow/model");
  });

  it("forwards the workflow-owned trace directory through availability probes", () => {
    expect(env({}, { NEMOCLAW_TRACE_DIR: "/tmp/nemoclaw-traces" }).NEMOCLAW_TRACE_DIR).toBe(
      "/tmp/nemoclaw-traces",
    );
  });

  it("projects only model evidence before OpenClaw config crosses the artifact boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-gpu-config-"));
    try {
      const configPath = path.join(root, "openclaw.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: { defaults: { model: { primary: "inference/model" } } },
          models: { providers: {} },
          gateway: { auth: { token: "generated-gateway-secret" } },
        }),
      );

      const stdout = execFileSync(
        "bash",
        ["-lc", openClawModelConfigProjectionScript(configPath)],
        { encoding: "utf8" },
      );

      expect(JSON.parse(stdout)).toEqual({
        agents: { defaults: { model: { primary: "inference/model" } } },
        models: { providers: {} },
      });
      expect(stdout).not.toContain("generated-gateway-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
