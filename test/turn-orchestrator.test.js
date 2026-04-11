// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TurnOrchestrationError,
  acquireLock,
  buildOpenClawAgentCommand,
  createHostRuntime,
  deriveRouteModel,
  orchestrateTurns,
  releaseLock,
  renderTurnMessage,
  validatePlan,
} = require("../scripts/lib/turn-orchestrator");

describe("turn orchestrator helpers", () => {
  it("derives the route model from inference-qualified models", () => {
    expect(deriveRouteModel({ agent: "jophiel", model: "inference/phi4-mini:latest" })).toBe(
      "phi4-mini:latest",
    );
  });

  it("requires routeModel for non-inference qualified models", () => {
    expect(() =>
      deriveRouteModel({ agent: "main", model: "nvidia/nemotron-3-super-120b-a12b" }),
    ).toThrow(/cannot be mapped/);
  });

  it("renders transcript context into later prompts", () => {
    const plan = validatePlan({
      sandbox: "the-crucible",
      task: "Review the feature.",
      turns: [
        {
          agent: "jophiel",
          model: "inference/glm-4.6v-flash-9b",
          instructions: "Produce critique.",
        },
      ],
    });

    const message = renderTurnMessage(
      plan,
      {
        agent: "gabriel",
        model: "inference/phi4-mini:latest",
        instructions: "Audit the transcript.",
      },
      [
        {
          agent: "jophiel",
          index: 1,
          model: "inference/glm-4.6v-flash-9b",
          prompt: "Prompt one",
          responseText: "First answer",
        },
      ],
    );

    expect(message).toContain("Prior turn transcript:");
    expect(message).toContain("Turn 1: jophiel");
    expect(message).toContain("First answer");
    expect(message).toContain("Audit the transcript.");
  });

  it("acquires and releases a stale sandbox lock", () => {
    const lockPath = path.join(
      os.tmpdir(),
      `turn-orchestrator-test-${process.pid}-${Date.now()}.lock`,
    );
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999 }));

    const lock = acquireLock(lockPath);
    expect(lock.replacedStaleLock).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseLock(lock);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("passes --no-verify when route verification is disabled", () => {
    const calls = [];
    const runtime = createHostRuntime({
      openshellPath: "/usr/bin/openshell",
      skipRouteVerification: true,
      spawnSyncImpl: (command, args) => {
        calls.push({ command, args });
        return { error: null, status: 0, stderr: "", stdout: "" };
      },
    });

    runtime.setRoute("ollama-local", "phi4-mini:latest");

    expect(calls).toEqual([
      {
        command: "/usr/bin/openshell",
        args: [
          "inference",
          "set",
          "--no-verify",
          "--provider",
          "ollama-local",
          "--model",
          "phi4-mini:latest",
        ],
      },
    ]);
  });

  it("includes --agent when targeting the main agent", () => {
    expect(
      buildOpenClawAgentCommand({
        agent: "main",
        message: "Reply with exactly OK",
        sessionId: "session-main",
        timeoutSeconds: 120,
      }),
    ).toBe(
      "openclaw agent --agent 'main' --local --timeout 120 --session-id 'session-main' --json -m 'Reply with exactly OK'",
    );
  });

  it("includes --agent for named sub-agents", () => {
    expect(
      buildOpenClawAgentCommand({
        agent: "jophiel",
        message: "Reply with exactly OK",
        sessionId: "session-jophiel",
        timeoutSeconds: 120,
      }),
    ).toBe(
      "openclaw agent --agent 'jophiel' --local --timeout 120 --session-id 'session-jophiel' --json -m 'Reply with exactly OK'",
    );
  });
});

describe("orchestrateTurns", () => {
  it("switches routes per turn and restores the original route", async () => {
    const routeCalls = [];
    const prompts = [];
    const plan = {
      sandbox: "the-crucible",
      provider: "ollama-local",
      task: "Prepare a final answer.",
      turns: [
        { agent: "jophiel", model: "inference/glm-4.6v-flash-9b", instructions: "Ideate." },
        {
          agent: "gabriel",
          model: "inference/phi4-mini:latest",
          instructions: "Audit the previous answer.",
        },
      ],
    };

    const result = await orchestrateTurns(plan, {
      createSessionId: (turn, index) => `session-${index + 1}-${turn.agent}`,
      lockPath: path.join(os.tmpdir(), `turn-orchestrator-${process.pid}-${Date.now()}.lock`),
      runtime: {
        getCurrentRoute: () => ({ model: "qwen2.5-coder:7b-64k", provider: "ollama-local" }),
        runAgentTurn: ({ agent, message }) => {
          prompts.push({ agent, message });
          return {
            parsed: { payloads: [{ text: `${agent.toUpperCase()}_OK` }] },
            responseText: `${agent.toUpperCase()}_OK`,
          };
        },
        setRoute: (provider, model) => {
          routeCalls.push({ provider, model });
        },
      },
    });

    expect(routeCalls).toEqual([
      { provider: "ollama-local", model: "glm-4.6v-flash-9b" },
      { provider: "ollama-local", model: "phi4-mini:latest" },
      { provider: "ollama-local", model: "qwen2.5-coder:7b-64k" },
    ]);
    expect(prompts[1].message).toContain("JOPHIEL_OK");
    expect(result.restoredRoute).toEqual({
      model: "qwen2.5-coder:7b-64k",
      provider: "ollama-local",
    });
  });

  it("preserves a partial report when a later turn fails", async () => {
    const plan = {
      sandbox: "the-crucible",
      provider: "ollama-local",
      task: "Produce a consensus answer.",
      turns: [
        { agent: "jophiel", model: "inference/glm-4.6v-flash-9b", instructions: "Draft." },
        { agent: "gabriel", model: "inference/phi4-mini:latest", instructions: "Audit." },
      ],
    };

    await expect(
      orchestrateTurns(plan, {
        lockPath: path.join(
          os.tmpdir(),
          `turn-orchestrator-${process.pid}-${Date.now()}-fail.lock`,
        ),
        runtime: {
          getCurrentRoute: () => ({ model: "qwen2.5-coder:7b-64k", provider: "ollama-local" }),
          runAgentTurn: ({ agent }) => {
            if (agent === "gabriel") {
              throw new Error("agent timeout");
            }
            return {
              parsed: { payloads: [{ text: "JOPHIEL_OK" }] },
              responseText: "JOPHIEL_OK",
            };
          },
          setRoute: () => {},
        },
      }),
    ).rejects.toMatchObject({
      name: TurnOrchestrationError.name,
      result: {
        error: { message: "agent timeout" },
        turns: [expect.objectContaining({ agent: "jophiel", responseText: "JOPHIEL_OK" })],
      },
    });
  });
});
