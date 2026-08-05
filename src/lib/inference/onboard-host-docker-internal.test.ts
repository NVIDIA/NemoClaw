// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const { isHijackedDockerInternalUrl } = require("./onboard-host-docker-internal");
const {
  isSandboxInternalUrl,
  probeOpenAiLikeEndpoint,
  probeOpenAiLikeEndpointOptimized,
} = require("./onboard-probes");

describe("host.docker.internal onboarding inference policy", () => {
  it("does not treat host.docker.internal as a usable sandbox URL", () => {
    expect(isSandboxInternalUrl("http://host.docker.internal:11434/v1")).toBe(false);
    expect(isHijackedDockerInternalUrl("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isHijackedDockerInternalUrl("http://host.openshell.internal:11435/v1")).toBe(false);
    expect(isHijackedDockerInternalUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("rejects host.docker.internal URLs with an actionable proxy hint (#3136)", () => {
    const result = probeOpenAiLikeEndpoint(
      "http://host.docker.internal:11434/v1",
      "openai/nemotron-mini",
      "",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/host\.docker\.internal/);
    expect(result.message).toMatch(/host\.openshell\.internal:11435/);
    expect(result.failures).toEqual([
      expect.objectContaining({ name: "host.docker.internal reachability" }),
    ]);
  });

  it("rejects host.docker.internal even when strict chat-completions tool calling is required", () => {
    const result = probeOpenAiLikeEndpoint(
      "http://host.docker.internal:11434/v1",
      "openai/nemotron-mini",
      "",
      { skipResponsesProbe: true, requireChatCompletionsToolCalling: true },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/host\.docker\.internal/);
    expect(result.message).toMatch(/host\.openshell\.internal:11435/);
  });

  it("validates Windows-host Ollama from Docker for strict and compatibility paths (#8127)", async () => {
    const seenCommands: Array<{ command: string; args: readonly string[] }> = [];
    const containerProbeSpawnSyncImpl = (
      command: string,
      args: readonly string[],
    ): SpawnSyncReturns<string> => {
      seenCommands.push({ command, args });
      const outputIndex = args.indexOf("-o");
      const outputPath = args[outputIndex + 1];
      fs.writeFileSync(
        outputPath,
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "sessions_send", arguments: '{"message":"hello"}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      return {
        pid: 123,
        output: ["200", ""],
        stdout: "200",
        stderr: "",
        status: 0,
        signal: null,
      };
    };

    for (const requireChatCompletionsToolCalling of [true, false]) {
      const result = await probeOpenAiLikeEndpointOptimized(
        "http://host.docker.internal:11434/v1",
        "openai/nemotron-mini",
        "",
        {
          skipResponsesProbe: true,
          requireChatCompletionsToolCalling,
          allowHostDockerInternal: true,
          probeFromDocker: { expectedPort: 11434, spawnSyncImpl: containerProbeSpawnSyncImpl },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        label: "Chat Completions API",
      });
    }
    expect(seenCommands).toHaveLength(2);
    for (const { command, args } of seenCommands) {
      expect(command).toBe("docker");
      expect(args).toContain("curlimages/curl:8.10.1");
      expect(args).toContain("http://host.docker.internal:11434/v1/chat/completions");
    }
  });

  it.each([
    {
      endpointUrl: "http://host.docker.internal:11434/v1",
      apiKey: "not-a-real-secret",
      extraHeaders: undefined,
    },
    {
      endpointUrl: "http://host.docker.internal:11434/v1?debug=1",
      apiKey: "",
      extraHeaders: undefined,
    },
    {
      endpointUrl: "http://host.docker.internal:11434/v1",
      apiKey: "",
      extraHeaders: ["Authorization: Bearer not-a-real-secret"],
    },
  ])("refuses credentials and non-canonical Windows-host Ollama routes in Docker-context validation (#8127)", ({
    endpointUrl,
    apiKey,
    extraHeaders,
  }) => {
    const result = probeOpenAiLikeEndpoint(endpointUrl, "openai/nemotron-mini", apiKey, {
      skipResponsesProbe: true,
      requireChatCompletionsToolCalling: true,
      allowHostDockerInternal: true,
      probeFromDocker: { expectedPort: 11434 },
      extraHeaders,
    });

    expect(result).toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ name: "Docker-context validation boundary" })],
    });
  });
});
