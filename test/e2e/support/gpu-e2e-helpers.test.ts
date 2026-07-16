// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAgentExecutionSucceeded,
  env,
  hasExactReadyPhase,
  openClawModelConfigProjectionScript,
} from "../live/gpu-e2e-helpers.ts";

const GPU_MODEL = "qwen3.5:9b";

interface AgentOutputOverrides {
  status?: string;
  summary?: string;
  aborted?: boolean;
  provider?: string;
  model?: string;
  winnerProvider?: string;
  winnerModel?: string;
  attemptProvider?: string;
  attemptModel?: string;
  attemptStage?: string;
  attemptResult?: "success" | "error";
}

function agentOutput({
  status = "ok",
  summary = "completed",
  aborted = false,
  provider = "inference",
  model = GPU_MODEL,
  winnerProvider = "inference",
  winnerModel = GPU_MODEL,
  attemptProvider = provider,
  attemptModel = model,
  attemptStage = "assistant",
  attemptResult = "success",
}: AgentOutputOverrides = {}): string {
  return JSON.stringify({
    status,
    summary,
    result: {
      payloads: [],
      meta: {
        aborted,
        agentMeta: { provider, model },
        finalAssistantVisibleText: "NO_REPLY",
        executionTrace: {
          winnerProvider,
          winnerModel,
          attempts: [
            {
              provider: attemptProvider,
              model: attemptModel,
              result: attemptResult,
              stage: attemptStage,
            },
          ],
        },
      },
    },
  });
}

const invalidExecutionProofs: Array<{
  name: string;
  overrides: AgentOutputOverrides;
  message: string;
}> = [
  { name: "status", overrides: { status: "error" }, message: "agent command must report success" },
  { name: "summary", overrides: { summary: "failed" }, message: "agent command must complete" },
  { name: "abort state", overrides: { aborted: true }, message: "agent command must not abort" },
  {
    name: "provider",
    overrides: { provider: "unexpected" },
    message: "agent must use the expected provider",
  },
  {
    name: "model",
    overrides: { model: "unexpected" },
    message: "agent must use the expected model",
  },
  {
    name: "winner provider",
    overrides: { winnerProvider: "unexpected" },
    message: "execution trace must select the expected provider",
  },
  {
    name: "winner model",
    overrides: { winnerModel: "unexpected" },
    message: "execution trace must select the expected model",
  },
  {
    name: "attempt provider",
    overrides: { attemptProvider: "unexpected" },
    message: "execution trace must contain a successful assistant attempt",
  },
  {
    name: "attempt model",
    overrides: { attemptModel: "unexpected" },
    message: "execution trace must contain a successful assistant attempt",
  },
  {
    name: "attempt stage",
    overrides: { attemptStage: "tool" },
    message: "execution trace must contain a successful assistant attempt",
  },
];

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

  it("accepts an ANSI-colored exact Ready sandbox phase", () => {
    expect(hasExactReadyPhase("Sandbox:\n  \u001b[2mPhase:\u001b[0m Ready\n")).toBe(true);
  });

  it("rejects an ANSI-colored non-Ready sandbox phase", () => {
    expect(hasExactReadyPhase("Sandbox:\n  \u001b[2mPhase:\u001b[0m Error\n")).toBe(false);
  });

  it.each([
    ["Error before Ready", "Phase: Error\nPhase: Ready\n"],
    ["Ready before Error", "Phase: Ready\nPhase: Error\n"],
    ["prefixed Ready", "Current Phase: Ready\n"],
    ["suffixed Ready", "Phase: Ready (stale)\n"],
  ])("rejects %s output", (_case, output) => {
    expect(hasExactReadyPhase(output)).toBe(false);
  });

  it("accepts successful execution proof when the model suppresses visible text", () => {
    expect(() =>
      assertAgentExecutionSucceeded(agentOutput(), "inference", GPU_MODEL),
    ).not.toThrow();
  });

  it("rejects a recovery trace without a successful assistant attempt", () => {
    expect(() =>
      assertAgentExecutionSucceeded(
        agentOutput({ attemptResult: "error" }),
        "inference",
        GPU_MODEL,
      ),
    ).toThrow("execution trace must contain a successful assistant attempt");
  });

  it.each(invalidExecutionProofs)("rejects invalid $name execution proof", ({
    overrides,
    message,
  }) => {
    expect(() =>
      assertAgentExecutionSucceeded(agentOutput(overrides), "inference", GPU_MODEL),
    ).toThrow(message);
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
