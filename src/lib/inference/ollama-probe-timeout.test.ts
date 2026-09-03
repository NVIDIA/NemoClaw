// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_LOCALHOST,
  setResolvedOllamaHost,
  validateOllamaModel,
} from "./local";

afterEach(() => {
  setResolvedOllamaHost(OLLAMA_LOCALHOST);
});

describe("Ollama probe timeout retry", () => {
  it("retries with extended timeout on non-Spark hosts when first probe times out", () => {
    const commands: string[] = [];
    let captureExCallCount = 0;
    const captureEx = (cmd: string[]) => {
      captureExCallCount++;
      commands.push(cmd.join(" "));
      if (captureExCallCount === 1) return { stdout: "", exitCode: 28, timedOut: true };
      return { stdout: JSON.stringify({ response: "Hi" }), exitCode: 0, timedOut: false };
    };

    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      captureEx,
    );

    expect(result.ok).toBe(true);
    expect(captureExCallCount).toBe(2);
    expect(commands[1]).toMatch(/--max-time.*300|300.*--max-time/);
  });

  it("prints stale-runner recovery when both bounded probes time out", () => {
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      () => ({ stdout: "", exitCode: 28, timedOut: true }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("Stale runner processes from a previous model");
    expect(result.message).toContain("sudo systemctl restart ollama");
  });

  it("reports a fast retry failure from the final probe result", () => {
    let callCount = 0;
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      () => {
        callCount += 1;
        return callCount === 1
          ? { stdout: "", exitCode: 28, timedOut: true }
          : { stdout: "", exitCode: 7, timedOut: false };
      },
    );

    expect(result.message).toContain("failed the local probe without a response");
    expect(result.message).not.toContain("Stale runner processes");
  });

});
