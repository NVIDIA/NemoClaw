// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";
import {
  LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX,
  parseLlamaCppDgxSparkExecutionPlan,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";
import { runLlamaCppOpenClawAgentQualification } from "../../../scripts/checks/llama-cpp-openclaw-agent-qualification.mts";
import type { ManagedImageOpenShellE2eProbeContext } from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";

function enabledConfig() {
  const output = loadLlamaCppImageConfig();
  const plan = parseLlamaCppDgxSparkExecutionPlan(
    JSON.parse(output.publication_qualification_plan) as unknown,
  );
  return {
    ...plan.qualification.agentQualification,
    execution: "enabled" as const,
  };
}

function context(
  outputs: readonly { status: number; stdout: string; stderr?: string }[],
  invocations: string[][],
  localProvider: "llama-cpp" | "vllm" = "llama-cpp",
): ManagedImageOpenShellE2eProbeContext {
  let index = 0;
  return {
    input: {
      agent: "openclaw",
      image: enabledConfig().image.reference,
      localProvider,
      model: "nvidia-nemotron-3-nano-30b-a3b",
      sandbox: LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX,
    },
    runSandbox(argv) {
      invocations.push([...argv]);
      const output = outputs[index++] ?? {
        status: 1,
        stderr: "unexpected qualification invocation",
        stdout: "",
      };
      return {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr ?? "",
      };
    },
  };
}

describe("llama.cpp OpenClaw qualification probe", () => {
  it("executes every YAML-authored probe and emits only bounded structural evidence", async () => {
    const invocations: string[][] = [];
    const evidence = await runLlamaCppOpenClawAgentQualification(
      enabledConfig(),
      context(
        [
          { status: 0, stdout: '{"ok":true}' },
          { status: 0, stdout: '{"done":true,"events":7}' },
          { status: 0, stdout: '{"payloads":[{"text":"PONG"}]}' },
          { status: 0, stdout: "" },
          {
            status: 0,
            stdout: '{"payloads":[{"text":"LLAMA_CPP_OPENCLAW_TOOL_OK"}]}',
          },
          {
            status: 0,
            stdout: '{"payloads":[{"text":"LLAMA_CPP_OPENCLAW_TOOL_OK"}]}',
          },
          { status: 0, stdout: '{"calls":1,"results":1,"users":2}' },
        ],
        invocations,
      ),
    );

    expect(evidence).toEqual({
      agentMultiTurn: true,
      agentNormalTurn: true,
      agentToolCall: { argumentsValid: true, name: "read" },
      agentToolResultContinuation: true,
      streamingChat: { done: true, events: 7 },
      synchronousChat: true,
    });
    expect(invocations).toHaveLength(7);
    expect(invocations[0]).toContain("https://inference.local/v1/chat/completions");
    expect(invocations[2]).toContain("llama-cpp-openclaw-normal");
    expect(invocations[4]).toContain("llama-cpp-openclaw-tool");
    expect(invocations[5]).toContain("llama-cpp-openclaw-tool");
    expect(invocations[6]).toContain(
      "/sandbox/.openclaw/agents/main/sessions/llama-cpp-openclaw-tool.jsonl",
    );
    expect(JSON.stringify(evidence)).not.toContain("LLAMA_CPP_OPENCLAW_TOOL_OK");
  });

  it("fails closed on unplanned runtime selection or failed probe evidence", async () => {
    const config = enabledConfig();
    const invocations: string[][] = [];
    const wrongRuntime = context([], invocations, "vllm");
    await expect(runLlamaCppOpenClawAgentQualification(config, wrongRuntime)).rejects.toThrow(
      /does not match its declarative plan/u,
    );

    await expect(
      runLlamaCppOpenClawAgentQualification(
        config,
        context([{ status: 1, stdout: "", stderr: "TOKEN=do-not-log" }], invocations),
      ),
    ).rejects.toThrow(/^inference[.]local synchronous probe failed with status 1$/u);
  });
});
