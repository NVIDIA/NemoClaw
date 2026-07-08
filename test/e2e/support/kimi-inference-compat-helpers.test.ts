// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertKimiTrajectorySummary,
  buildKimiTrajectoryCheckScript,
  env,
  kimiAgentEnv,
  kimiOnboardEnv,
  requirePublicNvidiaApiKey,
  resolveKimiInferenceMode,
  startKimiMock,
} from "../live/kimi-inference-compat-helpers.ts";

describe("Kimi inference compatibility mode selection", () => {
  it("defaults to hermetic mock mode for local validation", () => {
    const cfg = env({}, { mode: "mock" });
    expect(cfg.NEMOCLAW_E2E_INFERENCE_MODE).toBe("mock");
    expect(cfg.NEMOCLAW_PROVIDER).toBe("custom");
    expect(cfg.COMPATIBLE_API_KEY).toBe("test-kimi-key");
    expect(cfg.NVIDIA_API_KEY).toBeUndefined();
  });

  it("keeps public NVIDIA probe envs secret-free by default", () => {
    const cfg = env({}, { mode: "public-nvidia", apiKey: "nvapi-public-test-key" });
    expect(cfg.NEMOCLAW_E2E_INFERENCE_MODE).toBe("public-nvidia");
    expect(cfg.NEMOCLAW_PROVIDER).toBe("cloud");
    expect(cfg.NVIDIA_API_KEY).toBeUndefined();
    expect(cfg.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(cfg.COMPATIBLE_API_KEY).toBeUndefined();
  });

  it("limits the public NVIDIA source secret to onboard envs only", () => {
    const cfg = env(
      {},
      {
        mode: "public-nvidia",
        apiKey: "nvapi-public-test-key",
        includeSecret: true,
      },
    );
    expect(cfg.NVIDIA_API_KEY).toBe("nvapi-public-test-key");
    expect(cfg.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(kimiOnboardEnv(undefined, "public-nvidia", "nvapi-public-test-key").NVIDIA_API_KEY).toBe(
      "nvapi-public-test-key",
    );
    const agentCfg = kimiAgentEnv("public-nvidia");
    expect(agentCfg.NVIDIA_API_KEY).toBeUndefined();
    expect(agentCfg.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  });

  it("rejects non-public NVIDIA keys for public Kimi validation", () => {
    expect(() => requirePublicNvidiaApiKey("sk-compatible-key")).toThrow(/nvapi-\* key/);
    expect(requirePublicNvidiaApiKey("nvapi-public-test-key")).toBe("nvapi-public-test-key");
  });

  it("maps canonical explicit env selectors to the expected mode", () => {
    expect(resolveKimiInferenceMode({ NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" })).toBe(
      "public-nvidia",
    );
    expect(
      resolveKimiInferenceMode({
        NEMOCLAW_E2E_INFERENCE_MODE: "mock",
        NEMOCLAW_KIMI_USE_MOCK: "0",
      }),
    ).toBe("mock");
  });

  it("rejects unknown explicit modes instead of silently falling back to mock", () => {
    expect(() => resolveKimiInferenceMode({ NEMOCLAW_E2E_INFERENCE_MODE: "public-nvida" })).toThrow(
      /must be one of: mock, public-nvidia/,
    );
  });

  it("ignores the retired shell-lane NEMOCLAW_KIMI_USE_MOCK alias", () => {
    expect(resolveKimiInferenceMode({ NEMOCLAW_KIMI_USE_MOCK: "0" })).toBe("mock");
  });

  it("keeps mock Kimi trajectory checks strict for split hostname/date/uptime calls", () => {
    const script = buildKimiTrajectoryCheckScript(true);
    expect(script).toContain("strict_mock = True");
    expect(script).toContain("tool command set");
    expect(script).toContain("source commands");
    expect(script).toContain("final text mismatch");

    assertKimiTrajectorySummary({
      errors: [],
      finalStatus: "success",
      finalTextCount: 1,
      roles: ["assistant", "toolResult", "assistant"],
      sourceCommands: ["hostname", "date", "uptime"],
      strictMockExpectations: true,
      toolMetaCommandSet: ["date", "hostname", "uptime"],
      toolMetaInvalidValues: [],
      toolMetasCount: 3,
    });
  });

  it("emits separate safe exec calls from the streaming Kimi mock", async () => {
    const mock = await startKimiMock();
    try {
      const endpoint = new URL(`${mock.baseUrl}/chat/completions`);
      endpoint.hostname = "127.0.0.1";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer test-kimi-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "moonshotai/kimi-k2.6",
          stream: true,
          messages: [{ role: "user", content: "Run the checks" }],
          tools: [{ type: "function", function: { name: "exec" } }],
        }),
      });

      expect(response.ok).toBe(true);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice("data: ".length)));
      const toolCalls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
      expect(toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 1, 2]);
      expect(toolCalls.every((toolCall) => toolCall.type === "function")).toBe(true);
      expect(toolCalls.every((toolCall) => toolCall.function.name === "exec")).toBe(true);
      expect(toolCalls.map((toolCall) => JSON.parse(toolCall.function.arguments).command)).toEqual([
        "hostname",
        "date",
        "uptime",
      ]);
      expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(3);
      expect(events.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
    } finally {
      await mock.close();
    }
  });

  it("allows public Kimi trajectories with fewer safe exec calls but no combined shell", () => {
    const script = buildKimiTrajectoryCheckScript(false);
    expect(script).toContain("strict_mock = False");
    expect(script).toContain("min_metas = 3 if strict_mock else 1");
    expect(script).toContain("unsafe source command remains");

    assertKimiTrajectorySummary({
      errors: [],
      finalStatus: "success",
      finalTextCount: 1,
      roles: ["assistant", "toolResult", "assistant"],
      sourceCommands: ["hostname"],
      strictMockExpectations: false,
      toolMetaCommandSet: ["hostname"],
      toolMetaInvalidValues: [null],
      toolMetasCount: 1,
    });
  });

  it("rejects unsafe or malformed source commands in both mock and public trajectory summaries", () => {
    for (const sourceCommands of [
      ["hostname; date; uptime"],
      ["hostname | date"],
      ["hostname $(date)"],
      ["hostname `date`"],
      ["hostname > /tmp/out"],
      ["cat < /etc/passwd"],
      ["whoami"],
      [null],
    ]) {
      expect(() =>
        assertKimiTrajectorySummary({
          errors: [],
          finalStatus: "success",
          finalTextCount: 1,
          roles: ["assistant", "toolResult", "assistant"],
          sourceCommands,
          strictMockExpectations: false,
          toolMetaCommandSet: ["hostname"],
          toolMetaInvalidValues: [],
          toolMetasCount: 1,
        }),
      ).toThrow();
    }
  });
});
